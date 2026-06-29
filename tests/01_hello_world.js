// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 1 · Hello world                                           ║
// ║  Concepts: VUs, iterations, summary output                      ║
// ║  Run: k6 run tests/01_hello_world.js                            ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { sleep } from 'k6';

// Options block = how k6 behaves
export const options = {
  vus: 5,          // 5 virtual users running concurrently
  duration: '10s', // run for 10 seconds total
};

// Default function = one "iteration" per VU
export default function () {
  const res = http.get('http://localhost:3000/health');

  // Log status code so you can see it while running
  console.log(`status: ${res.status} | body: ${res.body}`);

  sleep(1); // each VU pauses 1s between iterations
}

// ── What to look for in the summary output ────────────────────────
//
//   http_req_duration  ← response time percentiles (p90, p95, p99)
//   http_reqs          ← total requests made + rate (req/s)
//   vus                ← how many VUs were active
//   iterations         ← total loop executions
//   http_req_failed    ← failed request ratio (should be 0)
//
// Try changing vus: 1 → 20 and watch the numbers change.
