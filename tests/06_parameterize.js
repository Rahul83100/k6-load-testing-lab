// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 6 · Parameterization                                      ║
// ║  Concepts: SharedArray, CSV data, realistic user simulation      ║
// ║  Run: k6 run tests/06_parameterize.js                           ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';

// SharedArray: parsed ONCE at startup, shared across all VUs
// (much more efficient than each VU re-parsing the CSV)
const users = new SharedArray('users', function () {
  const csv = open('./data/users.csv');
  return papaparse.parse(csv, { header: true, skipEmptyLines: true }).data;
});

export const options = {
  vus: 20,
  duration: '30s',

  thresholds: {
    'http_req_failed':   ['rate<0.01'],
    'http_req_duration': ['p(95)<600'],
    'checks':            ['rate>0.98'],
  },
};

export default function () {
  // Pick a user specific to this VU + iteration (wraps around)
  // __VU = virtual user number, __ITER = iteration count
  const user = users[(__VU - 1 + __ITER) % users.length];

  // Login with a real user from our data file
  const loginRes = http.post(
    'http://localhost:3000/login',
    JSON.stringify({ username: user.username, password: user.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  check(loginRes, {
    'login: status 200': (r) => r.status === 200,
    'login: has token':  (r) => {
      try { return !!JSON.parse(r.body).token; } catch { return false; }
    },
  });

  if (loginRes.status === 200) {
    const { token } = JSON.parse(loginRes.body);
    sleep(0.5);

    const profileRes = http.get('http://localhost:3000/profile', {
      headers: { Authorization: `Bearer ${token}` },
    });

    check(profileRes, {
      'profile: status 200':   (r) => r.status === 200,
      'profile: correct user': (r) => {
        try { return JSON.parse(r.body).username === user.username; } catch { return false; }
      },
    });
  }

  sleep(1);
}

// ── Why parameterize? ─────────────────────────────────────────────
//
//   Real users are NOT all the same person.
//   If every VU logs in as "alice", you're testing a single session,
//   not a realistic population — caches, session stores, and DB
//   queries behave differently under varied load.
//
//   SharedArray: parsed once in a closure, memory-mapped to all VUs.
//   Avoids duplicate work vs. open() inside default function.
//
//   __VU and __ITER are built-in k6 counters — use them to
//   distribute test data across your VU population.
