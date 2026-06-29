// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 4 · Checks                                                ║
// ║  Concepts: validation, check rate metric                        ║
// ║  Run: k6 run tests/04_checks.js                                 ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 5,
  duration: '15s',

  thresholds: {
    // All checks must pass 100 % of the time
    'checks': ['rate==1.0'],

    'http_req_duration': ['p(95)<500'],
  },
};

export default function () {
  const res = http.get('http://localhost:3000/health');

  // check() returns true/false and records the result in metrics
  check(res, {
    'status is 200':           (r) => r.status === 200,
    'response has status key': (r) => JSON.parse(r.body).status === 'ok',
    'response time < 200ms':   (r) => r.timings.duration < 200,
  });

  sleep(1);
}

// ── Checks vs Thresholds ──────────────────────────────────────────
//
//   check()     → validates a single response right now
//                 Failures are RECORDED but don't stop the test.
//
//   thresholds  → aggregate metric rule evaluated at END of test
//                 Failures cause a non-zero exit code → blocks CI.
//
//   Best practice: check individual responses, then threshold
//   on the check rate:  'checks': ['rate>0.99']
//
//   Watch the summary for a "checks" row showing pass/fail %.
