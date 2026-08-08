// =============================================================================
// reproduce-OPS-2202.js
// -----------------------------------------------------------------------------
// Reproduces the load conditions described in ticket OPS-2202
// ("Whole app freezes during registration surges — but the database looks idle").
//
// This drives a large, sudden burst of traffic at a lightweight endpoint. Note
// that the query itself is trivial. Investigate where the time actually goes.
// Record findings in LAB_JOURNAL.md.
//
// Run:  k6 run load-tests/reproduce-OPS-2202.js
// =============================================================================
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    registration_surge: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 2000 },
        { duration: '25s', target: 2000 },
      ],
      gracefulStop: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/patients/recent`);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
