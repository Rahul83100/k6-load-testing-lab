// ╔══════════════════════════════════════════════════════════════════╗
// ║  TASK 2 · Stages / load profiles                                ║
// ║  Concepts: ramping VUs, warm-up, cool-down                      ║
// ║  Run: k6 run tests/02_stages.js                                 ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 0  }, // start: 0 VUs (already the default, but explicit)
    { duration: '20s', target: 50 }, // ramp UP   → 50 VUs over 20 s
    { duration: '30s', target: 50 }, // hold at 50 VUs for 30 s (steady state)
    { duration: '10s', target: 0  }, // ramp DOWN → 0 VUs (graceful shutdown)
  ],
};

export default function () {
  http.get('http://localhost:3000/health');
  sleep(1);
}

// ── Why stages matter ─────────────────────────────────────────────
//
//   Without a ramp-up, all VUs hammer the server simultaneously the
//   instant the test starts — you won't know if failures are
//   architectural or just a cold-start spike.
//
//   Watch in the k6 output:
//     vus_max   → peak reached
//     iteration_duration → does it increase during the hold phase?
//
//   Next step: Change target: 50 → target: 200 and see where
//   the server starts struggling.
