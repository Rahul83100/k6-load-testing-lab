/**
 * Universal HAR to k6 Script Generator with Deep Grafana Metrics & Account Auth
 * 
 * Usage:
 *   node tools/convert_har.js har_files/my_recording.har [output_script_name.js]
 */

const fs = require('fs');
const path = require('path');

const harFileArg = process.argv[2];
const outputFileArg = process.argv[3];

if (!harFileArg) {
  console.log('Usage: node tools/convert_har.js <path-to-har-file> [output-script-name.js]');
  console.log('Example: node tools/convert_har.js har_files/prepespro2.christuniversity.in.har tests/prepespro2_har_load_test.js');
  process.exit(1);
}

const harPath = path.resolve(harFileArg);
if (!fs.existsSync(harPath)) {
  console.error(`Error: File not found: ${harPath}`);
  process.exit(1);
}

const scriptBaseName = path.basename(harPath, '.har').replace(/[^a-zA-Z0-9_-]/g, '_');
const defaultOutput = outputFileArg 
  ? path.resolve(outputFileArg)
  : path.join(__dirname, '..', 'tests', `${scriptBaseName}_load_test.js`);

console.log(`[Parser] Reading HAR file: ${harPath}...`);
const harRaw = fs.readFileSync(harPath, 'utf8');
const har = JSON.parse(harRaw);

const entries = (har.log && har.log.entries) || [];
console.log(`[Parser] Total entries in HAR: ${entries.length}`);

// Filter out irrelevant third-party static assets
const ignoredExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.ico', '.css'];
const ignoredDomains = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'google-analytics.com'];

const validEntries = entries.filter((entry) => {
  const urlStr = entry.request.url;
  try {
    const u = new URL(urlStr);
    if (ignoredDomains.some(d => u.hostname.includes(d))) return false;
    if (ignoredExtensions.some(ext => u.pathname.toLowerCase().endsWith(ext))) return false;
    return true;
  } catch (e) {
    return false;
  }
});

console.log(`[Parser] Filtered API endpoints: ${validEntries.length}`);

// Generate k6 JavaScript code
let script = `import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// ---------------------------------------------------------------------------
// 1. Account Credentials Loading (Distributed 1-to-1 among VUs)
// ---------------------------------------------------------------------------
const credentials = new SharedArray('prepespro_credentials', function () {
  try {
    const file = open('./data/prepespro_credentials.csv');
    const lines = file.trim().split('\\n').slice(1);
    const parsed = lines.map((line) => {
      const parts = line.split(',');
      return {
        username: parts[0] ? parts[0].trim() : '',
        password: parts[1] ? parts[1].trim() : '',
      };
    }).filter(c => c.username && c.password);
    return parsed.length > 0 ? parsed : [{ username: 'Cimi', password: 'Cdi@christ2026' }];
  } catch (e) {
    return [{ username: 'Cimi', password: 'Cdi@christ2026' }];
  }
});

// ---------------------------------------------------------------------------
// 2. Custom Telemetry Metrics for Deep Grafana Visibility
// ---------------------------------------------------------------------------
export const apiUsersCounter = new Counter('api_users_triggered');
export const apiHitsCounter = new Counter('api_hits_total');
export const apiFailuresCounter = new Counter('api_failures_total');
export const apiSuccessRate = new Rate('api_success_rate');
export const apiFailureRate = new Rate('api_failure_rate');
export const rate2xx = new Rate('rate_status_2xx');
export const rate4xx = new Rate('rate_status_4xx');
export const rate5xx = new Rate('rate_status_5xx');
export const rateTimeout = new Rate('rate_status_timeout');
export const apiDuration = new Trend('api_response_duration', true);

export const options = {
  vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 1,
  iterations: __ENV.ITERS ? parseInt(__ENV.ITERS, 10) : 1,
  insecureSkipTLSVerify: true,
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    api_success_rate: ['rate>0.80'],
  },
};

let currentToken = '';

function executeApiCall(endpointName, method, url, payload, headers, timeoutStr = '15s') {
  const vuId = \`VU_\${__VU}\`;
  const credIndex = credentials.length > 0 ? (__VU - 1) % credentials.length : 0;
  const username = (credentials.length > 0 && credentials[credIndex]) 
    ? credentials[credIndex].username 
    : vuId;

  const reqHeaders = Object.assign({}, headers);
  if (currentToken) {
    reqHeaders['Authorization'] = \`Bearer \${currentToken}\`;
  }

  const params = {
    headers: reqHeaders,
    tags: {
      name: endpointName,
      endpoint: endpointName,
      user: username,
      vu: vuId,
    },
    timeout: timeoutStr,
  };

  const startTime = Date.now();
  let res;
  if (method === 'GET') {
    res = http.get(url, params);
  } else {
    res = http.post(url, payload || JSON.stringify({}), params);
  }
  const durationMs = Date.now() - startTime;

  apiUsersCounter.add(1, { endpoint: endpointName, vu: vuId });
  apiHitsCounter.add(1, { endpoint: endpointName, status: \`\${res.status}\`, vu: vuId });

  const is2xx = res.status >= 200 && res.status < 300;
  const is4xx = res.status >= 400 && res.status < 500;
  const is5xx = res.status >= 500 && res.status < 600;
  const isTimeout = res.status === 0 || (res.error && res.error.toLowerCase().includes('timeout'));

  rate2xx.add(is2xx, { endpoint: endpointName });
  rate4xx.add(is4xx, { endpoint: endpointName });
  rate5xx.add(is5xx, { endpoint: endpointName });
  rateTimeout.add(isTimeout, { endpoint: endpointName });

  apiSuccessRate.add(is2xx, { endpoint: endpointName });
  apiFailureRate.add(!is2xx, { endpoint: endpointName });
  apiDuration.add(res.timings.duration || durationMs, { endpoint: endpointName, status: \`\${res.status}\` });

  if (!is2xx) {
    let failureReason = isTimeout ? 'Timeout' : (res.error || \`HTTP \${res.status}\`);
    apiFailuresCounter.add(1, {
      endpoint: endpointName,
      status: \`\${res.status}\`,
      reason: failureReason,
      vu: vuId,
    });
  }

  const checkLabel = is2xx
    ? \`\${endpointName} -> 200 OK (\${durationMs}ms)\`
    : \`\${endpointName} -> FAILED [Status: \${res.status}, Reason: \${isTimeout ? 'Timeout' : (res.error || 'HTTP ' + res.status)}]\`;

  check(res, {
    [checkLabel]: (r) => is2xx,
  });

  return res;
}

export default function () {
  const credIndex = credentials.length > 0 ? (__VU - 1) % credentials.length : 0;
  const userCred = (credentials.length > 0 && credentials[credIndex]) 
    ? credentials[credIndex] 
    : { username: 'Cimi', password: 'Cdi@christ2026' };

  group('HAR_User_Journey', function () {
`;

let hasAuthHandled = false;

validEntries.forEach((entry, idx) => {
  const req = entry.request;
  const url = req.url;
  const method = req.method.toUpperCase();
  const u = new URL(url);
  const pathParts = u.pathname.split('/').filter(Boolean);
  const endpointName = `${String(idx + 1).padStart(2, '0')}_${pathParts[pathParts.length - 1] || 'endpoint'}`;

  // Filter headers
  const allowedHeaders = ['content-type', 'origin', 'referer', 'user-agent'];
  const headerObj = {};
  if (req.headers) {
    req.headers.forEach(h => {
      const k = h.name.toLowerCase();
      if (allowedHeaders.includes(k) || k.startsWith('x_') || k.startsWith('__')) {
        headerObj[h.name] = h.value;
      }
    });
  }

  // Detect Login / Auth endpoint
  const isAuth = (u.pathname.includes('/Public/Security/Auth') || u.pathname.endsWith('/Auth')) && method === 'POST';

  if (isAuth && !hasAuthHandled) {
    hasAuthHandled = true;
    script += `    // Request #${idx + 1}: POST ${u.pathname} (Dynamic VU Authentication)\n`;
    script += `    const loginPayload = JSON.stringify({\n`;
    script += `      loginId: userCred.username,\n`;
    script += `      loginPassword: userCred.password,\n`;
    script += `      loginReCaptcha: '',\n`;
    script += `    });\n`;
    script += `    const authHeaders = ${JSON.stringify(headerObj)};\n`;
    script += `    let authRes = executeApiCall('${endpointName}', 'POST', '${url}', loginPayload, authHeaders, '15s');\n`;
    script += `    let token = '';\n`;
    script += `    try {\n`;
    script += `      const authData = JSON.parse(authRes.body);\n`;
    script += `      token = authData.token || '';\n`;
    script += `    } catch (e) {}\n`;
    script += `    if (!token && userCred.username !== 'Cimi') {\n`;
    script += `      const fbPayload = JSON.stringify({ loginId: 'Cimi', loginPassword: 'Cdi@christ2026', loginReCaptcha: '' });\n`;
    script += `      authRes = executeApiCall('${endpointName}_Fallback', 'POST', '${url}', fbPayload, authHeaders, '15s');\n`;
    script += `      try { token = JSON.parse(authRes.body).token || ''; } catch (e) {}\n`;
    script += `    }\n`;
    script += `    currentToken = token;\n`;
    script += `    sleep(0.5);\n\n`;
    return;
  }

  let postData = 'null';
  if (req.postData && req.postData.text) {
    try {
      const parsed = JSON.parse(req.postData.text);
      postData = JSON.stringify(JSON.stringify(parsed));
    } catch (e) {
      postData = JSON.stringify(req.postData.text);
    }
  }

  script += `    // Request #${idx + 1}: ${method} ${u.pathname}\n`;
  script += `    executeApiCall('${endpointName}', '${method}', '${url}', ${postData}, ${JSON.stringify(headerObj)}, '15s');\n`;
  script += `    sleep(0.5);\n\n`;
});

script += `  });
}

export function handleSummary(data) {
  return {
    'tests/christ_university/reports/grafana_summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
`;

fs.writeFileSync(defaultOutput, script, 'utf8');
console.log(`[Success] Auto-generated k6 script written to: ${defaultOutput}`);
