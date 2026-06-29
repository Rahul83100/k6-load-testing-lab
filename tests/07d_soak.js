// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 7d · Soak profile                                         ║
// ║  Purpose: find memory leaks, degradation over time              ║
// ║  Run: k6 run tests/07d_soak.js   (takes ~35 minutes!)           ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5m',  target: 20 }, // ramp to moderate load
    { duration: '30m', target: 20 }, // HOLD for 30 minutes
    { duration: '2m',  target: 0  }, // ramp down
  ],
  thresholds: {
    // These should stay flat across the 30-min window
    'http_req_duration': ['p(95)<500'],
    'http_req_failed':   ['rate<0.01'],
    'checks':            ['rate>0.99'],
  },
};

export default function () {
  const loginRes = http.post(
    'http://localhost:3000/login',
    JSON.stringify({ username: 'alice', password: 'pass123' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(loginRes, { 'login ok': (r) => r.status === 200 });

  if (loginRes.status !== 200) { sleep(1); return; }

  const { token } = JSON.parse(loginRes.body);
  sleep(1);

  const profileRes = http.get('http://localhost:3000/profile', {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(profileRes, { 'profile ok': (r) => r.status === 200 });

  sleep(2);
}

// ── What soak tests find ──────────────────────────────────────────
//
//   While the test runs, open Activity Monitor (macOS) and watch
//   the Node.js process memory. Signs of a memory leak:
//     • Memory grows steadily over 30 minutes
//     • p95 latency creeps upward even at constant VU count
//     • GC pauses appear as latency spikes every few minutes
//
//   Common causes in Node.js:
//     • Event listeners added but never removed
//     • Closures holding references to large objects
//     • In-memory token/session stores that never evict
//       (our server has this! tokens are cleaned up only via setTimeout)
//
//   Run with JSON output to graph over time:
//   k6 run --out json=soak.json 07d_soak.js
