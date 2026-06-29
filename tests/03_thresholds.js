// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 3 · Thresholds                                            ║
// ║  Concepts: pass/fail gating, SLA enforcement                    ║
// ║  Run: k6 run tests/03_thresholds.js                             ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '20s',

  thresholds: {
    // 95th-percentile response time must be under 500 ms
    'http_req_duration': ['p(95)<2'],

    // Less than 1 % of requests may fail
    'http_req_failed': ['rate<0.01'],
  },
};

export default function () {
  http.get('http://localhost:3000/health');
  sleep(0.5);
}

// ── How to make it PASS → FAIL deliberately ───────────────────────
//
//   Option A – tighter threshold (change 500 → 5 ms)
//     'http_req_duration': ['p(95)<5'],
//
//   Option B – hit a slow endpoint (add artificial delay to server)
//     In server/index.js, inside GET /health, add:
//       await new Promise(r => setTimeout(r, 600));
//
//   When a threshold fails, k6 exits with code 99 (non-zero).
//   This is how CI/CD pipelines gate deployments automatically.
