const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { decomposeEndpoint, generateDiagnosis, loadRealMetrics } = require('./api_diagnostics.js');

const PORT = 3001;
const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');
const REPORTS_DIR = __dirname;
const SUMMARY_PATH = path.join(REPORTS_DIR, 'grafana_summary.json');
const CSV_PATH = path.join(REPORTS_DIR, 'grafana_api_metrics.csv');
const GRAFANA_REPORT_PATH = path.join(REPORTS_DIR, 'grafana_report.html');
const CREDENTIALS_PATH = path.join(WORKSPACE_ROOT, 'tests', 'data', 'prepespro_credentials.csv');

// State tracking for active k6 process
let activeK6Process = null;
let activeRunState = {
  status: 'idle', // 'idle' | 'running' | 'completed' | 'failed'
  script: 'tests/prepespro2_har_load_test.js',
  vus: 50,
  duration: '1m',
  startTime: null,
  elapsedSec: 0,
  exitCode: null,
  outputLogs: [],
};

// Memory cache for metrics
let lastParsedMetrics = {
  timestamp: new Date().toISOString(),
  script: 'tests/prepespro2_har_load_test.js',
  vus: 50,
  totalRequests: 0,
  successCount: 0,
  failCount: 0,
  successRate: 0,
  avgDurationMs: 0,
  p95DurationMs: 0,
  maxDurationMs: 0,
  endpoints: [],
};

/**
 * Dynamically Load REAL Metrics from Disk
 */
function getLiveMetrics() {
  const scriptFullPath = path.resolve(WORKSPACE_ROOT, activeRunState.script || 'tests/prepespro2_har_load_test.js');
  const real = loadRealMetrics(SUMMARY_PATH, scriptFullPath);
  if (real && real.endpoints && real.endpoints.length > 0) {
    lastParsedMetrics = {
      ...lastParsedMetrics,
      ...real,
      script: activeRunState.script || 'tests/prepespro2_har_load_test.js',
    };
    writeCsvFromMetrics(lastParsedMetrics);
  }
  return lastParsedMetrics;
}

// Parse k6 log outputs to update metrics during live test
function parseLogOutput(logsArray) {
  const checkRegex = /(✓|✗)\s+([0-9a-zA-Z_.-]+)\s*->\s*(200 OK|FAILED|HTTP \d+)?\s*(?:\[Status:\s*(\d+),\s*Reason:\s*([^\]]+)\])?\s*(?:\(?(\d+)ms\)?)?/g;
  const endpoints = [];
  const logText = logsArray.join('\n');

  let match;
  while ((match = checkRegex.exec(logText)) !== null) {
    const passed = match[1] === '✓';
    const name = match[2];
    const statusCode = match[4] ? parseInt(match[4], 10) : (passed ? 200 : 500);
    const reason = match[5] ? match[5].trim() : (passed ? '200 OK' : 'Failed');
    const durationMs = match[6] ? parseInt(match[6], 10) : (passed ? 50 : 15000);

    const diag = generateDiagnosis(name, statusCode, reason, durationMs, `https://prepespro.christuniversity.in/.../${name}`);

    endpoints.push({
      name,
      cleanName: diag.cleanName,
      method: name.startsWith('01_') ? 'GET' : 'POST',
      url: `https://prepespro.christuniversity.in/.../${name}`,
      group: diag.group,
      status: statusCode,
      passed,
      durationMs,
      reason,
      whatIsIt: diag.whatIsIt,
      whyFailed: diag.whyFailed,
      solution: diag.solution,
      severity: diag.severity,
      hitsTotal: 1,
      passedHits: passed ? 1 : 0,
      failedHits: passed ? 0 : 1,
    });
  }

  if (endpoints.length > 0) {
    const success = endpoints.filter(e => e.passed).length;
    const fails = endpoints.length - success;
    const totalDuration = endpoints.reduce((acc, cur) => acc + cur.durationMs, 0);
    const sortedDurations = [...endpoints].map(e => e.durationMs).sort((a, b) => a - b);
    const p95 = sortedDurations[Math.floor(sortedDurations.length * 0.95)] || 0;
    const max = sortedDurations[sortedDurations.length - 1] || 0;

    lastParsedMetrics = {
      timestamp: new Date().toISOString(),
      script: activeRunState.script,
      vus: activeRunState.vus,
      totalRequests: endpoints.length,
      successCount: success,
      failCount: fails,
      successRate: parseFloat(((success / endpoints.length) * 100).toFixed(2)),
      avgDurationMs: parseFloat((totalDuration / endpoints.length).toFixed(1)),
      p95DurationMs: p95,
      maxDurationMs: max,
      endpoints,
    };
    writeCsvFromMetrics(lastParsedMetrics);
  }
}

// Write enriched CSV report with plain English descriptions
function writeCsvFromMetrics(metrics) {
  try {
    const rows = [
      ['Sampler Name', 'Endpoint Purpose (What Is It?)', 'HTTP Method', 'Module Group', 'HTTP Status', 'Duration (ms)', 'Result', 'Why It Failed (Plain English)', 'Recommended Solution'].join(',')
    ];
    for (const ep of metrics.endpoints) {
      rows.push([
        `"${ep.name}"`,
        `"${(ep.whatIsIt || ep.cleanName || '').replace(/"/g, '""')}"`,
        `"${ep.method}"`,
        `"${ep.group}"`,
        ep.status,
        ep.durationMs,
        ep.passed ? '"PASS"' : '"FAIL"',
        `"${(ep.whyFailed || ep.reason || '').replace(/"/g, '""')}"`,
        `"${(ep.solution || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
      ].join(','));
    }
    fs.writeFileSync(CSV_PATH, rows.join('\n'), 'utf8');
  } catch (e) {
    console.error('Error writing CSV:', e);
  }
}

// Initialize metrics from disk
getLiveMetrics();

// Read student credentials count and metadata
function getStudentCredentials() {
  const studentsPath = path.join(WORKSPACE_ROOT, 'tests', 'data', 'students.csv');
  const targetPath = fs.existsSync(studentsPath) ? studentsPath : CREDENTIALS_PATH;
  if (!fs.existsSync(targetPath)) return [];
  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const lines = raw.trim().split(/\r?\n/).slice(1);
    return lines.map(l => {
      const parts = l.split(',');
      const course = parts[2]?.trim() || '';
      return { 
        username: parts[0]?.trim() || '', 
        course: course || 'General',
        role: course ? `${course} Student` : 'Student Tester' 
      };
    }).filter(u => u.username);
  } catch (e) {
    return [];
  }
}

// SSE Clients for live log streaming
const sseClients = new Set();
function broadcastLog(line) {
  activeRunState.outputLogs.push(line);
  if (activeRunState.outputLogs.length > 500) {
    activeRunState.outputLogs.shift();
  }
  const payload = `data: ${JSON.stringify({ log: line, timestamp: Date.now() })}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// HTTP Server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. SSE Endpoint: /api/stream-logs
  if (url.pathname === '/api/stream-logs') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', initialLogs: activeRunState.outputLogs.slice(-100) })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. API Endpoint: GET /api/status
  if (url.pathname === '/api/status') {
    const creds = getStudentCredentials();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ...activeRunState,
      credentialsCount: creds.length,
      credentialsList: creds,
      isGrafanaActive: fs.existsSync(GRAFANA_REPORT_PATH),
    }));
  }

  // 3. API Endpoint: GET /api/metrics
  if (url.pathname === '/api/metrics') {
    const live = getLiveMetrics();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(live));
  }

  // 3b. API Endpoint: POST /api/upload-credentials
  if (url.pathname === '/api/upload-credentials' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        if (!body || !body.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Empty file received' }));
        }

        let csvText = body;
        if (body.startsWith('{')) {
          try {
            const parsed = JSON.parse(body);
            if (parsed.content) csvText = parsed.content;
          } catch (e) {}
        }

        const dir = path.dirname(CREDENTIALS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(CREDENTIALS_PATH, csvText.trim(), 'utf8');

        const studentsPath = path.join(dir, 'students.csv');
        fs.writeFileSync(studentsPath, csvText.trim(), 'utf8');

        const creds = getStudentCredentials();
        broadcastLog(`\n📥 Ingested new student credentials via Web Portal: ${creds.length} accounts verified`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ 
          success: true, 
          count: creds.length, 
          message: `Successfully ingested ${creds.length} student credentials` 
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Failed to save credentials: ' + err.message }));
      }
    });
    return;
  }

  // 4. API Endpoint: POST /api/run-test
  if (url.pathname === '/api/run-test' && req.method === 'POST') {
    if (activeRunState.status === 'running') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'A test is already actively executing!' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let params = {};
      try { params = JSON.parse(body || '{}'); } catch (e) {}

      const script = params.script || 'tests/prepespro2_har_load_test.js';
      const vus = parseInt(params.vus || 1, 10);
      const duration = params.duration || '';
      const iterations = params.iterations || (duration ? null : vus);

      activeRunState.status = 'running';
      activeRunState.script = script;
      activeRunState.vus = vus;
      activeRunState.duration = duration || `${iterations} iteration(s)`;
      activeRunState.startTime = Date.now();
      activeRunState.outputLogs = [];
      activeRunState.exitCode = null;

      const args = ['run', '-u', `${vus}`];
      if (duration) {
        args.push('-d', duration);
      } else if (iterations) {
        args.push('-i', `${iterations}`);
      }
      args.push(script);

      broadcastLog(`============================================================`);
      broadcastLog(`🚀 Starting k6 Load Test Execution`);
      broadcastLog(`• Script     : ${script}`);
      broadcastLog(`• VUs        : ${vus} Concurrent Virtual User(s)`);
      broadcastLog(`• Mode       : ${duration ? duration : `${iterations} shared iteration(s)`}`);
      broadcastLog(`• Command    : k6 ${args.join(' ')}`);
      broadcastLog(`• Web Engine : Port 5665 ready`);
      broadcastLog(`============================================================\n`);

      const env = Object.assign({}, process.env, {
        K6_WEB_DASHBOARD: 'true',
        K6_WEB_DASHBOARD_PORT: '5665',
        K6_WEB_DASHBOARD_EXPORT: GRAFANA_REPORT_PATH,
        VUS: `${vus}`,
        ITERS: iterations ? `${iterations}` : '1',
        DURATION: duration || '',
      });

      const timerInterval = setInterval(() => {
        if (activeRunState.status === 'running') {
          activeRunState.elapsedSec = Math.floor((Date.now() - activeRunState.startTime) / 1000);
        } else {
          clearInterval(timerInterval);
        }
      }, 1000);

      const k6Cmd = process.platform === 'win32' ? 'k6.exe' : 'k6';
      activeK6Process = spawn(k6Cmd, args, {
        cwd: WORKSPACE_ROOT,
        env,
        shell: true,
      });

      activeK6Process.stdout.on('data', data => {
        const lines = data.toString().split('\n');
        for (const l of lines) {
          if (l.trim()) broadcastLog(l);
        }
      });

      activeK6Process.stderr.on('data', data => {
        const lines = data.toString().split('\n');
        for (const l of lines) {
          if (l.trim()) broadcastLog(`[stderr] ${l}`);
        }
      });

      activeK6Process.on('close', code => {
        clearInterval(timerInterval);
        activeRunState.status = (code === 0 || code === 99) ? 'completed' : 'failed';
        activeRunState.exitCode = code;
        activeRunState.elapsedSec = Math.floor((Date.now() - activeRunState.startTime) / 1000);
        activeK6Process = null;

        broadcastLog(`\n🏁 Test completed with exit code: ${code}`);
        broadcastLog(`Analyzing run output and updating telemetry dashboard...`);

        getLiveMetrics();
        if (!lastParsedMetrics.endpoints || lastParsedMetrics.endpoints.length === 0) {
          parseLogOutput(activeRunState.outputLogs);
        }
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Test started successfully' }));
    });
    return;
  }

  // 5. API Endpoint: POST /api/stop-test
  if (url.pathname === '/api/stop-test' && req.method === 'POST') {
    if (activeK6Process) {
      broadcastLog(`\n⚠️ Force stopping active k6 load test by user request...`);
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/pid', `${activeK6Process.pid}`, '/f', '/t']);
        } catch (e) {
          activeK6Process.kill('SIGTERM');
        }
      } else {
        activeK6Process.kill('SIGTERM');
      }
      activeRunState.status = 'idle';
      activeK6Process = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Test terminated' }));
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No test currently running' }));
  }

  // 6. Download Endpoints
  if (url.pathname === '/download/csv') {
    writeCsvFromMetrics(lastParsedMetrics);
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="grafana_api_metrics.csv"',
    });
    return fs.createReadStream(CSV_PATH).pipe(res);
  }

  if (url.pathname === '/download/report') {
    if (fs.existsSync(GRAFANA_REPORT_PATH)) {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Disposition': 'attachment; filename="grafana_k6_report.html"',
      });
      return fs.createReadStream(GRAFANA_REPORT_PATH).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('HTML report not yet generated. Please execute a test first.');
  }

  if (url.pathname === '/download/json') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="k6_telemetry_metrics.json"',
    });
    return res.end(JSON.stringify(lastParsedMetrics, null, 2));
  }

  // 7. Endpoint: Release/Claim 5665 for external k6 runs
  if (url.pathname === '/api/release-5665') {
    stopGrafanaPortServer(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ released: true }));
    });
    return;
  }

  if (url.pathname === '/api/claim-5665') {
    startGrafanaPortServer();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ claimed: true }));
    return;
  }

  // 8. Render UI from standalone index.html
  const indexPath = path.join(REPORTS_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(indexPath).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('index.html not found');
});

// ---------------------------------------------------------------------------
// Dedicated Persistent Grafana Dashboard Server on Port 5665
// ---------------------------------------------------------------------------
let grafanaServer = null;

function startGrafanaPortServer() {
  if (grafanaServer) return;
  try {
    grafanaServer = http.createServer((req, res) => {
      if (fs.existsSync(GRAFANA_REPORT_PATH)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(GRAFANA_REPORT_PATH).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body style="background:#111;color:#eee;font-family:sans-serif;padding:2rem;"><h2>📊 Grafana Dashboard Initializing...</h2><p>Please run a load test to generate the report.</p></body></html>');
    });

    grafanaServer.on('error', (err) => {
      // Port in use (e.g. k6 is actively using it), don't crash
      grafanaServer = null;
    });

    grafanaServer.listen(5665, '127.0.0.1', () => {
      console.log(`📊 Persistent Grafana Dashboard active on: http://127.0.0.1:5665`);
    });
  } catch (e) {
    grafanaServer = null;
  }
}

function stopGrafanaPortServer(callback) {
  if (grafanaServer) {
    grafanaServer.close(() => {
      grafanaServer = null;
      if (callback) callback();
    });
  } else if (callback) {
    callback();
  }
}

server.listen(PORT, () => {
  getLiveMetrics();
  console.log(`============================================================`);
  console.log(`⚡ Christ University Enterprise Performance Control Center`);
  console.log(`📡 Web UI active: http://localhost:${PORT}`);
  console.log(`============================================================`);
  startGrafanaPortServer();
});

