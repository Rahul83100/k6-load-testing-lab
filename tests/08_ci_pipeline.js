// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 8 · CI Pipeline Performance Gate                          ║
// ║  Concepts: custom metrics, CI thresholds, handleSummary         ║
// ║  Run: k6 run tests/08_ci_pipeline.js                           ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Counter, Rate } from 'k6/metrics';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// ── Custom Metrics ────────────────────────────────────────────────
//
// Why custom metrics matter in CI:
//
//   Built-in http_req_duration lumps ALL endpoints together.  A slow
//   /login might be masked by a fast /health check in the aggregate.
//   Custom metrics let you set per-endpoint SLOs so a regression in
//   ANY critical path fails the pipeline — not just the average.
//
//   login_duration   – Tracks POST /login latency independently.
//                      Login is the gateway to every authenticated
//                      flow; if it regresses, ALL users feel it.
//
//   profile_duration – Tracks GET /profile latency independently.
//                      This is the most-hit authenticated endpoint;
//                      its p95 directly maps to user-perceived speed.
//
//   auth_flow_success – Rate of COMPLETE login→profile flows.
//                       Partial failures (login OK but profile 401)
//                       indicate token / session bugs that a simple
//                       error-rate metric would miss.
//
//   total_auth_flows  – Raw count of completed flows.  Useful for
//                       comparing throughput across builds to detect
//                       concurrency regressions.

const loginDuration   = new Trend('login_duration', true);
const profileDuration = new Trend('profile_duration', true);
const authFlowSuccess = new Rate('auth_flow_success');
const totalAuthFlows  = new Counter('total_auth_flows');

// ── Parameterized Users ───────────────────────────────────────────
// SharedArray: parsed ONCE at startup, shared across all VUs.
// This avoids each VU re-parsing the CSV and wasting memory.
const users = new SharedArray('users', function () {
  const csv = open('./data/users.csv');
  return papaparse.parse(csv, { header: true, skipEmptyLines: true }).data;
});

// ── Options ───────────────────────────────────────────────────────
//
// CI-optimized: 60 seconds total (ramp 15s → hold 30s → ramp 15s).
// Short enough to keep pipelines fast, long enough to surface
// latency spikes and concurrency bugs.
export const options = {
  stages: [
    { duration: '15s', target: 20 },  // ramp up — stress connection pooling
    { duration: '30s', target: 20 },  // hold    — sustained load reveals leaks
    { duration: '15s', target: 0 },   // ramp down — graceful drain
  ],

  // ── STRICT CI Thresholds ──────────────────────────────────────
  //
  // These are pass/fail gates.  If ANY threshold is breached, k6
  // exits with code 99 and the GitHub Actions step fails.
  //
  //   http_req_duration p(95)<300  – 95th percentile must stay under
  //     300 ms.  This covers "most users" experience.
  //   http_req_duration p(99)<500  – 99th percentile under 500 ms.
  //     Catches tail-latency outliers that degrade UX.
  //   http_req_failed rate<0.01   – Less than 1 % of requests may
  //     fail.  Any higher indicates a stability problem.
  //   checks rate>0.99            – 99 %+ of assertions must pass.
  //     This catches logical bugs (wrong body, missing fields).
  //
  //   login_duration p(95)<200    – Login must be snappy; it blocks
  //     every subsequent request in the flow.
  //   profile_duration p(95)<200  – Profile is the primary
  //     authenticated call; users stare at this spinner.
  thresholds: {
    'http_req_duration': ['p(95)<300', 'p(99)<500'],
    'http_req_failed':   ['rate<0.01'],
    'checks':            ['rate>0.99'],
    'login_duration':    ['p(95)<200'],
    'profile_duration':  ['p(95)<200'],
  },
};

// ── Main Test Function ────────────────────────────────────────────
export default function () {
  // Pick a user specific to this VU + iteration (wraps around).
  // This ensures realistic distribution — no single-user hotspot.
  const user = users[(__VU - 1 + __ITER) % users.length];

  let flowSucceeded = false;

  // ── Step 1: Login ─────────────────────────────────────────────
  const loginRes = http.post(
    'http://localhost:3000/login',
    JSON.stringify({ username: user.username, password: user.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  // Record login-specific latency in our custom Trend
  loginDuration.add(loginRes.timings.duration);

  const loginOk = check(loginRes, {
    'login: status 200': (r) => r.status === 200,
    'login: has token':  (r) => {
      try { return !!JSON.parse(r.body).token; } catch { return false; }
    },
  });

  // ── Step 2: Extract token → call protected endpoint ───────────
  if (loginOk) {
    const { token } = JSON.parse(loginRes.body);
    sleep(0.3); // brief think time — keeps the test fast for CI

    const profileRes = http.get('http://localhost:3000/profile', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Record profile-specific latency in our custom Trend
    profileDuration.add(profileRes.timings.duration);

    const profileOk = check(profileRes, {
      'profile: status 200':   (r) => r.status === 200,
      'profile: correct user': (r) => {
        try { return JSON.parse(r.body).username === user.username; } catch { return false; }
      },
    });

    // A flow is successful ONLY if both login AND profile passed
    flowSucceeded = profileOk;
  }

  // ── Record end-to-end flow metrics ────────────────────────────
  authFlowSuccess.add(flowSucceeded);
  totalAuthFlows.add(1);

  sleep(0.5);
}

// ── Custom Summary (CI artifact) ──────────────────────────────────
//
// handleSummary runs ONCE after the test.  We:
//   1. Print the standard k6 text summary to stdout (for logs)
//   2. Write a structured JSON file for CI artifact archiving
//
// The JSON output can be consumed by dashboards, Slack bots, or
// GitHub Action summary steps to surface results without log diving.
export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
    'summary.json': JSON.stringify(data, null, 2),
  };
}

// ── Why a CI-specific test? ───────────────────────────────────────
//
//   Production load tests (soak, spike, breakpoint) run for minutes
//   to hours.  CI needs a FAST feedback loop — 60 seconds max —
//   with STRICT thresholds that act as an automated quality gate.
//
//   If this test fails, the PR is blocked.  That forces teams to
//   treat performance regressions with the same urgency as broken
//   unit tests.
//
//   Custom metrics (login_duration, profile_duration, auth_flow_success)
//   give granular signal that aggregate metrics hide.  A 5 % slowdown
//   in /login is invisible in the global p95 but clearly visible in
//   login_duration.
