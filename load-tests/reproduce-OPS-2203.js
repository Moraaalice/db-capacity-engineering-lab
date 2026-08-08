// =============================================================================
// reproduce-OPS-2203.js
// -----------------------------------------------------------------------------
// Reproduces the load conditions described in ticket OPS-2203
// ("Bed admissions failing with database errors during the mass-casualty drill").
//
// This submits many concurrent admissions to the SAME hospital, as happened
// during the drill. Watch throughput and the database error codes it produces.
// Record findings in LAB_JOURNAL.md.
//
// Run:  k6 run load-tests/reproduce-OPS-2203.js
// =============================================================================
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    admissions_surge: {
      executor: 'constant-vus',
      vus: 500,
      duration: '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  const res = http.post(
    `${BASE_URL}/api/hospitals/1/admit`,
    JSON.stringify({}),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(res, { 'status is 200': (r) => r.status === 200 });
}
