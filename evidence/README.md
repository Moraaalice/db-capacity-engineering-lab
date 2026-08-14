# Evidence index

Raw output from every k6 run, SQL query, and log capture referenced in
[`LAB_JOURNAL.md`](../LAB_JOURNAL.md) and [`SCARS.md`](../SCARS.md).

Pruned to the files that actually back a claim in the journal/scar log —
dead-end probes and superseded intermediate runs (e.g. file-descriptor
checks, a stale-environment retest, duplicate `docker stats` snapshots) were
taken during the investigation but aren't kept here.

- `baseline*.txt` — healthy-system control group (`00-baseline.js`).
- `OPS-2201-*.txt` — search reproduction: `before` (full table scan),
  `after-index-only` (index alone — insufficient, p95 barely moved),
  `after-full-fix` (index + pool + result cap — 145× improvement).
- `OPS-2202-*.txt` — registration-surge reproduction: `before` (pool capped at
  2 connections, DB idle) and `after-final` (pool resized to 20, bounded
  queue).
- `OPS-2203-*.txt` — admissions reproduction: `before` (row lock held across
  a slow external call), `after` (critical section shrunk — lock timeouts
  gone, but throughput still bad), `after-queue-fix` (unbounded per-hospital
  queue — a *worse*, silent backlog), `after-bounded-queue` (fixed).
- `OPS-2204-*.txt` — export reproduction across all three fix iterations:
  `after` (batched/streamed, no backpressure — still 10 restarts),
  `after-full-fix` (backpressure + corrected V8 heap flag — still 6 restarts),
  `after-concurrency-limit` (concurrency cap — 0 restarts, fixed).
  `mem-during-load-final.txt` is the one-second `docker stats` memory trace
  for that final, fixed run (~52-53MB throughout).
- `sql/` — `EXPLAIN ANALYZE` output, `SHOW INDEX`, `max_connections`,
  `sys.innodb_lock_waits` rows, and the `dmesg` kernel-OOM-kill trace.

## Grafana screenshots

Not included. This environment's `grafana/grafana:latest` image has no
image-rendering plugin installed (`/api/plugins` returns no `renderer`
plugin, and there's no headless-browser tooling available here to screenshot
the dashboard manually). The Grafana panels are driven by the same
Prometheus queries pasted throughout the journal
(`http_requests_total`, `http_request_duration_seconds`, `db_errors_total`,
`nodejs_heap_size_used_bytes`), captured directly via `curl .../metrics` or
`docker stats` instead — same underlying data, just not the dashboard chrome
around it. If you have Grafana access, http://localhost:3001 dashboard
"Capacity Lab — Regional Health" will show the same story live.
