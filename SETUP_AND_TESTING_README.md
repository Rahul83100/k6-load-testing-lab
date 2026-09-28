# 🚀 System Setup, Package Installation & k6 Performance Testing Guide

> **Target Audience**: Antigravity AI Agent & Performance Engineers  
> **Repository**: [https://github.com/Rahul83100/k6-load-testing-lab](https://github.com/Rahul83100/k6-load-testing-lab)  
> **Project Context**: Christ University (Centre for Digital Innovation - CDI) — Student ERP (ESPRO) Portal Load, Stress & Observability Testing  
> **Guide / Stakeholder**: Abhi Sir (Project Guide)  
> **Author / Intern**: Rahul R (Register No: 2440166, 5th Year BSc CM)  

---

## 🤖 Instructions for Antigravity AI (New System Startup Prompt)

> [!IMPORTANT]
> **Dear Antigravity AI on the New System**:
> When you are opened in this workspace, follow these mandatory initialization steps:
> 1. Run terminal verification: `node -v`, `npm -v`, `k6 version`, `git status`.
> 2. If `k6` or `node` are missing, consult the [Software & Package Installation](#-software--package-installation-all-operating-systems) section below and guide/execute their installation.
> 3. Verify that dependencies in `server/` are installed (`cd server && npm install`).
> 4. We are testing **Christ University's ESPRO Student Portal** and conducting **Load Testing**, **Stress Testing**, **Breakpoint Analysis**, and **End-to-End Student Journeys**.
> 5. Use the [Production Credentials](#-production-credentials--authentication) and [Production URLs](#-production-urls--target-systems) below. Remember that ESPRO uses **RFC 9449 DPoP + PKCE OAuth tokens** that expire in 300 seconds (5 minutes). Always run `node prep_student_sessions.js` before executing authenticated tests!

---

## 📋 Executive Summary: What, Who & Why We Are Testing

### 1. Who We Are Testing For
- **Organization**: **Christ University (Bengaluru, India)**
- **Department**: **Centre for Digital Innovation (CDI)** / University IT Infrastructure
- **Project Guide**: **Abhi Sir**
- **Test Engineer / Author**: **Rahul R** (Register No: `2440166`)

### 2. What We Are Testing
- **Primary System Under Test (SUT)**: **Christ University Student ERP System (ESPRO)** and **Knowledge Pro (KP)**.
- **Frontend Portals**: React-based ESPRO web application (`https://cue.christuniversity.in` & `https://espro.christuniversity.in:444`).
- **Backend APIs**: High-throughput REST API server (`https://espro.christuniversity.in:84`) handling student dashboard, timetable, attendance logs, and profile records.
- **Identity & Access Management**: Keycloak OAuth 2.0 / OIDC server (`https://studentespro.christuniversity.in:8010`).
- **Cloud Infrastructure**: AWS S3 public bucket hosting maintenance status and configuration files.
- **Secondary Local Target**: Embedded Node.js/Express mock server (`server/index.js`) for progressive k6 methodology training (Tasks 1–8).

### 3. Nature of Testing Being Conducted
We are executing high-impact performance engineering protocols:
- 🔥 **Stress Testing**: Pushing concurrency beyond standard thresholds to detect service degradation, thread pool exhaustion, and connection timeouts.
- ⚡ **Load & Concurrency Testing**: Simulating realistic student behavior (5 to 100+ concurrent Virtual Users) during peak hours (e.g., morning attendance checks and timetable lookups).
- 💥 **Breakpoint Testing**: Continually ramping load to determine the exact breaking point (capacity ceiling) where error rates climb above 1% or latency exceeds acceptable SLAs.
- 🌊 **Spike Testing**: Testing resilience against sudden surges of traffic (e.g., immediate release of examination or attendance records).
- ⏳ **Soak / Endurance Testing**: Running prolonged tests (30+ minutes) to catch memory leaks, connection leaks, and latency drift.
- 🧭 **HAR-Driven Student Journey Simulation**: Complete multi-step workflows replay extracted directly from real student browser recordings (`Testing_api's.har`).

---

## 🌐 Production URLs & Target Systems

The university portal architecture operates across 5 interconnected network tiers:

| Tier / Role | URL / Endpoint | Port | Description |
| :--- | :--- | :--- | :--- |
| **ESPRO Web Portal (Primary)** | `https://cue.christuniversity.in/` | `443` | Main student web frontend |
| **ESPRO Web Portal (Alt)** | `https://espro.christuniversity.in:444` | `444` | Direct HTTPS ERP web frontend |
| **ESPRO API Backend** | `https://espro.christuniversity.in:84` | `84` | REST APIs for profile, attendance, timetable, etc. |
| **Keycloak Auth Server** | `https://studentespro.christuniversity.in:8010` | `8010` | Issues OAuth 2.0 tokens (Realm: `Student`) |
| **Keycloak Realm Path** | `https://studentespro.christuniversity.in/auth/realms/Student` | `443/8010` | Keycloak OpenID Connect discovery & token endpoints |
| **Knowledge Pro (KP Legacy)** | `https://kp.christuniversity.in` | `443` | Legacy portal handling initial login & verification |
| **AWS Cloud S3 Config** | `https://prod-espro-public.s3.ap-south-1.amazonaws.com` | `443` | Maintenance status (`/Maintenance/status.json`) |

---

## 🔑 Production Credentials & Authentication

> [!CAUTION]
> These credentials represent real student test accounts provisioned for university load and stress testing. Handle with care.

### 1. Active Student Credentials (`tests/data/students.csv`)

| Student Name | Register No (Username) | Password | Role / Account Details |
| :--- | :--- | :--- | :--- |
| **Rahul R** *(Primary Lead)* | `2440166` | `55198823` | 5th Year BSc CM / Lead Performance Tester |
| **Student 2** | `2440101` | `41725298` | Active Student Session Pool |
| **Student 3** | `2441536` | `19468049` | Active Student Session Pool |
| **Student 4** | `2440104` | `16452341` | Active Student Session Pool |
| **Student 5** | `2440156` | `90893033` | Active Student Session Pool |

### 2. Local Training Lab Credentials (For `server/index.js` mock testing)
For tests `01_hello_world.js` through `08_ci_pipeline.js`:
- `alice` / `pass123`
- `bob` / `pass456`
- `carol` / `pass789`
- `dave` / `pass000`
- `eve` / `pass111`
- `frank` / `pass222`
- `grace` / `pass333`
- `henry` / `pass444`
- `iris` / `pass555`
- `jack` / `pass666`

### 3. Understanding the Authentication Mechanics (RFC 9449 DPoP)
- **Token Type**: Bearer token secured via **RFC 9449 DPoP** (Demonstrating Proof-of-Possession at Application Layer) with **PKCE S256**.
- **Token Lifespan**: Exactly **300 seconds (5 minutes)**.
- **Automated Ingestion**: `tests/christ_university/helpers/direct_student_auth.js` automatically creates an ephemeral ECDSA P-256 keypair, completes the Keycloak PKCE challenge, signs DPoP HTTP proofs, and extracts the tokens.
- **Session Precomputation**: Running `node prep_student_sessions.js` signs DPoP proofs for every endpoint across all 5 students and saves them into `tests/data/active_tokens.json`.

---

## 💻 Software & Package Installation (All Operating Systems)

Follow the instructions for the operating system of the new machine:

### 1. macOS Setup (Recommended)

#### A. Install Homebrew (if not already installed)
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

#### B. Install k6
```bash
brew install k6
```

#### C. Install Node.js (LTS v20+) & Git
```bash
brew install node git
```

#### D. Install Python 3 (For Grafana dashboard automation)
```bash
brew install python3
```

#### E. (Optional) Install Docker Desktop (For Grafana + InfluxDB)
```bash
brew install --cask docker
```

---

### 2. Linux Setup (Ubuntu / Debian)

#### A. Install k6 via Official Grafana GPG Repository
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install -y k6
```

#### B. Install Node.js (v20 LTS via NodeSource) & Build Tools
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential python3 python3-pip
```

#### C. (Optional) Install Docker & Docker Compose
```bash
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
```

---

### 3. Windows Setup (PowerShell as Administrator)

#### A. Install k6 via WinGet or Chocolatey
```powershell
# Option 1: Via WinGet (Built into Windows 10/11)
winget install k6 --source winget

# Option 2: Via Chocolatey
choco install k6
```

#### B. Install Node.js LTS, Git & Python
```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Python.Python.3.12
```

---

### 4. Verify All Installations
Run these verification commands in your terminal:
```bash
node -v       # Should output v18.x or v20.x+
npm -v        # Should output 9.x or 10.x+
k6 version    # Should output k6 v0.48.0 or higher
git --version # Should output git version 2.x+
```

---

## 📦 Project Setup & Dependency Installation

Clone the repository and install all required local server dependencies:

```bash
# 1. Clone repository
git clone https://github.com/Rahul83100/k6-load-testing-lab.git
cd k6-load-testing-lab   # or your workspace folder name: k6_learning

# 2. Install mock server dependencies
cd server
npm install
cd ..

# 3. Verify student CSV credentials exist
cat tests/data/students.csv

# 4. Create reports folder if not present
mkdir -p tests/christ_university/reports
```

> [!NOTE]
> Root scripts (`prep_student_sessions.js`, `run_multi_student_test.js`, and `direct_student_auth.js`) use Node.js built-in standard modules (`crypto`, `https`, `fs`, `path`, `url`, `child_process`). No external root `npm install` is required!

---

## 🎯 How to Run the Tests (Complete Playbook)

### Phase 1: Christ University ESPRO Live & Stress Testing

#### Step 1: Pre-authenticate & Generate DPoP Tokens (Required First)
Authenticate all 5 students against Keycloak and compute cryptographic DPoP proofs:
```bash
node prep_student_sessions.js
```
*Expected Output*: `🎉 5/5 Students Logged In Successfully!` and `Session data written to tests/data/active_tokens.json`.

---

#### Step 2: Run the Full Student Journey Load & Stress Test (HAR-derived)
Simulates complete student navigation (Dashboard → Profile → Timetable → Semester Attendance → Course breakdown → Per-day logs):
```bash
k6 run tests/christ_university/12_har_full_student_journey_load_test.js
```
- **HTML Report Saved At**: `tests/christ_university/reports/har_journey_load_report.html`
- **JSON Summary Saved At**: `tests/christ_university/reports/har_journey_load_summary.json`

---

#### Step 3: Automated Multi-Student Concurrency Test (5 Real Users)
Logs in all 5 students and immediately runs concurrent multi-student traffic:
```bash
node run_multi_student_test.js
```
- **HTML Report Saved At**: `tests/christ_university/reports/multi_student_load_report.html`

---

#### Step 4: Run the Non-Destructive Live Demo Runner (One-Click)
Used for presenting live test results to project guides (Abhi Sir):
```bash
# On macOS / Linux
./run_live_demo.sh

# Or directly via k6
k6 run tests/christ_university/demo_safe_live_test.js
```
- **HTML Report Saved At**: `tests/christ_university/reports/live_demo_report.html`

---

#### Step 5: Direct Single-Student Keycloak Login Validation
Validates whether direct OAuth ROPC authentication succeeds for an account:
```bash
PORTAL_USERNAME="2440166" PORTAL_PASSWORD="yourpassword" k6 run tests/christ_university/test_direct_login.js
```

---

### Phase 2: Local Progressive Learning Lab (Tasks 1 to 8)

To run the progressive k6 performance testing suite against the local Express server:

#### 1. Start the Local Mock Server (Terminal 1)
```bash
cd server
node index.js
# → 🚀 Target app listening on http://localhost:3000
```

#### 2. Execute Progressive k6 Scripts (Terminal 2)
```bash
# Task 1: Basic VUs & Iterations
k6 run tests/01_hello_world.js

# Task 2: Linear Stage Ramping (0 -> 50 -> 0 VUs)
k6 run tests/02_stages.js

# Task 3: Thresholds & Automated SLA Pass/Fail Gating
k6 run tests/03_thresholds.js

# Task 4: Inline Checks & Assertions
k6 run tests/04_checks.js

# Task 5: Auth Correlation & Token Chaining (Login -> Profile)
k6 run tests/05_auth_flow.js

# Task 6: CSV Parameterization with SharedArray
k6 run tests/06_parameterize.js

# Task 7a: Baseline Profile (Establish normal load SLAs)
k6 run tests/07a_baseline.js

# Task 7b: Spike Profile (5 -> 200 VUs sudden surge)
k6 run tests/07b_spike.js

# Task 7c: Breakpoint / Stress Profile (50 -> 600 VUs to failure)
k6 run tests/07c_breakpoint.js

# Task 7d: Soak / Endurance Profile (30+ minutes memory leak check)
k6 run tests/07d_soak.js

# Task 8: Strict CI/CD Performance Gate (Exit code 99 blocks PRs)
k6 run tests/08_ci_pipeline.js
```

---

---

### Phase 3: JMeter-Style Live Visual Observability (Grafana + InfluxDB)

> [!IMPORTANT]
> **No Static HTML Files Needed!**  
> Because team members and stakeholders in the organization are familiar with **Apache JMeter**, our Grafana stack has been customized to provide an exact **1:1 visual replica of JMeter's core listeners**:
> 1. **JMeter Aggregate Report Table** (Per-sampler Samples, Avg, Median, 90% Line, 95% Line, 99% Line, Min, Max, Error %, Throughput)
> 2. **JMeter View Results Tree (Failed APIs Inspector)**: Shows **each and every API that failed**, its HTTP error code (401, 404, 500, etc.), failure count, and root-cause diagnosis.
> 3. **JMeter Active Threads Over Time** (Virtual Users concurrency curve)
> 4. **JMeter Response Times Over Time** (Per-endpoint latency trends)
> 5. **JMeter Transactions Per Second (TPS)** (Passed 2xx vs Failed 4xx/5xx requests/sec)
> 6. **Failed Requests Timeline by API** (Pinpoint exact seconds when specific APIs broke)

#### 1. One-Click Automated Stack Launch
Both the InfluxDB datasource and the JMeter-Style Dashboard are **fully auto-provisioned**. You do NOT need to manually configure datasources or import JSON files!

```bash
# Start InfluxDB (8086) and pre-configured Grafana (3002) in the background
docker compose up -d
```

#### 2. Run Any Test with Live Streaming to the JMeter Dashboard
Simply append `--out influxdb=http://localhost:8086/k6` to your test command:

```bash
# A. Authenticate real student accounts (Required first)
node prep_student_sessions.js

# B. Stream HAR Full Student Journey Load/Stress Test directly into the JMeter Dashboard:
k6 run --out influxdb=http://localhost:8086/k6 tests/christ_university/12_har_full_student_journey_load_test.js

# C. Stream Multi-Student Concurrency Test:
k6 run --out influxdb=http://localhost:8086/k6 tests/christ_university/11_multi_student_load_test.js

# D. Stream Breakpoint / Stress Test (50 -> 600 VUs to failure):
k6 run --out influxdb=http://localhost:8086/k6 tests/07c_breakpoint.js
```

#### 3. Access the JMeter Dashboard in Your Browser
- **URL**: [http://localhost:3002](http://localhost:3002)
- **Login**: Anonymous Admin is enabled (no password required, or `admin`/`admin`)
- **Dashboard Location**: Navigate to **Dashboards** → **Christ University Load Testing** → **Christ University Portal — JMeter-Style Performance Dashboard**

---

## 🔍 How to Inspect Failed APIs & Errors in the JMeter Dashboard

When running heavy stress tests or when tokens expire, you need to see **which API failed and why it failed**. The dashboard provides two dedicated diagnostic panels:

### 1. Panel: `🚨 Failed APIs & Error Breakdown (JMeter View Results Tree)`
A real-time diagnostic table that groups all HTTP failures:
- **API Endpoint / Sampler**: The exact API that encountered an error (e.g., `getStudentTimetable`, `getCourseWiseAttendance`, `getStudentProfileData`).
- **HTTP Status Code**: 
  - `401 Unauthorized` → JWT expired (exceeded 300s) or invalid DPoP proof.
  - `404 Not Found` → Known endpoint bug (e.g., `/getThemes`).
  - `500 / 502 / 503 / 504` → Server backend crash, thread pool exhaustion, or gateway timeout under load.
  - `0 Timeout` → Network drop or request exceeded timeout limit.
- **Root-Cause Diagnosis**: Automated error description indicating whether the failure was an authentication expiry, server overload, or assertion check failure.
- **Total Failure Count**: Count of failed requests for that specific API.

### 2. Panel: `⏱️ Failed Requests Timeline by API (Errors/sec)`
A time-series graph plotting error spikes per endpoint. This allows you to correlate:
- Did errors start when Active Threads reached 50 VUs? (Capacity ceiling hit)
- Did all endpoints turn 401 at the 5-minute mark? (Token expired)
- Did only a specific database-heavy API (like `getCourseWiseAttendance`) fail while others passed? (Database bottleneck)

### 3. Re-generating or Customizing the Dashboard
If you ever want to regenerate or adjust the dashboard programmatically:
```bash
python3 grafana_gen.py
```
This updates both `grafana/dashboards/jmeter_style_dashboard.json` and `grafana/christ_portal_dashboard.json`.

---

## 📊 ESPRO API Endpoints Under Stress Testing

The following endpoints are exercised during the Christ University load tests:

| Phase | Friendly Name | HTTP Method | Endpoint Path (Port 84) | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Dashboard** | `getNotificationCount` | `POST` | `/Protected/StudentServices/Common/getNotificationCount` | Unread notification count |
| **Dashboard** | `isCBCSStudent` | `POST` | `/Protected/KPServiceNew/rest/isCBCSStudent` | CBCS curriculum check |
| **Dashboard** | `getStudentProfileData` | `POST` | `/Protected/StudentServices/Student/StudentProfile/getStudentProfileData` | Student details & photo |
| **Dashboard** | `getReleaseDetails` | `POST` | `/Protected/StudentServices/Common/getReleaseDetails` | Current ERP release tags |
| **Dashboard** | `getStudentClass` | `POST` | `/Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentClass` | Class and section info |
| **Dashboard** | `getActionableItems` | `POST` | `/Protected/StudentServices/Common/getActionableItems` | Pending fees/actions |
| **Dashboard** | `getErpNotifications` | `POST` | `/Protected/StudentServices/ScreenConfig/getErpNotifications` | Broadcast notices |
| **Dashboard** | `isStudentEligibleForHostelMenu` | `POST` | `/Protected/StudentServices/Hostel/HostelAdmission/isStudentEligibleForHostelMenu` | Hostel widget check |
| **Dashboard** | `getSysMenu` | `POST` | `/Protected/StudentServices/Common/getSysMenu?platform=web` | Left sidebar menu tree |
| **Academics** | `getOverallPercentage` | `POST` | `/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getOverallPercentage` | Aggregate attendance % |
| **Academics** | `getStudentTimetable` | `POST` | `/Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentTimetable` | Daily class schedule |
| **Attendance** | `getStudentSemesters` | `POST` | `/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters` | Registered semesters |
| **Attendance** | `getAttendanceCount` | `POST` | `/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount?sessionId=10` | Total conducted/attended |
| **Attendance** | `getCourseWiseAttendance` | `POST` | `/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance?sessionId=10` | Subject-wise breakdown |
| **Attendance** | `getLastSinkDateTime` | `POST` | `/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime?sessionId=10` | Biometric sync timestamp |
| **Attendance** | `getPerDayAttendanceCount` | `POST` | `/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getPerDayAttendanceCount` | Filtered day totals |
| **Attendance** | `getPerDayAttendanceDetails`| `POST` | `/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getPerDayAttendanceDetails` | Absent/cocurricular logs |

---

## 🛠️ Troubleshooting & Known Gotchas

1. **HTTP 401 Unauthorized / Token Expiration**:
   - Keycloak JWTs expire in **300 seconds (5 minutes)**.
   - Fix: Re-run `node prep_student_sessions.js` immediately before running k6 scripts.
2. **`getThemes` 404 Endpoint**:
   - The production portal's `/getThemes` endpoint consistently returns HTTP 404. This is a known production bug recorded in the HAR file; it is marked as tolerant or excluded in scripts so it does not fail the load test.
3. **Grafana Port Conflict**:
   - If port `3001` or `3000` is already in use by local services, `docker-compose.yml` maps Grafana to port `3002:3000`. Access Grafana at `http://localhost:3002`.
4. **k6 Exit Code 99**:
   - Exit code 99 is k6's intentional behavior when a performance threshold is breached (e.g., p95 > SLA threshold or error rate > 5%). This is used as a CI/CD performance gate.
5. **DPoP Header Mismatch**:
   - ESPRO strictly requires RFC 9449 DPoP authentication. Standard `Authorization: Bearer <token>` requests without corresponding `DPoP: <proof>` will be rejected with HTTP 401. Always use `makeHeaders(endpointUrl)` as implemented in test scripts 11 and 12.

---

> **Maintained by**: Rahul R (Lead Performance Engineering Intern)  
> **Repository**: [k6-load-testing-lab](https://github.com/Rahul83100/k6-load-testing-lab)  
> **Project Guide**: Abhi Sir (Christ University CDI)
