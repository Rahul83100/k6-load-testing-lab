// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 5 · Auth flow chaining  ★ most important real-world skill ║
// ║  Concepts: correlation, passing data between requests            ║
// ║  Run: k6 run tests/05_auth_flow.js                              ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '20s',

  thresholds: {
    'http_req_failed':   ['rate<0.01'],
    'http_req_duration': ['p(95)<600'],
    'checks':            ['rate==1.0'],
  },
};

export default function () {
  // ── Step 1: Login ─────────────────────────────────────────────────
  const loginRes = http.post(
    'http://localhost:3000/login',
    JSON.stringify({ username: 'alice', password: 'pass123' }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  check(loginRes, {
    'login: status 200':  (r) => r.status === 200,
    'login: has token':   (r) => !!JSON.parse(r.body).token,
  });

  // ── Correlation: extract the token from the response ─────────────
  const { token } = JSON.parse(loginRes.body);

  sleep(0.5); // simulate "think time" between pages

  // ── Step 2: Use the token on the protected endpoint ───────────────
  const profileRes = http.get(
    'http://localhost:3000/profile',
    { headers: { Authorization: `Bearer ${token}` } },
  );

  check(profileRes, {
    'profile: status 200':     (r) => r.status === 200,
    'profile: correct user':   (r) => JSON.parse(r.body).username === 'alice',
  });

  sleep(1);
}

// ── Why "correlation" matters ─────────────────────────────────────
//
//   Every real app has state: login → session → action → logout.
//   If you only test individual endpoints in isolation you miss:
//     • Token expiry / session management issues
//     • Cascade failures (login slow → everything slow)
//     • Race conditions between requests
//
//   This pattern (extract token → attach to next request) is the
//   foundation of all real-world load test scripts.
