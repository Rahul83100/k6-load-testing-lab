// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 7c · Breakpoint (stress) profile                          ║
// ║  Purpose: find the VU count at which the system fails           ║
// ║  Run: k6 run tests/07c_breakpoint.js                            ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  // Ramp up relentlessly until something breaks
  stages: [
    { duration: '2m',  target: 50  },
    { duration: '2m',  target: 100 },
    { duration: '2m',  target: 200 },
    { duration: '2m',  target: 400 },
    { duration: '2m',  target: 600 },
    // Beyond this Node.js single-threaded will likely buckle
    { duration: '30s', target: 0   },
  ],
  // No strict thresholds here – we WANT to find the break point
  thresholds: {
    'http_req_failed': ['rate<0.50'], // stop if 50 % of requests fail
  },
};

export default function () {
  const loginRes = http.post(
    'http://localhost:3000/login',
    JSON.stringify({ username: 'alice', password: 'pass123' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(loginRes, { 'login ok': (r) => r.status === 200 });

  if (loginRes.status !== 200) { sleep(0.5); return; }

  const { token } = JSON.parse(loginRes.body);

  const profileRes = http.get('http://localhost:3000/profile', {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(profileRes, { 'profile ok': (r) => r.status === 200 });

  sleep(0.5);
}

// ── Reading the breakpoint ────────────────────────────────────────
//
//   Watch the LIVE output (--verbose or check the rolling avg).
//   The breakpoint is when:
//     • http_req_failed starts climbing above 1 %
//     • OR iteration_duration > 5 s (requests queuing)
//     • OR the server process crashes
//
//   This single VU number becomes your hard capacity limit.
//   Autoscaling rules should trigger BEFORE this number.
