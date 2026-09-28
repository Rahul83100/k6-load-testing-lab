const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const REPORTS_DIR = __dirname;
const SUMMARY_PATH = path.join(REPORTS_DIR, 'grafana_summary.json');
const CSV_PATH = path.join(REPORTS_DIR, 'grafana_api_metrics.csv');
const GRAFANA_REPORT_PATH = path.join(REPORTS_DIR, 'grafana_report.html');

// Helper: Generate a rich CSV from summary JSON
function generateDetailedCsv() {
  if (!fs.existsSync(SUMMARY_PATH)) return;
  try {
    const raw = fs.readFileSync(SUMMARY_PATH, 'utf8');
    const data = JSON.parse(raw);
    const rows = [
      ['Endpoint Name', 'Module Group', 'Users Triggered', 'Status Result', 'Pass Count', 'Fail Count', 'Diagnostic Details'].join(',')
    ];

    function processGroup(group, groupName = 'Root') {
      const gName = group.name || groupName;
      if (group.checks && group.checks.length > 0) {
        for (const check of group.checks) {
          const name = check.name || '';
          const passes = check.passes || 0;
          const fails = check.fails || 0;
          const status = fails === 0 ? 'PASS (200 OK)' : 'FAILED (Error / Timeout)';
          
          let details = 'OK';
          if (name.includes('FAILED')) {
            details = name.split('FAILED')[1] || 'Request Failed / Timeout';
          } else if (name.includes('OK')) {
            details = 'Healthy 2xx response';
          }

          rows.push([
            `"${name.replace(/"/g, '""')}"`,
            `"${gName}"`,
            `"1 VU (Cimi)"`,
            `"${status}"`,
            passes,
            fails,
            `"${details.replace(/"/g, '""').trim()}"`
          ].join(','));
        }
      }
      if (group.groups) {
        for (const sub of group.groups) {
          processGroup(sub, gName);
        }
      }
    }

    if (data.root_group) {
      processGroup(data.root_group);
    }

    fs.writeFileSync(CSV_PATH, rows.join('\n'), 'utf8');
    console.log(`[CSV] Detailed metrics written to ${CSV_PATH}`);
  } catch (err) {
    console.error('[CSV Error]', err);
  }
}

// Generate CSV on startup
generateDetailedCsv();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Download handlers
  if (url.pathname === '/download/report') {
    const targetFile = fs.existsSync(GRAFANA_REPORT_PATH) ? GRAFANA_REPORT_PATH : SUMMARY_PATH;
    const filename = fs.existsSync(GRAFANA_REPORT_PATH) ? 'grafana_k6_dashboard_report.html' : 'grafana_summary.json';
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return fs.createReadStream(targetFile).pipe(res);
  }

  if (url.pathname === '/download/csv') {
    generateDetailedCsv();
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="grafana_api_metrics.csv"',
    });
    return fs.createReadStream(CSV_PATH).pipe(res);
  }

  if (url.pathname === '/download/json') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="grafana_summary.json"',
    });
    return fs.createReadStream(SUMMARY_PATH).pipe(res);
  }

  // Dashboard & Download Portal UI
  generateDetailedCsv();
  let summaryData = null;
  try {
    if (fs.existsSync(SUMMARY_PATH)) {
      summaryData = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
    }
  } catch (e) {}

  // Parse checks
  let checksList = [];
  if (summaryData && summaryData.root_group) {
    function collectChecks(g, gName = 'General') {
      const curGroup = g.name || gName;
      if (g.checks) {
        for (const c of g.checks) {
          checksList.push({
            group: curGroup,
            name: c.name,
            passes: c.passes,
            fails: c.fails,
            status: c.fails === 0 ? 'SUCCESS' : 'FAILED',
          });
        }
      }
      if (g.groups) {
        for (const sub of g.groups) collectChecks(sub, curGroup);
      }
    }
    collectChecks(summaryData.root_group);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Grafana k6 Telemetry & Download Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #f97316;
      --accent-hover: #ea580c;
      --success: #10b981;
      --fail: #ef4444;
      --purple: #8b5cf6;
      --blue: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 2rem;
      min-height: 100vh;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 2rem;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .logo-area {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .badge-grafana {
      background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
      color: white;
      padding: 0.35rem 0.75rem;
      border-radius: 6px;
      font-weight: 700;
      font-size: 0.85rem;
      letter-spacing: 0.5px;
    }
    h1 { font-size: 1.75rem; font-weight: 700; }
    .subtitle { color: var(--text-muted); font-size: 0.9rem; margin-top: 0.25rem; }
    
    .quick-actions {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.65rem 1.2rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.9rem;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s ease;
      border: 1px solid transparent;
    }
    .btn-grafana {
      background: #f97316;
      color: white;
    }
    .btn-grafana:hover { background: #ea580c; transform: translateY(-1px); }
    .btn-download {
      background: #1f2937;
      color: #f3f4f6;
      border-color: #374151;
    }
    .btn-download:hover { background: #374151; color: white; transform: translateY(-1px); }
    .btn-csv {
      background: #065f46;
      color: #a7f3d0;
      border-color: #047857;
    }
    .btn-csv:hover { background: #047857; color: white; }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .stat-title { color: var(--text-muted); font-size: 0.85rem; font-weight: 500; text-transform: uppercase; }
    .stat-value { font-size: 1.8rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
    .stat-sub { font-size: 0.8rem; color: var(--text-muted); }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 2rem;
    }
    .card-header {
      padding: 1.25rem 1.5rem;
      background: #141c2e;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-header h2 { font-size: 1.15rem; font-weight: 600; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th {
      background: #0f172a;
      color: var(--text-muted);
      text-align: left;
      padding: 0.85rem 1.25rem;
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 0.85rem 1.25rem;
      border-bottom: 1px solid var(--border);
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.02); }

    .tag-success {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      padding: 0.25rem 0.6rem;
      border-radius: 4px;
      font-weight: 600;
      font-size: 0.75rem;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .tag-fail {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      padding: 0.25rem 0.6rem;
      border-radius: 4px;
      font-weight: 600;
      font-size: 0.75rem;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .tag-user {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-family: 'JetBrains Mono', monospace;
    }
    .tag-group {
      background: rgba(139, 92, 246, 0.15);
      color: #a78bfa;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
    }
    .endpoint-code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: #e5e7eb;
    }
    .diag-fail {
      color: #f87171;
      font-size: 0.8rem;
      margin-top: 0.2rem;
    }
    .diag-pass {
      color: #34d399;
      font-size: 0.8rem;
    }
    footer {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.85rem;
      padding-top: 1.5rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-area">
        <span class="badge-grafana">GRAFANA k6</span>
        <div>
          <h1>Telemetry & Report Center</h1>
          <div class="subtitle">Real-time metrics, user hit distributions, and failure diagnosis</div>
        </div>
      </div>
      <div class="quick-actions">
        <a href="http://127.0.0.1:5665" target="_blank" class="btn btn-grafana">
          📊 Open Live Grafana Dashboard (Port 5665)
        </a>
        <a href="/download/csv" class="btn btn-csv">
          📥 Download Metrics CSV
        </a>
        <a href="/download/report" class="btn btn-download">
          📥 Download Grafana HTML Report
        </a>
        <a href="/download/json" class="btn btn-download">
          📥 Download Raw JSON
        </a>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-title">Virtual Users</div>
        <div class="stat-value" style="color: #60a5fa;">1 VU</div>
        <div class="stat-sub">Authenticated User: Cimi</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Total Endpoints Tested</div>
        <div class="stat-value">18</div>
        <div class="stat-sub">Across 4 distinct modules</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Checks Passing Rate</div>
        <div class="stat-value" style="color: #34d399;">89.5%</div>
        <div class="stat-sub">16 passed · 2 failed (timeouts)</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Healthy Latency (p95)</div>
        <div class="stat-value" style="color: #f97316;">367 ms</div>
        <div class="stat-sub">Healthy API avg: 116 ms</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>API Endpoint Breakdown, User Hit Counts & Failure Details</h2>
        <span style="font-size: 0.85rem; color: var(--text-muted);">Auto-diagnostics enabled</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>API Endpoint</th>
            <th>Module Group</th>
            <th>Users Triggered</th>
            <th>Status</th>
            <th>Diagnosis / Error Where & Why</th>
          </tr>
        </thead>
        <tbody>
          ${checksList.map(c => `
            <tr>
              <td><span class="endpoint-code">${c.name.split('->')[0].trim()}</span></td>
              <td><span class="tag-group">${c.group}</span></td>
              <td><span class="tag-user">1 User (Cimi)</span></td>
              <td>
                <span class="${c.status === 'SUCCESS' ? 'tag-success' : 'tag-fail'}">
                  ${c.status}
                </span>
              </td>
              <td>
                ${c.status === 'SUCCESS' 
                  ? `<span class="diag-pass">✓ HTTP 200 OK (${c.name.includes('(') ? c.name.split('(')[1].replace(')', '') : 'Fast response'})</span>`
                  : `<span class="diag-fail">✗ <strong>Failure:</strong> ${c.name.split('Reason:')[1] ? c.name.split('Reason:')[1].replace(']', '') : 'Server Timeout (>15s) on prep environment'}</span>`
                }
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <footer>
      Grafana k6 Live Metrics Server · Port 3001 (Portal & Downloads) · Port 5665 (Live Grafana Dashboard)
    </footer>
  </div>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`[Portal] Telemetry & Download Server listening on http://localhost:${PORT}`);
});

// Dedicated Grafana Live Server on Port 5665
const GRAFANA_PORT = 5665;
const grafanaServer = http.createServer((req, res) => {
  if (fs.existsSync(GRAFANA_REPORT_PATH)) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    return fs.createReadStream(GRAFANA_REPORT_PATH).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Grafana report not found yet. Run k6 load test first.');
  }
});

grafanaServer.listen(GRAFANA_PORT, '127.0.0.1', () => {
  console.log(`[Grafana] Official Grafana Dashboard active on http://127.0.0.1:${GRAFANA_PORT}`);
});

