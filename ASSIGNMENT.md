# 🚑 Assignment — Regional Health On-Call Lab

**You are on call for the Regional Health platform.** Four incidents are open in
the queue. Your job is to investigate each one like a real SRE: form a
hypothesis, reproduce it under load, gather *evidence*, name the mechanism, ship
a fix, and prove it worked.

> **Read this first:** the tickets describe symptoms *as reported by users and
> other teams* — the suspected cause may be incomplete or flat-out wrong.
> **Disproving a ticket's assumption with evidence is a full-marks answer, not a
> failure.** "I expected X, measured Y, here's the proof" is exactly the skill
> we're building. You are *supposed* to be surprised.

---

## What you'll hand in

1. A **fully filled `LAB_JOURNAL.md`** — baseline + all four incidents + the
   post-incident synthesis.
2. A **`SCARS.md`** — one short "scar log" per incident (template below).
3. **Evidence** committed to your repo — k6 summaries, `EXPLAIN`/lock output,
   `docker stats`, Grafana screenshots, and your **fix commits** (before/after).
4. A **link to your own personal GitHub repo** containing all of the above,
   shared with me on Slack.

---

## The workflow — 3 phases

### Phase 1 — Break it down together (in your group) 🧠
Before anyone touches a terminal, meet as a group and, for each of the four
incidents, agree on:
- What is the *symptom* in plain English?
- Which endpoint / resource is implicated?
- What's your group's **first hypothesis** — and how would you *prove or
  disprove* it? (What metric, query, or view would settle it?)

Capture this shared breakdown. You'll each test it individually next — and it's
fine (expected!) for the evidence to change your mind.

### Phase 2 — Investigate individually (each engineer) 🔬
Everyone clones the repo and works it **on their own machine, in their own
repo**. For each incident, follow the loop the journal lays out:

1. **Hypothesis** — write it *before* you run anything.
2. **Reproduce** — run the incident's k6 script and watch it break.
3. **Observe** — capture *real evidence* (numbers, not adjectives).
4. **Root cause** — name the database/OS/app mechanism and show the capacity math.
5. **Fix & verify** — change the code/config, re-run, record before → after.

### Phase 3 — Submit (each engineer) 📬
Push everything to your personal repo and send me the link (see **Submission**).

---

## Environment setup

**Prereqs:** Docker + Docker Compose, [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/),
and `git`.

```bash
# 1. Get your own copy (see "Submission" for how to make it YOUR repo)
git clone https://github.com/devBoya/db-capacity-engineering-lab.git
cd db-capacity-engineering-lab

# 2. Bring up the stack (API + MySQL + MongoDB + Prometheus + Grafana)
docker compose up -d --build

# 3. Seed ~100,000 patients + hospitals
docker compose exec capacity-api bash /usr/local/bin/seed.sh

# 4. Capture your BASELINE first (healthy system — your control group)
k6 run load-tests/00-baseline.js
```

**Dashboards & tools you'll use:**
- Grafana → http://localhost:3001 (dashboard "Capacity Lab — Regional Health" is
  pre-loaded: throughput, p95 latency, memory-vs-limit, DB errors)
- Prometheus → http://localhost:9090
- MySQL shell → `docker compose exec mysql-db mysql -uroot -plabpassword capacity_lab`
- Live memory/restarts → `docker stats` and `docker compose logs -f capacity-api`

**The incident queue** lives in [`incidents/`](./incidents/README.md):

| Ticket | Reproduce with |
|--------|----------------|
| OPS-2201 — patient search slow at shift change | `k6 run load-tests/reproduce-OPS-2201.js` |
| OPS-2202 — whole app freezes, DB looks idle    | `k6 run load-tests/reproduce-OPS-2202.js` |
| OPS-2203 — bed admissions fail under load      | `k6 run load-tests/reproduce-OPS-2203.js` |
| OPS-2204 — nightly export crashes the service  | `k6 run load-tests/reproduce-OPS-2204.js` |

---

## Deliverable 1 — the filled journal

Open [`LAB_JOURNAL.md`](./LAB_JOURNAL.md) and fill **every** section: baseline
table, all four investigations, and the synthesis at the end. A claim without
evidence isn't a diagnosis. *"It felt slow"* is not an observation;
`p(95)=1840ms, http_req_failed=32%` is.

## Deliverable 2 — the scar log (`SCARS.md`)

A **scar log** is the permanent, one-screen record of a wound and the lesson it
left — the thing you'd want the *next* on-call engineer to read at 2am. Create a
file `SCARS.md` in your repo with one entry per incident using this template:

```markdown
## OPS-22XX — <one-line title>

- **S — Symptom:** what the user/monitoring saw (with a real number).
- **C — Cause:** the actual mechanism, named precisely (not "it was slow").
- **A — Action:** the exact change you made to fix it.
- **R — Result:** before → after numbers, and the improvement factor.
- **Scar / lesson:** what you now know that you didn't before. What alert or
  dashboard would have caught this *before* a ticket was filed?
- **Evidence:** links to the journal section / commit / screenshot that proves it.
```

Keep each entry tight — a scar log is read in a hurry.

## Deliverable 3 — evidence & fixes in the repo

- **Commit your fixes** (code or config) so I can see the before/after diff.
- Paste raw evidence into the journal: k6 summary blocks, `EXPLAIN ANALYZE`
  plans, `performance_schema.data_locks` / `SHOW ENGINE INNODB STATUS` output,
  `docker stats`, crash/exit log lines.
- Drop Grafana screenshots into an `evidence/` folder and link them.

---

## Ground rules (the evidence culture) 📏

- **Numbers, not adjectives.** Every finding is backed by a metric, a query
  plan, a lock view, or a log line.
- **Baseline before you judge.** Compare every incident to your control group.
- **Name the mechanism.** "Full table scan on an unindexed column," "row-lock
  serialization," "connection-pool queueing," "O(N) memory" — not "the DB was
  unhappy."
- **Show the capacity math.** Estimate the cost/limit yourself (rows examined,
  1/W throughput, Little's Law, MB per payload).
- **Being wrong is progress.** If the evidence kills your hypothesis, write that
  down — it's the most valuable line in your journal.

---

## Definition of done ✅

- [ ] Baseline captured and used as the comparison for every incident.
- [ ] All four incidents reproduced (k6 output pasted).
- [ ] Root cause named with a mechanism + capacity math for each.
- [ ] A fix applied **and re-run**, with before/after numbers, for each.
- [ ] `LAB_JOURNAL.md` fully filled, including the synthesis.
- [ ] `SCARS.md` has all four scar-log entries.
- [ ] Everything committed and pushed to **your own** repo.
- [ ] Repo link shared with me on Slack.

---

## How you'll be assessed

Per incident (roughly): **Hypothesis 10% · Observation/evidence 30% · Root cause
& mechanism (+ capacity math) 35% · Fix & verify 25%.** Plus the quality of your
scar logs and the depth of your post-incident synthesis (ranking blast radius,
the one-fix-before-launch call, and the alert that would have caught it).

The strongest submissions **notice when the "obvious" fix doesn't work** (or
makes something else worse) and follow the evidence to the real bottleneck.

---

## Submission 📤

1. **Make it your own repo.** Either:
   - **Fork** `devBoya/db-capacity-engineering-lab` on GitHub, **or**
   - Clone it, then point it at a new repo of your own:
     ```bash
     git remote remove origin
     # create an empty repo on your GitHub first, then:
     git remote add origin https://github.com/<your-username>/<your-repo>.git
     git add -A && git commit -m "My on-call lab findings"
     git push -u origin main
     ```
2. **Make it visible to me** — set the repo **public**, or add **@devBoya** as a
   collaborator.
3. **Send me on Slack:** the repo link + one line on the single biggest thing
   that surprised you.

**Due:** `<set date/time>`   ·   Questions → post in the group channel.

Good hunting. 🔦
