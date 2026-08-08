# 🎫 Incident Queue

You are the on-call engineer for the **Regional Health** platform. Four tickets
are open. Each one is a real-sounding report from a user or another team — a
symptom, not a diagnosis. Nobody has told you the root cause; that's your job.

For each ticket:

1. **Read it** and form a hypothesis from the symptoms alone.
2. **Reproduce** it with the matching `load-tests/reproduce-<TICKET>.js` script
   while watching Grafana (http://localhost:3001) and the API logs.
3. **Investigate** using the database and the observability stack — not by
   reading the answer somewhere. Dig into query plans, connection behaviour,
   locks, and memory as appropriate.
4. **Diagnose & fix**, then re-run the reproduction to prove the fix.
5. **Write it up** in [`../LAB_JOURNAL.md`](../LAB_JOURNAL.md).

Always capture a healthy **baseline** first (`load-tests/00-baseline.js`) so you
have something to compare against.

| Ticket | Priority | Reported by | One-line symptom |
|--------|----------|-------------|------------------|
| [OPS-2201](./OPS-2201.md) | P2 | Night charge nurse | Patient name search hangs at shift change |
| [OPS-2202](./OPS-2202.md) | P1 | On-call SRE | Whole app freezes during surges, DB looks idle |
| [OPS-2203](./OPS-2203.md) | P1 | ED operations lead | Bed admissions fail with DB errors under load |
| [OPS-2204](./OPS-2204.md) | P2 | Data/ETL team | Nightly export crashes the service repeatedly |

> The tickets are independent — work them in any order. There is no answer key in
> this repository on purpose. Trust your measurements.
