'use strict';

/**
 * server.js
 * -----------------------------------------------------------------------------
 * Express API for the Regional Health admissions & patient-lookup service.
 *
 * Endpoints:
 *   GET  /api/patients/recent        Recent patients widget
 *   GET  /api/patients/search        Patient lookup by last name
 *   POST /api/hospitals/:id/admit    Admit a patient (decrement bed count)
 *   GET  /api/patients/export        Full patient export for the analytics team
 *   GET  /api/audit/ping             Mongo audit-store health probe
 *   GET  /metrics                    Prometheus metrics
 */

const express = require('express');
const client = require('prom-client');
const { getPool, getMongo } = require('./database');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const register = new client.Registry();
register.setDefaultLabels({ app: 'capacity-api' });

// Default process/GC/heap metrics.
client.collectDefaultMetrics({ register, gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5] });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const dbErrorsTotal = new client.Counter({
  name: 'db_errors_total',
  help: 'Total number of database errors by type',
  labelNames: ['route', 'code'],
  registers: [register],
});

function sendDbError(res, route, err) {
  const isQueueLimit = err.message === 'Queue limit reached.';
  const code = err.code || (isQueueLimit ? 'POOL_QUEUE_LIMIT' : 'UNKNOWN');
  dbErrorsTotal.inc({ route, code });
  res.status(isQueueLimit ? 503 : 500).json({ error: code, message: err.message });
}

// Bound how many requests the process will work on at once. Without this,
// a sudden spike (2000 concurrent VUs) gets accepted unconditionally and
// piles up behind the DB pool's queue, which in turn saturates the process's
// connection-accept path and produces raw TCP-level stalls upstream (k6 sees
// "dial: i/o timeout" rather than a clean HTTP error). Rejecting fast once
// we're at capacity keeps accept() free and turns a collapse into a
// visible, bounded rate of 503s.
const MAX_INFLIGHT_REQUESTS = Number(process.env.MAX_INFLIGHT_REQUESTS || 300);
let inFlightRequests = 0;
app.use((req, res, next) => {
  if (inFlightRequests >= MAX_INFLIGHT_REQUESTS) {
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'OVERLOADED', message: 'Too many in-flight requests' });
  }
  inFlightRequests += 1;
  res.on('finish', () => { inFlightRequests -= 1; });
  next();
});

// Per-request timing + counting middleware
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.baseUrl + req.route.path : req.path;
    const labels = { method: req.method, route, status_code: res.statusCode };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
});

// ---------------------------------------------------------------------------
// Health & metrics
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------------------------------------------------------------------------
// Recent patients widget
// ---------------------------------------------------------------------------
app.get('/api/patients/recent', async (_req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM patients ORDER BY id DESC LIMIT 50'
    );
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    sendDbError(res, '/api/patients/recent', err);
  }
});

// ---------------------------------------------------------------------------
// Patient lookup by last name
// ---------------------------------------------------------------------------
const SEARCH_RESULT_LIMIT = 50;

app.get('/api/patients/search', async (req, res) => {
  const lastName = req.query.lastName || '';
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM patients WHERE last_name = ? LIMIT ?',
      [lastName, SEARCH_RESULT_LIMIT]
    );
    res.json({ count: rows.length, truncated: rows.length === SEARCH_RESULT_LIMIT, lastName, data: rows });
  } catch (err) {
    sendDbError(res, '/api/patients/search', err);
  }
});

// ---------------------------------------------------------------------------
// Admit a patient to a hospital (decrement available beds).
// ---------------------------------------------------------------------------
const ADMIT_QUEUE_LIMIT = 50; // pending admits allowed per hospital before we shed load
const admitQueues = new Map(); // hospitalId -> { chain: Promise, depth: number }

function runAdmit(hospitalId) {
  return (async () => {
    const pool = getPool();
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      await conn.query(
        'UPDATE hospitals SET available_beds = available_beds - 1 WHERE id = ?',
        [hospitalId]
      );
      await conn.commit();
    } catch (err) {
      if (conn) {
        try { await conn.rollback(); } catch (_) { /* ignore */ }
      }
      throw err;
    } finally {
      if (conn) conn.release();
    }
  })();
}

app.post('/api/hospitals/:id/admit', async (req, res) => {
  const hospitalId = Number(req.params.id);
  const state = admitQueues.get(hospitalId) || { chain: Promise.resolve(), depth: 0 };

  if (state.depth >= ADMIT_QUEUE_LIMIT) {
    dbErrorsTotal.inc({ route: '/api/hospitals/:id/admit', code: 'HOSPITAL_QUEUE_LIMIT' });
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'HOSPITAL_QUEUE_LIMIT', message: `Too many pending admits for hospital ${hospitalId}` });
  }

  state.depth += 1;
  const current = state.chain.then(
    () => runAdmit(hospitalId),
    () => runAdmit(hospitalId) // previous admit's rejection shouldn't block this one
  );
  state.chain = current.catch(() => {});
  admitQueues.set(hospitalId, state);

  try {
    await current;
    res.json({ status: 'admitted', hospitalId });
    // Notify the external regional bed registry after the row lock is
    // already released — a slow/failed notify no longer blocks other admits.
    notifyBedRegistry(hospitalId).catch(() => { /* handled by registry retry, not modeled here */ });
  } catch (err) {
    sendDbError(res, '/api/hospitals/:id/admit', err);
  } finally {
    state.depth -= 1;
  }
});

// Stand-in for the external registry client used by the admit flow.
function notifyBedRegistry(_hospitalId) {
  return new Promise((r) => setTimeout(r, 500));
}

// ---------------------------------------------------------------------------
// Full patient export for the analytics/ETL team.
// ---------------------------------------------------------------------------
const EXPORT_BATCH_SIZE = 500;
const MAX_CONCURRENT_EXPORTS = 8;
let activeExports = 0;

function writeAsync(res, chunk) {
  return new Promise((resolve, reject) => {
    const ok = res.write(chunk, (err) => { if (err) reject(err); });
    if (ok) resolve();
    else res.once('drain', resolve);
  });
}

app.get('/api/patients/export', async (_req, res) => {
  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    dbErrorsTotal.inc({ route: '/api/patients/export', code: 'EXPORT_CONCURRENCY_LIMIT' });
    res.set('Retry-After', '2');
    return res.status(503).json({ error: 'EXPORT_CONCURRENCY_LIMIT', message: 'Too many concurrent exports in progress' });
  }
  activeExports += 1;

  const pool = getPool();
  let lastId = 0;
  let count = 0;
  try {
    res.setHeader('Content-Type', 'application/json');
    await writeAsync(res, '{"data":[');
    for (;;) {
      const [rows] = await pool.query(
        'SELECT * FROM patients WHERE id > ? ORDER BY id LIMIT ?',
        [lastId, EXPORT_BATCH_SIZE]
      );
      if (rows.length === 0) break;
      const chunk = rows.map((row) => JSON.stringify(row)).join(',');
      await writeAsync(res, (count === 0 ? '' : ',') + chunk);
      count += rows.length;
      lastId = rows[rows.length - 1].id;
      if (rows.length < EXPORT_BATCH_SIZE) break;
    }
    res.end(`],"count":${count}}`);
  } catch (err) {
    if (count === 0) {
      sendDbError(res, '/api/patients/export', err);
    } else {
      // Headers/body already streaming — can't switch to a JSON error
      // response mid-stream, so just cut the connection.
      dbErrorsTotal.inc({ route: '/api/patients/export', code: err.code || 'UNKNOWN' });
      res.end();
    }
  } finally {
    activeExports -= 1;
  }
});

// ---------------------------------------------------------------------------
// Mongo audit-store health probe
// ---------------------------------------------------------------------------
app.get('/api/audit/ping', async (_req, res) => {
  try {
    const db = await getMongo();
    const result = await db.command({ ping: 1 });
    res.json({ mongo: result });
  } catch (err) {
    res.status(500).json({ error: 'MONGO_ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`capacity-api listening on :${PORT} (metrics at /metrics)`);
});
