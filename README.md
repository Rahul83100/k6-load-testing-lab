[![Performance Gate](https://github.com/Rahul83100/k6-load-testing-lab/actions/workflows/performance.yml/badge.svg)](https://github.com/Rahul83100/k6-load-testing-lab/actions/workflows/performance.yml)

# k6 Load Testing — Performance Testing Lab

A hands-on project to learn **k6 load testing** from zero to advanced. Includes a Node.js/Express target API and 10 progressive test scripts covering every core k6 concept.

---

## Project Structure

```
k6_learning/
├── .github/
│   └── workflows/
│       └── performance.yml  # CI/CD performance gate
├── server/
│   ├── index.js            # Express API (target app)
│   └── package.json
├── tests/
│   ├── data/
│   │   └── users.csv       # Test data for parameterization
│   ├── 01_hello_world.js   # VUs, iterations, summary output
│   ├── 02_stages.js        # Ramping load profiles
│   ├── 03_thresholds.js    # Pass/fail gating (CI/CD)
│   ├── 04_checks.js        # Response validation
│   ├── 05_auth_flow.js     # Correlation / request chaining
│   ├── 06_parameterize.js  # SharedArray, CSV test data
│   ├── 07a_baseline.js     # Baseline — normal load
│   ├── 07b_spike.js        # Spike — sudden traffic surge
│   ├── 07c_breakpoint.js   # Breakpoint — find system limits
│   ├── 07d_soak.js         # Soak — memory leak detection
│   └── 08_ci_pipeline.js   # CI/CD performance gate script
├── docs/
│   └── PERFORMANCE_INSIGHTS.md  # PM performance testing guide
└── docker-compose.yml      # Grafana + InfluxDB (optional)
```

---

## Quick Start

### Prerequisites

```bash
brew install node k6
```

### 1. Start the target server

```bash
cd server
npm install
node index.js
# → 🚀 Target app listening on http://localhost:3000
```

### 2. Run the tests (in a new terminal)

```bash
k6 run tests/01_hello_world.js    # Task 1 – VUs, iterations
k6 run tests/02_stages.js         # Task 2 – Load ramping
k6 run tests/03_thresholds.js     # Task 3 – Pass/fail gates
k6 run tests/04_checks.js         # Task 4 – Response validation
k6 run tests/05_auth_flow.js      # Task 5 – Auth correlation ★
k6 run tests/06_parameterize.js   # Task 6 – CSV data driving
k6 run tests/07a_baseline.js      # Task 7a – Baseline profile
k6 run tests/07b_spike.js         # Task 7b – Spike profile
k6 run tests/07c_breakpoint.js    # Task 7c – Stress to failure
k6 run tests/07d_soak.js          # Task 7d – Endurance (30 min)
k6 run tests/08_ci_pipeline.js    # Task 8  – CI/CD gate (strict)
```

---

## Target API Endpoints

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/health` | GET | No | Returns `{ status, timestamp, uptime }` |
| `/login` | POST | No | Accepts `{ username, password }` → returns `{ token }` |
| `/profile` | GET | Bearer token | Returns `{ username, email, role }` |

**Test users**: `alice/pass123`, `bob/pass456`, `carol/pass789`, `dave/pass000`, `eve/pass111`, `frank/pass222`, `grace/pass333`, `henry/pass444`, `iris/pass555`, `jack/pass666`

---

## What Each Task Teaches

| Task | Concept | Why It Matters |
|------|---------|----------------|
| 01 | **VUs & Iterations** | Understand how k6 runs concurrent users in loops |
| 02 | **Stages** | Simulate realistic ramp-up → hold → ramp-down traffic patterns |
| 03 | **Thresholds** | Automate pass/fail decisions — exit code 99 blocks CI/CD pipelines |
| 04 | **Checks** | Validate individual responses (status, body, timing) during the test |
| 05 | **Correlation** | Extract dynamic tokens from responses and chain requests — the foundation of real-world scripts |
| 06 | **Parameterization** | Use `SharedArray` + CSV to distribute unique users across VUs efficiently |
| 07a | **Baseline** | Establish normal-load SLA metrics as a reference for all other test types |
| 07b | **Spike** | Test sudden traffic surges — does the system recover after the spike drops? |
| 07c | **Breakpoint** | Ramp until failure — find the exact VU count where SLAs break |
| 07d | **Soak** | Run for 30+ minutes at steady load — detect memory leaks and latency drift |
| 08 | **CI/CD Gate** | Automate pass/fail in GitHub Actions — exit code 99 blocks deploys |

---

## CI/CD Performance Gate

Every push to `main` runs an automated performance gate via GitHub Actions:

- ✅ Starts the Express server
- ✅ Runs `08_ci_pipeline.js` with strict SLA thresholds
- ✅ Blocks the merge if p95 > 300ms or error rate > 1%
- ✅ Tracks custom metrics: `login_duration`, `profile_duration`, `auth_flow_success`

The pipeline uses k6's exit code 99 behavior — if any threshold fails, the workflow fails, and the PR cannot merge.

See [Performance Insights](docs/PERFORMANCE_INSIGHTS.md) for the full analysis of all 4 load test profiles.

---

## Performance Budget

| Metric | Budget | Business Reason |
|--------|--------|------------------|
| p(95) response time | < 300ms | Users abandon pages after 3s; API calls chain 3-5 deep |
| p(99) response time | < 500ms | Tail latency affects your most engaged users |
| Error rate | < 1% | Each error = potential data loss or broken user flow |
| Auth flow success | > 99% | Login failures = immediate churn |

---

## Key Metrics to Watch

| Metric | What It Tells You |
|--------|--------------------|
| `http_req_duration` (p95, p99) | Response time — focus on percentiles, not averages |
| `http_req_failed` | Error rate — should be < 1% under normal load |
| `checks` | Pass rate of inline assertions |
| `http_reqs` | Total requests + throughput (req/s) |
| `iterations` | How many times the default function executed |
| `vus` / `vus_max` | Active / peak virtual users |

---

## Useful k6 Flags

```bash
k6 run --vus 50 --duration 30s tests/01_hello_world.js   # Override options
k6 run --out json=results.json tests/05_auth_flow.js      # Save raw metrics
k6 run --http-debug tests/05_auth_flow.js                 # Log every request/response
```

---

## Optional: Grafana Dashboard

```bash
# Requires Docker Desktop
docker compose up -d

# Run any test with InfluxDB output
k6 run --out influxdb=http://localhost:8086/k6 tests/05_auth_flow.js

# Open Grafana at http://localhost:3001
# Import dashboard ID 2587 (official k6 dashboard)
```

---

## Tech Stack

- **Target App**: Node.js + Express
- **Load Testing**: [k6](https://k6.io/) by Grafana Labs
- **Visualization**: Grafana + InfluxDB (optional)
- **CI/CD**: GitHub Actions with k6 threshold gating
