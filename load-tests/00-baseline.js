// =============================================================================
// 00-baseline.js  —  Steady-state baseline
// -----------------------------------------------------------------------------
// Run this FIRST, on a healthy system, to capture "known good" numbers
// (throughput, p95 latency, error rate). Every incident investigation compares
// against this baseline. This is not an incident — it's your control group.
//
// Run:  k6 run load-tests/00-baseline.js
//       k6 run -e BASE_URL=http://localhost:3000 load-tests/00-baseline.js
// =============================================================================
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    baseline: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/patients/recent`);
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
