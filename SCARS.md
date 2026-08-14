# 🩹 Scar Log — Regional Health

One entry per incident. Full evidence, capacity math, and iteration history
live in [`LAB_JOURNAL.md`](./LAB_JOURNAL.md); raw k6/DB/log output lives in
[`evidence/`](./evidence). This file is the two-minute version for whoever's
on call at 2am.

## OPS-2201 — Patient search collapses under concurrency (not just a missing index)

- **S — Symptom:** Search by last name hangs/errors during shift change.
  Measured: `p(95)=55.12s`, RPS collapsed to `5.9 req/s` under 200 concurrent
  searches (baseline: `p(95)=18.79ms`, `48.9 req/s`).
- **C — Cause:** Three stacked mechanisms — (1) full table scan on
  `last_name` (no index, 100k rows scanned/request), (2) the app's DB
  connection pool capped at 2 connections (shared root cause with OPS-2202),
  and (3) the endpoint returning *all* ~10,000 matching rows (~3.7MB JSON) per
  request instead of a bounded page. Adding the index alone barely moved
  `p95` (55.12s → 54.93s) — it was not the dominant mechanism.
- **A — Action:** Added `idx_patients_last_name`; resized the connection pool
  2→20 with a bounded queue; capped search results to 50 rows with a
  `truncated` flag.
- **R — Result:** `p(95)` 55.12s → 380ms (**145×**), RPS 5.9 → 739.7
  (**125×**), 0% errors throughout.
- **Scar / lesson:** The "obvious" fix (index) is real but was a small
  fraction of the actual win — always re-measure under the *same* concurrency
  after each individual fix, don't assume the first plausible mechanism is
  the dominant one. A dashboard on connection-pool utilization and p95-by-route
  would have caught this before 200 nurses did.
- **Evidence:** `LAB_JOURNAL.md` § OPS-2201; `evidence/OPS-2201-before.txt`,
  `evidence/OPS-2201-after-index-only.txt`, `evidence/OPS-2201-after-full-fix.txt`;
  fix commit touching `api/server.js` (`SEARCH_RESULT_LIMIT`) and the
  `idx_patients_last_name` index.

## OPS-2202 — "DB is idle" was true — the bottleneck was the app's own connection pool

- **S — Symptom:** Entire API stalls during registration surges; even the
  trivial `recent patients` query takes seconds or 500s while DB CPU/disk stay
  low. Measured: `avg=3.75s`, `p(95)=5.31s` at only 449 req/s successful
  throughput against a 2000-VU burst, with MySQL `SHOW PROCESSLIST` showing
  **2** active connections the entire time.
- **C — Cause:** `connectionLimit: 2` in the app's MySQL pool
  (`api/database.js`) with an unbounded queue (`queueLimit: 0`). Every
  request — regardless of query cost — must wait for one of only 2 pooled
  connections; 1998 of 2000 concurrent requests just queue in the app. Little's
  Law from measured data: `W = N/λ = 2/449 ≈ 4.5ms` real service time per
  query — the DB was never the constraint.
- **A — Action:** Resized pool to 20 connections (sized from measured W and
  MySQL's `max_connections=151`), added a bounded `queueLimit=200`, and a
  global in-flight-request cap with fast `503`s on overload.
- **R — Result:** MySQL now shows 20 connections actually in use (was 2);
  successful requests return in well under a second instead of 4–11s; excess
  load now gets an instant (`0.4ms`) `503 POOL_QUEUE_LIMIT` instead of an
  unbounded multi-second hang.
- **Scar / lesson:** A "the DB dashboard is flat" report does not mean the DB
  isn't the bottleneck's *destination* — it can mean requests never got far
  enough to reach it. Always check the app-tier connection pool's own
  utilization, not just the database's. Also: fixing the pool exposed a
  second, shallower ceiling (single-process connection admission under an
  extreme 2000-in-5s burst) — flagged as follow-up work, not chased to
  completion, since it wasn't this ticket's named mechanism.
- **Evidence:** `LAB_JOURNAL.md` § OPS-2202; `evidence/OPS-2202-before.txt`,
  `evidence/OPS-2202-after-final.txt`; fix commit touching `api/database.js`
  and `api/server.js` (`MAX_INFLIGHT_REQUESTS`, `sendDbError`).

## OPS-2203 — Hot-row lock held for an external call, then a queue with no depth limit, then finally right

- **S — Symptom:** Concurrent admits to the *same* hospital fail/crawl during
  a mass-casualty drill. Measured: `error rate 99.85%`, only `99` successful
  admits in 30s against 500 concurrent callers, with `sys.innodb_lock_waits`
  showing an `X,REC_NOT_GAP` lock held for the full duration of a simulated
  500ms external "bed registry" call.
- **C — Cause:** The admit transaction called a slow external notification
  *before* `COMMIT`, holding the row's exclusive lock for ~500ms+ instead of
  the few milliseconds the actual `UPDATE` needs. `1/W` throughput ceiling for
  one row: `1/0.5s = 2 admits/sec`, no matter how many callers pile on. Most
  observed "failures" were actually the app's own pool queue shedding load
  before even reaching the lock; the rest were genuine `ER_LOCK_WAIT_TIMEOUT`
  (1205, 5s wait configured).
- **A — Action (3 iterations):** (1) Moved the external call after `COMMIT`
  to shrink the critical section — eliminated lock-wait-timeout errors, but
  throughput was *still* catastrophic (~500-way contention on InnoDB's lock
  queue has its own overhead even with a tiny critical section: successful
  admits averaged 14.68s). (2) Added an in-process per-hospital queue so only
  one admit per hospital ever reaches the DB at once — first version had no
  depth limit and built an unbounded backlog that took minutes to drain under
  sustained overload, a *worse* failure mode than the original timeout. (3)
  Bounded the per-hospital queue at 50 pending, rejecting the rest instantly.
- **R — Result:** `ER_LOCK_WAIT_TIMEOUT` eliminated; sustained throughput for
  one hot hospital settled at ~6.8 admits/sec (near the real ceiling once
  overhead is accounted for) with excess load shed in ~0.2ms instead of
  waiting 5s to error or queueing indefinitely.
- **Scar / lesson:** Shrinking a critical section is necessary but not
  sufficient when hundreds of callers still contend for the same row —
  InnoDB's own lock-queue management has overhead at high fan-in. And an
  unbounded application-side queue is not automatically better than a
  DB-side timeout; it can be worse, because it fails *silently* and *slowly*
  instead of *loudly* and *fast*. Always bound queues you add.
- **Evidence:** `LAB_JOURNAL.md` § OPS-2203; `evidence/OPS-2203-before.txt`,
  `evidence/OPS-2203-after.txt`, `evidence/OPS-2203-after-queue-fix.txt`,
  `evidence/OPS-2203-after-bounded-queue.txt`; fix commit touching
  `api/server.js` (`runAdmit`, `ADMIT_QUEUE_LIMIT`).

## OPS-2204 — One request crashed the whole service; batching alone wasn't enough either

- **S — Symptom:** Nightly export restarts the service repeatedly, taking
  other users' requests down with it. Measured directly: a **single,
  unconcurrent** export request produced a kernel OOM-kill
  (`dmesg`: `anon-rss:157248kB` at a 160MB cgroup limit) — worse than the
  ticket's framing of a concurrency problem.
- **C — Cause:** `SELECT * FROM patients` (100,000 rows) buffered entirely
  into memory, then JSON-serialized into a second, comparably-sized string —
  both alive at once (~36MB of JSON alone; the intermediate JS object array
  costs more). O(N) memory with no bound on table size or caller count, made
  worse by `NODE_OPTIONS --max-old-space-size=256` letting V8 grow the heap
  past the container's real 160MB budget before the kernel intervened.
- **A — Action (3 iterations):** (1) Batched the query with keyset pagination
  and streamed the response — fixed the *solo* crash, but 50 concurrent
  callers still crashed the service 10×/2min, because `res.write()`
  backpressure was ignored, piling up write buffers per connection. (2) Awaited
  `'drain'` before each next batch, and lowered `--max-old-space-size` to
  112MB to match the cgroup budget — restarts dropped but didn't reach zero;
  the crash signature changed to V8's own `FATAL ERROR: JavaScript heap out of
  memory` at ~110MB live heap under 50 concurrent full exports. (3) Capped
  concurrent exports at 8 and shrank the batch size 2000→500 rows, bounding
  *total* in-flight memory across every concurrent caller, not just one.
- **R — Result:** Peak memory during the full 50-VU/2-minute reproduction:
  ~153MB (crashing) → ~53MB (stable). Restarts: 9–10 in 2 minutes → **0**.
  78 full 100,000-row exports completed correctly; everything past the
  concurrency cap gets an instant `503 EXPORT_CONCURRENCY_LIMIT` instead of
  taking the instance down.
- **Scar / lesson:** Streaming/batching bounds *one* request's memory; it does
  not bound the *sum* across every concurrent caller doing the same thing —
  you need a concurrency cap too. Also: a mismatched V8 heap flag vs. the
  actual container cgroup limit converts "should GC" into "kernel kills the
  process" — always set `--max-old-space-size` (and check for similar
  runtime/container mismatches) below the real memory ceiling, with margin
  for non-heap memory.
- **Evidence:** `LAB_JOURNAL.md` § OPS-2204; `evidence/OPS-2204-after.txt`
  (iteration 1, still crashing), `evidence/OPS-2204-after-full-fix.txt`
  (iteration 2, still crashing), `evidence/OPS-2204-after-concurrency-limit.txt`
  (iteration 3, stable); fix commit touching `api/server.js`
  (`EXPORT_BATCH_SIZE`, `MAX_CONCURRENT_EXPORTS`, `writeAsync`) and
  `docker-compose.yml` (`NODE_OPTIONS`).
