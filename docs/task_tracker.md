# k6 Learning Project — Task Tracker

## ✅ Phase 1: Setup & Prerequisites (COMPLETED)
- [x] Initialize npm and install express in a `server` directory
- [x] Reorganize files into `server/`, `tests/`, and `data/` directories
- [x] Create `data/users.csv` for parameterization test
- [x] Start target Express server on port 3000

## ✅ Phase 2: Progressive k6 Testing (COMPLETED)
- [x] Task 1: Hello World (`tests/01_hello_world.js`) — VUs, iterations, summary output
- [x] Task 2: Stages (`tests/02_stages.js`) — Ramping load profiles
- [x] Task 3: Thresholds (`tests/03_thresholds.js`) — Pass/fail gating for CI/CD
- [x] Task 4: Checks (`tests/04_checks.js`) — Inline response validation
- [x] Task 5: Auth Flow (`tests/05_auth_flow.js`) — Correlation / request chaining
- [x] Task 6: Parameterization (`tests/06_parameterize.js`) — SharedArray, CSV data
- [x] Task 7a: Baseline profile (`tests/07a_baseline.js`) — Normal load SLA reference
- [x] Task 7b: Spike profile (`tests/07b_spike.js`) — Sudden traffic surge
- [x] Task 7c: Breakpoint profile (`tests/07c_breakpoint.js`) — Find system limits
- [x] Task 7d: Soak profile (`tests/07d_soak.js`) — Memory leaks & drift detection

## ✅ Phase 3: Push to Git (COMPLETED)
- [x] Create clean README.md
- [x] Initialize git repo and push to GitHub
- [x] Repo: https://github.com/Rahul83100/k6-load-testing-lab

## ⏳ Phase 4: Connect MCP to Antigravity (PENDING — Next Session)
- [ ] Configure filesystem MCP server for Antigravity
- [ ] Test MCP tools (read files, list directory, etc.)
- [ ] Use Antigravity + MCP to interactively improve tests and auto-generate scripts

## 🔲 Phase 5: Optional — Grafana Dashboard
- [ ] `docker compose up -d` (requires Docker Desktop)
- [ ] Run a test with `--out influxdb=http://localhost:8086/k6`
- [ ] Import dashboard ID 2587 in Grafana at `http://localhost:3001`
