// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 7a · Baseline profile                                     ║
// ║  Purpose: normal expected production load → establish SLA        ║
// ║  Run: k6 run tests/07a_baseline.js                              ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 20 },  // ramp to expected daily load
    { duration: '3m', target: 20 },  // hold steady – take your measurements here
    { duration: '30s', target: 0  }, // clean ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<300', 'p(99)<500'],
    'http_req_failed':   ['rate<0.01'],
    'checks':            ['rate==1.0'],
  },
};

export default function () {
  // Full auth flow — same as task 5
  const loginRes = http.post(
    'http://localhost:3000/login',
    JSON.stringify({ username: 'alice', password: 'pass123' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(loginRes, { 'login ok': (r) => r.status === 200 });

  const { token } = JSON.parse(loginRes.body);
  sleep(0.5);

  const profileRes = http.get('http://localhost:3000/profile', {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(profileRes, { 'profile ok': (r) => r.status === 200 });

  sleep(1);
}

// ── What a baseline tells you ─────────────────────────────────────
//
//   Save this result. Every other test type is compared to it:
//     • Spike  → how far do p95 times degrade vs. baseline?
//     • Soak   → do numbers drift upward over time vs. baseline?
//     • Break  → at what VU count does baseline SLA first fail?
//
//   Save results: k6 run --out json=baseline.json 07a_baseline.js
