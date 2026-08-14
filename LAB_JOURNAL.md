# 🧾 On-Call Lab Journal — Regional Health

**Engineer:** Alice  **Date:** 2026-08-14

This is your investigation notebook. You are on call for the Regional Health
platform and working the [incident queue](./incidents/README.md). For each
incident you will:

1. **Hypothesis** — from the ticket symptoms alone, predict the cause *before*
   you run anything.
2. **Observation** — record real evidence: k6 output, Grafana/Prometheus
   metrics, `EXPLAIN ANALYZE` plans, lock views, `docker stats`, container logs.
3. **Root cause & mechanism** — explain *why* it happens. Name the database/OS
   mechanic yourself and show the capacity math.
4. **Fix & verify** — make the change, re-run the reproduction, and record the
   before/after.

> There is no answer key. A claim without evidence isn't a diagnosis. "It felt
> slow" is not an observation; `p(95)=1840ms, http_req_failed=32%` is.

---

## How to capture evidence

- **k6:** copy the summary block (`http_req_duration`, `http_req_failed`,
  `iterations`, `vus`).
- **MySQL:** `docker compose exec mysql-db mysql -uroot -plabpassword capacity_lab`
  then run `EXPLAIN ANALYZE ...`, `SHOW CREATE TABLE ...`,
  `SHOW ENGINE INNODB STATUS\G`, or query `performance_schema` / `sys`.
- **Metrics:** Grafana panels or raw Prometheus at http://localhost:9090.
- **Memory / restarts:** `docker stats`, `docker compose logs -f capacity-api`.

Environment note: k6 isn't installed on this machine, so every k6 run below
was executed via the official `grafana/k6` Docker image attached to the
compose network (`docker run --rm --network db-capacity-engineering-lab_lab-net
-e BASE_URL=http://capacity-api:3000 grafana/k6 run ...`). Raw output for every
run referenced below is saved under [`evidence/`](./evidence).

---

## Baseline — steady state (do this first)
*Run:* `k6 run load-tests/00-baseline.js` (healthy system, no incident)

```
http_req_duration..............: avg=15.12ms min=2.66ms med=5.43ms max=407.33ms p(90)=10.97ms p(95)=18.79ms
http_req_failed.................: 0.00%  0 out of 1500
http_reqs.......................: 1500   48.891335/s
```
(confirmed on re-run: 49.48 req/s, p95=19.61ms, 0% errors — stable; full output
in `evidence/baseline.txt` and `evidence/baseline-rerun.txt`)

| Metric              | Value |
|---------------------|-------|
| Requests/sec (RPS)  | 48.9 req/s (50 VUs, 1s think time → ≈ VUs / (think time + latency)) |
| p50 latency         | 5.43 ms |
| p95 latency         | 18.79 ms |
| p99 latency         | not in k6's default summary (only p90/p95 shown); max observed 407ms, so tail sits somewhere between 19ms and 407ms — worth adding a `p(99)` threshold if this were a real SLO |
| Error rate          | 0.00% |
| Peak API heap used  | 23.7 MB (`nodejs_heap_size_used_bytes`, sampled mid-run) |

> SLOs held for every incident below: **p95 < 300ms, error rate < 1%, RPS ≥
> baseline's 48.9/s** for read endpoints under normal (non-drill) load. Under
> the *specific* stress scenarios each ticket reproduces (200–2000 concurrent
> callers, or one hot row taking 500 concurrent writers), the honest target
> is graceful degradation — bounded latency and a fast, clear error for
> anyone over capacity — rather than 100% success, because the offered load
> in these drills exceeds what any single small instance can serve.

---

## Investigation — OPS-2201
*Ticket:* [Patient name search unusably slow at shift change](./incidents/OPS-2201.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2201.js`

### Hypothesis
> From the symptoms alone (fast when isolated, collapses under concurrent
> searches, other endpoints unaffected), I think the cause is **a full table
> scan on `patients.last_name`** because there's no index on that column, so
> the query's cost scales with table size (100k rows examined per search),
> and under concurrency many of these expensive scans compete for CPU/IO at
> once. This turned out to be **true but far from the whole story** — see
> below.

### Observation (evidence)
```
mysql> SHOW CREATE TABLE patients;
CREATE TABLE `patients` (
  `id` int NOT NULL AUTO_INCREMENT,
  `first_name` varchar(64) NOT NULL,
  `last_name` varchar(64) NOT NULL,
  `email` varchar(128) NOT NULL,
  `diagnosis` varchar(255) NOT NULL,
  `notes` text NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB   -- no index on last_name

mysql> EXPLAIN ANALYZE SELECT * FROM patients WHERE last_name = 'Smith';
-> Filter: (patients.last_name = 'Smith')  (cost=10276 rows=9819) (actual time=0.0714..111 rows=10000 loops=1)
    -> Table scan on patients  (cost=10276 rows=98191) (actual time=0.0484..97.5 rows=100000 loops=1)

mysql> SELECT COUNT(*) FROM patients WHERE last_name='Smith';   -- 10000 rows
mysql> SELECT AVG(LENGTH(notes)), AVG(LENGTH(CONCAT(first_name,last_name,email,diagnosis,notes))) FROM patients;
avg_notes_bytes: 197.3   avg_row_bytes: 240.5
```
Reproduction (`reproduce-OPS-2201.js`, 200 VUs / 30s, before any fix):
```
http_req_duration..............: avg=23.72s min=692.16ms med=20.86s max=59.6s p(90)=49.81s p(95)=55.12s
http_req_failed.................: 0.00%  0 out of 354
http_reqs.......................: 354    5.899754/s
```

| Metric (under load) | Value      | vs. baseline (48.9 rps, p95=18.8ms) |
|----------------------|-----------|--------------------------------------|
| p95 latency          | 55.12 s   | ~2,900× worse |
| RPS                  | 5.9 req/s | ~8× *lower* despite 4× the VUs |
| Error rate           | 0.00%     | same — but only because nobody waits long enough to see a real error; everything just hangs |
| Rows examined / req  | 100,000 (full scan) → 10,000 rows returned | baseline's `recent` query examines/returns 50 rows via the PK index |

**First fix attempt — add the missing index**, and re-test in isolation:
```
mysql> CREATE INDEX idx_patients_last_name ON patients(last_name);
mysql> EXPLAIN ANALYZE SELECT * FROM patients WHERE last_name = 'Smith';
-> Index lookup on patients using idx_patients_last_name (last_name='Smith')  (cost=2371 rows=10000) (actual time=0.0368..73.1 rows=10000 loops=1)
```
Cost estimate dropped 10276→2371 and the full-scan node disappeared, but actual
wall time only dropped 111ms→73ms for a *solo* query — because the query still
has to fetch and return all 10,000 matching rows. Re-running the full 200-VU
reproduction with **only** the index added:
```
http_req_duration..............: p(95)=54.93s   (vs 55.12s before — essentially unchanged)
http_reqs.......................: 387   6.545318/s
data_received...................: 1.4 GB over 387 requests ≈ 3.7 MB per response
```
**The index barely moved the needle.** This is the "being wrong is progress"
moment: the missing index is real and worth fixing, but it was not the
dominant mechanism under concurrency.

Digging further, `SHOW PROCESSLIST` during the load showed only **2** active
connections from the app the entire time (see OPS-2202 below — same finite
resource, `connectionLimit: 2` in `api/database.js`), and `data_received`
showed each search response was returning **all** ~10,000 matching rows
(~3.7MB of JSON) rather than a bounded page.

### Root cause & mechanism
Three compounding mechanisms, discovered in this order:
1. **Full table scan** (fixed by the index): `WHERE last_name = ?` had no
   index, so InnoDB scanned all 100,000 rows to find ~10,000 matches — cost
   scales linearly with table size, ~111ms solo. This alone explains "fine
   when isolated, gets worse as the table grows," but not the 2,900× blowup
   under concurrency.
2. **Connection-pool starvation** (the real concurrency multiplier, shared
   with OPS-2202): the app's MySQL pool only had **2** connections
   (`connectionLimit: 2`). With 200 concurrent VUs and 2 workers, ~198
   requests queue in the app at any instant. This is the dominant reason a
   *solo* search is instant but a *concurrent* one collapses — it has
   nothing to do with the query plan.
3. **Unbounded result set** (the second surprise): common last names match
   up to 10,000 of the 100,000 rows, and the endpoint returned *all* of them,
   each with a large `notes TEXT` field, producing ~3.7MB JSON responses. That
   payload has to be built (JSON.stringify, mostly synchronous/CPU-bound) and
   shipped over the network on every request; capping the pool doesn't help
   if each of the few requests that *do* get a connection also has to
   serialize/send megabytes.

Capacity math for 100,000 rows: an unindexed equality lookup costs O(N) — a
full scan of all N=100,000 rows regardless of how many match. An indexed
lookup costs O(log N + M) where M is the number of matching rows (~10,000 for
"Smith") — the index narrows the *search*, but M is still bounded only by
result-set size, which is why step 3 (capping M) mattered as much as step 1
here.

### Fix & verify
Three changes, applied together:
1. `CREATE INDEX idx_patients_last_name ON patients(last_name)` — turns the
   scan into an index lookup.
2. Resize the connection pool 2 → 20 with a bounded queue (`api/database.js`
   — see OPS-2202 for the full rationale and capacity math).
3. Cap the search endpoint's result set: `SELECT ... LIMIT 50` with a
   `truncated: true/false` flag in the response (`api/server.js`,
   `SEARCH_RESULT_LIMIT`), matching how the `recent` endpoint already
   behaves and how a real search UI would page results instead of dumping
   the whole match set.

Re-run (`evidence/OPS-2201-after-full-fix.txt`), same 200-VU/30s load:
```
http_req_duration..............: avg=269.01ms min=35.23ms med=231.39ms max=5.95s p(90)=332.72ms p(95)=380.41ms
http_req_failed.................: 0.00%  0 out of 22351
http_reqs.......................: 22351  739.721299/s
```
**New p95: 380ms  New RPS: 739.7  Improvement factor: 145× on p95, 125× on
RPS**, all 200 VUs sustaining traffic the whole run (previously VUs would
stall mid-request; only 5–13 were ever actually "active" at a time).
Slightly above the 300ms SLO target — a smaller `SEARCH_RESULT_LIMIT` or a
larger pool would close that last gap, but this is an honest, order-of-
magnitude fix, not a perfect one.

**Trade-off:** capping search results means a search for a very common
surname no longer returns literally everyone with that name in one call — a
real product would need pagination (`?page=`) or requiring an additional
filter (e.g. first name or DOB) once a search is "too broad," rather than
silently truncating at 50.

---

## Investigation — OPS-2202
*Ticket:* [Whole app freezes during surges, DB looks idle](./incidents/OPS-2202.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2202.js`

### Hypothesis
> Given the query is trivial and the DB is idle yet requests pile up, I think
> the bottleneck is **the application's own MySQL connection pool** because a
> query can't execute until the app hands it a connection, and if that pool
> is tiny, requests queue *in the app*, not in the database — which is
> exactly why the DBA's dashboards would show nothing.

### Observation (evidence)
```js
// api/database.js (before fix)
connectionLimit: 2,
queueLimit: 0,       // 0 = unbounded queue in mysql2 — no back-pressure, just infinite queueing
```
Reproduction (`reproduce-OPS-2202.js`, ramping 0→2000 VUs over 5s, held 25s):
```
http_req_duration..............: avg=3.75s min=11ms med=4.01s max=11.4s p(90)=4.75s p(95)=5.31s
http_req_failed.................: 0.00%  0 out of 15203
http_reqs.......................: 15203  448.993115/s
```
Mid-load, `SHOW PROCESSLIST` / `information_schema.processlist` and `docker
stats`:
```
mysql> SELECT COUNT(*) FROM information_schema.processlist WHERE db='capacity_lab';
conns: 2                              -- only 2, regardless of 2000 offered VUs

CONTAINER      CPU %    MEM              
mysql-db       37.89%   476.9MiB / 14.8GiB   -- busy-ish but nowhere near max_connections=151
capacity-api   148.13%  100.6MiB / 160MiB    -- pegged over 1 core just managing the queue
```
`SHOW VARIABLES LIKE 'max_connections'` → **151** available; the app used 2.

| Metric                          | Value        | vs. baseline |
|----------------------------------|--------------|--------------|
| Successful RPS (plateau)        | 449 req/s    | ~9× baseline, but at crushing latency |
| p95 / p99 latency               | 5.31s / (not in default summary; max=11.4s) | ~280× worse than baseline p95 |
| Error / timeout rate            | 0% (before fix) — everything eventually completes, just very slowly | — |
| Avg service time per query (s)  | 4.5ms (derived, see below) | baseline's own query is similarly cheap; the difference is 100% queueing, 0% query cost |

### Root cause & mechanism
The paradox resolves once you separate "the database" from "the application's
gateway to the database." The `recent` query really is trivial
(`EXPLAIN ANALYZE` on `SELECT * FROM patients ORDER BY id DESC LIMIT 50`:
**0.2ms**, index scan on the PK). But every request has to acquire one of only
**2** pooled connections before it can even send that query. With 2000
concurrent callers and 2 servers, ~1998 requests are just waiting for a free
connection — a classic queueing bottleneck, and it lives entirely in Node's
in-process pool, invisible to any DB-side dashboard. That's why "the DB is
bored" and "the app is clearly waiting on *something* database-related" are
both true at once.

**Little's Law**, applied to the measured data:
- Plateau throughput with N=2 connections: λ = 449 req/s
- `N = λ · W  ⇒  W = N / λ = 2 / 449 ≈ 4.46 ms` — the actual average service
  time per query (DB round-trip + serialization), confirmed independently by
  the 0.2ms `EXPLAIN ANALYZE` time plus Node/network overhead.
- Required capacity for a target throughput: to sustain, say, λ = 500 req/s
  at that same W, `N = λ · W ≈ 500 × 0.00446 ≈ 2.2` — which says N=2 is
  *almost* enough for 500 req/s of *accepted* work, but the ticket's surge
  offers **2000 concurrent** requests at once, not 500 sequential ones. The
  gap between "N handles the sustained rate fine" and "N=2 collapses at a
  sudden burst" is exactly queueing delay: observed `L = λ·W_total = 449 ×
  3.75s ≈ 1684`, matching the ~1555 requests actually stuck in the app's
  queue at any instant during the burst (2000 offered − ~445 in flight).
- Why doesn't making the pool arbitrarily large keep helping forever?
  Because MySQL itself only has `max_connections = 151`, and beyond some
  point more concurrent connections just means more context-switching and
  contention on the same finite DB threads/CPU — the pool needs to be *sized
  to the resource behind it*, not maximized.

### Fix & verify
`api/database.js`: `connectionLimit: 2 → 20` (sized from the measured
W≈4.5ms: 20 connections gives a theoretical ceiling of `20 / 0.0045 ≈ 4400
req/s`, comfortably above what one instance should be expected to serve, while
leaving most of MySQL's 151-connection budget free). `queueLimit: 0 → 200`
(bounded — beyond 200 waiting requests, fail fast instead of queueing
forever). Also added a global in-flight-request cap
(`MAX_INFLIGHT_REQUESTS=300`) in `api/server.js` as defense-in-depth against
raw connection-admission overload, and mapped the pool's "Queue limit
reached" error to a clean `503` instead of a generic `500`.

Verification, same 2000-VU surge:
```
mysql> SELECT COUNT(*) FROM information_schema.processlist WHERE db='capacity_lab';
conns: 20                              -- fully utilizing the resized pool
mysql-db CPU: 18.26%   (up from near-zero utilization of its actual capacity)

/metrics (Prometheus, app-side, after the run):
http_request_duration_seconds{route="/api/patients/recent",status_code="200"}: count=10718, sum=... → avg well under 1s
http_requests_total{route="...recent",status_code="503"}: 37096   (db_errors_total code="POOL_QUEUE_LIMIT")
  → these 503s average 0.4ms each — a deliberate, instant "try again", not a hang
```
**New RPS: 1365.8 req/s of *offered* throughput actually reaches the app (up
from the pool silently absorbing everything); accepted/successful throughput
per run ≈ 300-350/s at low latency. New error rate (k6's `http_req_failed`,
which counts non-2xx): ~77%. New p95 (blended, incl. the fast 503s):
1.39s.**

This number needs an honest caveat, because a naive read makes it look like a
regression from 0% errors to 77%: **the "errors" are now almost entirely our
own fast, intentional `503 POOL_QUEUE_LIMIT` responses (37,096 of them,
matching the app-side counter almost exactly), not failures.** Before the
fix, 100% of the 2000-VU surge "succeeded" — after waiting 4–11 seconds each.
After the fix, the resizeable pool serves what it realistically can fast, and
anything genuinely beyond capacity gets a millisecond-scale "no, retry" signal
instead of a multi-second hang. That is the graceful degradation the ticket's
own investigation question asks for.

**Residual finding (documented, not fully chased):** pushing the *exact*
2000-VU-in-5-seconds burst against the resized pool also exposed a second,
shallower ceiling — Node's single-threaded process admitting/parsing that
many near-simultaneous new connections has its own limit (`capacity-api` CPU
observed >120%, i.e. pegging more than one core equivalent of single-threaded
work). A handful of requests (~2% of the total, cross-checked via the app's
own Prometheus counters vs. k6's totals) saw raw `dial: i/o timeout` rather
than a clean response. This is a distinct, deeper bottleneck from the DB pool
and would need horizontal scaling (multiple app instances behind a load
balancer, or Node's `cluster` module) to fully close — flagged as follow-up
work, not solved in this pass, since the ticket's named mechanism (DB
connection pool) is conclusively fixed and verified.

**Upstream protection for graceful degradation:** the bounded `queueLimit`
(pool-level) plus `MAX_INFLIGHT_REQUESTS` (app-level) together are exactly
that — reject fast once past a known-good capacity instead of queueing
indefinitely. In front of the app, a load balancer or API gateway with its
own request-queue depth limit and/or client-facing rate limiting would smooth
bursts before they even reach the app.

---

## Investigation — OPS-2203
*Ticket:* [Bed admissions fail with DB errors under load](./incidents/OPS-2203.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2203.js`

### Hypothesis
> Given one-at-a-time works but concurrent admits to the *same* hospital
> fail, I think the cause is **row-level lock contention on that hospital's
> row**, and the failure will show up as **a DB error** (a lock-wait-timeout),
> because MySQL enforces isolation by making concurrent writers to the same
> row wait for each other, and this environment sets
> `--innodb-lock-wait-timeout=5`.

### Observation (evidence)
Reproduction (`reproduce-OPS-2203.js`, 500 VUs / 30s, before fix):
```
http_req_duration..............: p(95)=162.63ms   (fast for the *blended* population — see why below)
http_req_failed.................: 99.85%  67656 out of 67755
{ expected_response:true }......: avg=32.46s med=34.62s p(90)=54.5s p(95)=56.98s   (the tiny sliver that succeeded took forever)
```
`sys.innodb_lock_waits` during the run:
```
locked_table: capacity_lab.hospitals   locked_index: PRIMARY   locked_type: RECORD
waiting_trx_id: 2368   waiting_query: UPDATE hospitals SET available_beds = available_beds - 1 WHERE id = 1
waiting_lock_mode: X,REC_NOT_GAP
blocking_trx_id: 2364  blocking_pid: 300   blocking_trx_age: 00:00:06
```
`db_errors_total` (Prometheus, app-side):
```
db_errors_total{route="/api/hospitals/:id/admit", code="POOL_QUEUE_LIMIT"}: 67553
db_errors_total{route="/api/hospitals/:id/admit", code="ER_LOCK_WAIT_TIMEOUT"}: 156
```

| Metric                     | Value                          | vs. baseline |
|----------------------------|---------------------------------|--------------|
| p95 / p99 latency          | 162.63ms blended / 56.98s for the successful few | misleading — see mechanism |
| Max successful admits/sec  | 99 admits in 30s ≈ 3.3/s        | — |
| DB error(s) + code         | `ER_LOCK_WAIT_TIMEOUT` (1205) — 156 of them; the other 67,553 "failures" never even reached the DB (see mechanism) | none in baseline |
| Error rate                 | 99.85%                          | baseline 0% |

### Root cause & mechanism
Confirmed: `X,REC_NOT_GAP` — an exclusive record lock on the hospital's PK row,
held by whichever transaction is mid-admit. The original code (`api/server.js`)
did:
```js
await conn.beginTransaction();
await conn.query('UPDATE hospitals SET available_beds = available_beds - 1 WHERE id = ?', [id]);
await notifyBedRegistry(id);   // simulated 500ms external call, INSIDE the transaction
await conn.commit();
```
The `UPDATE` takes the row lock immediately; it isn't released until
`commit()`. Calling the 500ms `notifyBedRegistry` *before* commit means the
lock is held for the full 500ms+ round-trip, not just the update itself. Every
other transaction targeting the *same* hospital row must wait behind it —
this is **row-lock serialization enforced by isolation (durability +
consistency of the row's value)**, not a bug in MySQL, just a critical
section that's far longer than it needs to be.

**Theoretical max throughput for one hot row:** if the critical section is
held for W seconds, no amount of concurrency can beat `1/W` admits/sec for
that row — everyone else is just queued behind the lock. With
W ≈ 0.5s (dominated by the notify call), `1/W = 2 admits/sec`, *regardless of
how many callers pile on*. Most of the observed "failures" (67,553 of 67,755)
were actually our own pool's bounded queue (`POOL_QUEUE_LIMIT`, from the
OPS-2202 fix already in place) shedding load before it even reached the lock
— only the 156 that got a connection and then genuinely waited >5s for the
row surfaced as `ER_LOCK_WAIT_TIMEOUT`.

### Fix & verify
**Attempt 1 — shrink the critical section:** commit immediately after the
`UPDATE`, and call `notifyBedRegistry` *after* commit (fire-and-forget) so the
row lock is held only for the update itself (~20–70ms solo, confirmed via
`time curl`). Re-running the 500-VU load: `ER_LOCK_WAIT_TIMEOUT` **dropped to
zero**, but throughput was still catastrophic (521/66177 succeeded) — **this
fix alone did not work**, which is exactly the kind of "obvious fix doesn't
fully solve it" moment the assignment asks to watch for.

Digging further: even with a tiny critical section, 500 transactions were
still landing on InnoDB's internal lock-wait queue for the *same* row all at
once. Solo, an admit takes ~20–70ms; under 500-way contention on one row, the
successful ones averaged **14.68s** round-trip (Prometheus:
`http_request_duration_seconds{route=".../admit",status_code="200"}`, and
`docker stats` showed `mysql-db` CPU at only 4–6%, i.e. the *database* wasn't
struggling — the overhead was in granting/waking hundreds of queued waiters
one at a time.

**Attempt 2 — reduce fan-in with an in-process per-hospital queue:**
chain admits to the same `hospitalId` through a JS promise chain so only
*one* admit per hospital ever reaches the database at a time — InnoDB never
sees more than one waiter for that row. First version had **no depth limit**:
under sustained 500-VU overload it grew into an unbounded backlog that took
minutes to drain (confirmed by firing a fresh batch of `curl` requests at a
15s timeout and getting 400/400 `000` — genuinely still waiting behind a
multi-minute queue from the *previous* test). **This is a second, more subtle
regression: trading a 5-second DB-side timeout for an unbounded, silent,
multi-minute app-side queue is worse, not better.**

**Attempt 3 (final) — bound the per-hospital queue:** cap pending admits per
hospital at 50 (`ADMIT_QUEUE_LIMIT`); beyond that, reject immediately with
`503 HOSPITAL_QUEUE_LIMIT` (mirrors the pool's own `queueLimit` pattern).
Re-run:
```
db_errors_total{route="/api/hospitals/:id/admit", code="HOSPITAL_QUEUE_LIMIT"}: 78486  (avg 0.196ms each — instant)
http_requests_total{route="/api/hospitals/:id/admit", status_code="200"}: 203          (avg 7.42s each — queued but bounded)
```
**Re-measured throughput / error rate:** 203 successful admits in ~30s ≈
**6.8 admits/sec sustained** for one hospital under 500-way contention (close
to the ~14–50/s theoretical ceiling once real overhead is accounted for), with
everything past that shed in well under a millisecond instead of erroring out
after a 5-second wait or hanging indefinitely. `ER_LOCK_WAIT_TIMEOUT` and the
unbounded-backlog failure mode are both gone.

**Trade-off:** notifying the bed registry after commit means "beds
decremented" and "registry notified" are no longer atomic — if the notify
fails, the DB is already updated and out of sync with the registry until a
retry (not modeled in this lab). That's a deliberate, disclosed trade of
strict atomicity for a critical section short enough to actually scale.

---

## Investigation — OPS-2204
*Ticket:* [Nightly export crashes the service repeatedly](./incidents/OPS-2204.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2204.js`

### Hypothesis
> Given memory spikes right before each restart and only the big export is
> affected, I think the cause is **the export endpoint loading the entire
> patients table into memory at once** because `SELECT * FROM patients` with
> no limit has to buffer and then JSON-serialize all ~100,000 rows
> simultaneously, and that's O(N) memory that scales with table size, unlike
> every other endpoint which caps its result set.

### Observation (evidence)
A **single, unconcurrent** export request was enough to crash the service —
worse than the ticket implies:
```
$ time curl -s http://localhost:3000/api/patients/export -o /tmp/export.json
HTTP:000   (connection dropped mid-request)

$ dmesg | grep -i oom
kernel: node invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0
kernel: oom-kill:constraint=CONSTRAINT_MEMCG, ... task=node,pid=942118
kernel: Memory cgroup out of memory: Killed process 942118 (node) total-vm:1285660kB, anon-rss:157248kB
```
~153MB RSS at the moment of the kernel OOM-kill — right at the edge of the
160MB `mem_limit`. `docker inspect` confirmed `OOMKilled: true`,
`RestartCount` incrementing by 1 per crash.

| Metric                          | Value |
|-----------------------------------|-------|
| Approx. payload size per request | 36.1 MB JSON for all 100,000 rows (measured directly: `SIZE:36141185` bytes) |
| Peak heap/RSS before crash       | ~153MB RSS (kernel OOM) on the original code; later, ~110–114MB **V8 heap** (self-inflicted FATAL error) once `--max-old-space-size` was tuned — see fix iterations below |
| Time-to-first-crash              | Immediate — one solo request |
| Container restart count          | 1 per solo request (original code); 9–10 within 2 minutes under the 50-VU reproduction before the fix was complete |
| GC pause trend                  | `Scavenge (reduce) 110.2→110.1MB`, `Mark-Compact (reduce) 111.4→109.2MB` — GC running constantly and barely reclaiming anything: most of the live heap was genuinely reachable, not garbage |

Crash log line (captured directly from `docker compose logs`, under the
50-concurrent reproduction, after batching+streaming was already in place —
see fix iteration 2 below):
```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
 1: node::OOMErrorHandler(...)
 ...
```

### Root cause & mechanism
`api/server.js` originally did `const [rows] = await pool.query('SELECT * FROM patients'); res.json({ count: rows.length, data: rows });`
— every row (id, first/last name, email, diagnosis, and a `notes TEXT` field
repeated 6× per patient, ~240–300 bytes raw) gets buffered into one JS array,
then `res.json()` (`JSON.stringify` under the hood) builds a **second**,
comparably-sized string — both alive in memory at the same time.

**Capacity math:** 100,000 rows × ~300–400 bytes of JSON-encoded row
(measured directly: 36.1MB ÷ 100,000 rows ≈ 361 bytes/row) ≈ **36MB** just for
the serialized text; the intermediate array of parsed JS row objects costs
more due to per-object/per-string V8 overhead, plausibly 2–4× that. Even a
single caller's transient peak (parsed rows + JSON string existing
simultaneously) can approach 100MB+ — which is why *one* request, with no
concurrency at all, was enough to blow the 160MB budget. With C concurrent
callers each doing this independently, peak resident memory scales roughly
linearly with C — there is no bound on either axis (table growth or caller
count), i.e. **O(N × C) memory** for an operation that only ever needs to hold
one page's worth of rows in memory at a time.

The docker-compose config compounds this on purpose (as its own comments
explain): `NODE_OPTIONS: --max-old-space-size=256` tells V8 it may grow its
heap to 256MB, but the container's real cgroup budget is 160MB — V8 has no way
to know that, so it happily grows the heap past what the cgroup backs and the
**kernel** OOM-kills the process outright, rather than V8 proactively
GC'ing to survive.

### Fix & verify — three iterations, because the first two didn't fully work
**Iteration 1 — batch the query, stream the response:** replace the single
`SELECT *` with a keyset-paginated loop (`WHERE id > ? ORDER BY id LIMIT
2000`, using the last-seen `id` as a cursor — cheap index range scan, unlike
`OFFSET` which degrades at large offsets) and `res.write()` each batch instead
of building one giant array. Verified a solo export now succeeds
(36.1MB, 100,000 rows, correct) without crashing. **But** re-running the full
50-VU/2-minute reproduction still produced **10 restarts**, `OOMKilled: true`
— batching bounds *one* request's peak, but `res.write()` returns `false`
under backpressure and the code ignored that, so 50 concurrent unthrottled
writers still piled up write buffers without bound. Same failure, moved from
the query layer to the HTTP layer.

**Iteration 2 — respect backpressure, fix the V8/cgroup mismatch:** await the
`'drain'` event before fetching the next batch (`writeAsync` helper), and
lower `--max-old-space-size` 256→112 (leaving ~48MB of the 160MB cgroup budget
for non-heap memory, so V8 GCs proactively instead of the kernel intervening).
Re-running: restarts dropped to 6–9, but the crash signature changed to a
**V8-internal** `FATAL ERROR: JavaScript heap out of memory` (see log above) —
live heap plateaued around ~110MB under 50 concurrent full-export streams,
which GC could not reclaim because it was genuinely live (reachable) data.
**Still not fixed** — bounding one request's memory doesn't bound the *sum*
across every request happening at once.

**Iteration 3 (final) — bound concurrency, not just per-request size:** cap
concurrent exports at 8 (`MAX_CONCURRENT_EXPORTS`), rejecting anything beyond
that with an instant `503 EXPORT_CONCURRENCY_LIMIT`, and reduce the batch size
2000→500 rows to shrink each in-flight chunk further. Re-run, full 50-VU/2min
reproduction:
```
RestartCount: 0   OOMKilled: false
peak MemUsage sampled every second throughout the run: 51.65 → 52.93 MiB / 160MiB
http_requests_total{route=".../export", status_code="200"}: 78     (complete, correct exports)
db_errors_total{route=".../export", code="EXPORT_CONCURRENCY_LIMIT"}: (the rest, shed instantly)
```
**New peak heap: ~53MB (down from ~153MB RSS / ~110MB V8 heap that crashed
the process).  Restarts: 0 (down from 9–10 in the same 2-minute window).
Error rate: 99.9% by k6's status-code check — but as with OPS-2202/2203, this
is the correct outcome: the service now stays up throughout, completes 78 full
100,000-row exports, and cleanly rejects the rest with a fast, clear signal
instead of crashing the entire instance (and everyone else's requests along
with it, which is what the ticket actually complained about).**

---

## Post-incident review (synthesis)

> Rank the four incidents by **blast radius** (threat to overall availability
> at scale), justified with your measured numbers:
>
> 1. **OPS-2204 (memory/export)** — worst blast radius. A *single*
>    unconcurrent request took down the **entire instance** (kernel
>    OOM-kill, confirmed via `dmesg`), taking every other user's in-flight
>    request with it. Every other incident degrades *its own* endpoint under
>    load; this one can crash the whole process from one caller.
> 2. **OPS-2202 (connection pool)** — second worst: a single tunable
>    (`connectionLimit: 2`) silently caps *the entire application's* ability
>    to talk to the database, so it affects every read endpoint
>    simultaneously (`recent`, `search`, and indirectly `admit`/`export`,
>    which all share the same pool) the moment traffic spikes, even though
>    nothing is actually broken query-wise.
> 3. **OPS-2201 (search)** — narrower: confined to one endpoint, but shares
>    the same pool-starvation mechanism as #2 plus its own compounding
>    causes (missing index, unbounded result size), so it's a good
>    illustration of how blast radius composes across shared resources.
> 4. **OPS-2203 (hot-row admits)** — narrowest observed blast radius: only
>    admits to the *same* hospital row contend with each other (measured:
>    admits to different hospitals were unaffected), and the fixed version
>    caps damage to that one hospital's admit throughput (~6.8/s) rather than
>    the whole service. Still P1-worthy operationally (a mass-casualty
>    surge is exactly when you can't afford 6.8 admits/sec to one hospital),
>    but it doesn't take down unrelated endpoints the way 2202/2204 do.
>
> If you could ship only **one** fix before a launch, which and why?
> **The OPS-2204 memory fix.** It's the only incident where the failure mode
> is "the whole instance dies," full stop, regardless of which endpoint
> anyone else was calling — and it was triggered by a *single* request, not
> even a surge. A capacity problem that degrades one endpoint under heavy
> load (2201/2202/2203) is a bad night; a capacity problem that OOM-kills the
> process from one unlucky ETL call is an outage with no warning.
>
> For each incident, what alert or dashboard would have caught it in
> production *before* a user filed a ticket?
> - **OPS-2201:** a `mysql_slow_queries` / `performance_schema` alert on
>   full table scans (`Handler_read_rnd_next` rate, or `EXPLAIN`-based query
>   digest showing "table scan" access type) on a hot endpoint, or simply
>   p95 latency by route crossing its SLO — both were visible the moment
>   *any* concurrent load hit search, long before 200 nurses did it at once.
> - **OPS-2202:** a Grafana panel on **connection pool utilization**
>   (active/idle/queued connections vs. `connectionLimit`) would have shown
>   "2/2 connections busy, N queued" — pegged at 100% utilization — well
>   before latency alarms fired, and it's a leading indicator DB-side
>   dashboards structurally can't show.
> - **OPS-2203:** `sys.innodb_lock_waits` row count / `SHOW ENGINE INNODB
>   STATUS` lock-wait metrics, or simply alerting on `ER_LOCK_WAIT_TIMEOUT`
>   rate by route — a nonzero rate on `admit` during a drill is a clear
>   leading signal, and it's specific enough to point straight at "hot row,"
>   not just "errors are up."
> - **OPS-2204:** `nodejs_heap_size_used_bytes` as a fraction of the
>   container's `mem_limit` (not just an absolute heap number, which is
>   meaningless without knowing the cgroup budget), alerting well before
>   100% — e.g. at 70% sustained — plus tracking `container_oom_events_total`
>   / restart count as a hard, unambiguous SLO burn signal.
