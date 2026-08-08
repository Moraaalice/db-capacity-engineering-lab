// =============================================================================
// reproduce-OPS-2204.js
// -----------------------------------------------------------------------------
// Reproduces the load conditions described in ticket OPS-2204
// ("Nightly export keeps crashing the service; on-call paged for restarts").
//
// This repeatedly calls the analytics export endpoint the way the nightly ETL
// job does. Keep an eye on the service's memory and restart behaviour while it
// runs. Record findings in LAB_JOURNAL.md.
//
// Run:  k6 run load-tests/reproduce-OPS-2204.js
// =============================================================================
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    nightly_export: {
      executor: 'constant-vus',
      vus: 50,
      duration: '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/patients/export`, { timeout: '120s' });
  check(res, { 'status is 200': (r) => r.status === 200 });
}
