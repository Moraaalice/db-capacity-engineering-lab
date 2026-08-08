// =============================================================================
// reproduce-OPS-2201.js
// -----------------------------------------------------------------------------
// Reproduces the load conditions described in ticket OPS-2201
// ("Patient name search unusably slow at shift change").
//
// This recreates a shift-change burst of staff all looking a patient up by
// last name at once. Run it, then investigate WHY it behaves the way it does
// (Grafana, EXPLAIN, DB internals). Record findings in LAB_JOURNAL.md.
//
// Run:  k6 run load-tests/reproduce-OPS-2201.js
// =============================================================================
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    shift_change_search: {
      executor: 'constant-vus',
      vus: 200,
      duration: '30s',
    },
  },
  thresholds: {
    // The SLO the team expects to hold. Does it?
    http_req_duration: ['p(95)<300'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/patients/search?lastName=Smith`);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
