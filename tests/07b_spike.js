// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 7b · Spike profile                                        ║
// ║  Purpose: sudden traffic surge (promo, viral event, bot attack)  ║
// ║  Run: k6 run tests/07b_spike.js                                 ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 5   }, // normal load
    { duration: '10s', target: 200 }, // ⚡ instant spike
    { duration: '1m',  target: 200 }, // sustained spike
    { duration: '10s', target: 5   }, // back to normal
    { duration: '30s', target: 5   }, // observe recovery
    { duration: '10s', target: 0   }, // done
  ],
  thresholds: {
    // Spike tests often *expect* some degradation – loosen thresholds
    'http_req_duration': ['p(95)<2000'],  // 2 s during spike is ok
    'http_req_failed':   ['rate<0.05'],   // 5 % failure tolerance
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
  sleep(0.5);

  const profileRes = http.get('http://localhost:3000/profile', {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(profileRes, { 'profile ok': (r) => r.status === 200 });

  sleep(1);
}

// ── What to watch ─────────────────────────────────────────────────
//
//   1. Error rate during the spike – does it climb or hold?
//   2. Recovery – does p95 return to baseline after the spike drops?
//      If it doesn't recover, you have a resource leak or stuck thread.
//   3. Max latency – what's the worst single response time?
