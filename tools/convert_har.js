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

// Filter out third-party static assets and external bot/captcha services
const ignoredExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.ico', '.css', '.map'];
const ignoredDomains = [
  'fonts.googleapis.com', 
  'fonts.gstatic.com', 
  'cdnjs.cloudflare.com', 
  'google-analytics.com',
  'www.google.com',
  'google.com',
  'recaptcha.net',
  'gstatic.com',
  'fontawesome.com',
  'kit.fontawesome.com',
  'ka-f.fontawesome.com',
];

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
import { textSummary } from './lib/k6-summary.js';

// ---------------------------------------------------------------------------
// 1. Account Credentials Loading (Supports 100,000+ CSV Records)
// ---------------------------------------------------------------------------
const credentials = new SharedArray('student_credentials', function () {
  let file;
  const targetPath = __ENV.CREDENTIALS_FILE || './data/students.csv';
  try {
    file = open(targetPath);
  } catch (e) {
    try {
      file = open('./data/prepespro_credentials.csv');
    } catch (e2) {
      return [{ username: '2420001@christuniversity.in', password: 'Student@123', course: 'GENERAL' }];
    }
  }
  try {
    const lines = file.trim().split(/\\r?\\n/).slice(1);
    const parsed = lines.map((line) => {
      const parts = line.split(',');
      return {
        username: parts[0] ? parts[0].trim() : '',
        password: parts[1] ? parts[1].trim() : '',
        course: parts[2] ? parts[2].trim() : 'GENERAL',
      };
    }).filter(c => c.username && c.password);
    return parsed.length > 0 ? parsed : [{ username: '2420001@christuniversity.in', password: 'Student@123', course: 'GENERAL' }];
  } catch (e) {
    return [{ username: '2420001@christuniversity.in', password: 'Student@123', course: 'GENERAL' }];
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
  iterations: __ENV.DURATION ? undefined : (__ENV.ITERS ? parseInt(__ENV.ITERS, 10) : (__ENV.VUS ? parseInt(__ENV.VUS, 10) : 1)),
  duration: __ENV.DURATION || undefined,
  insecureSkipTLSVerify: true,
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    api_success_rate: ['rate>0.80'],
  },
};

// Realistic think-time pacing (prevents synthetic lockstep bursts)
function thinkTime(minSec = 1, maxSec = 3) {
  if (__ENV.NO_THINK_TIME === 'true') return;
  const pause = Math.random() * (maxSec - minSec) + minSec;
  sleep(pause);
}

function executeApiCall(endpointName, method, url, payload, headers, timeoutStr = '15s', session = null) {
  const vuId = \`VU_\${__VU}\`;
  const credIndex = credentials.length > 0 ? (__VU - 1) % credentials.length : 0;
  const student = (credentials.length > 0 && credentials[credIndex]) 
    ? credentials[credIndex] 
    : { username: vuId, course: 'GENERAL' };

  const reqHeaders = Object.assign({}, headers);
  if (session && session.token) {
    reqHeaders['Authorization'] = \`Bearer \${session.token}\`;
    if (session.campusIds) reqHeaders['__campus_ids'] = session.campusIds;
    reqHeaders['x_jwt_id'] = '1';
    reqHeaders['x_jwt_type'] = 'EMP';
  }

  const params = {
    headers: reqHeaders,
    tags: {
      name: endpointName,
      endpoint: endpointName,
      user: student.username,
      course: student.course || 'GENERAL',
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
    : { username: 'test_student', password: 'password', course: 'GENERAL' };

  // VU session state: dynamic auth tokens and campus contexts
  const session = {
    token: '',
    campusIds: '2,4,1,5,6,3,7,8',
    loginTime: Date.now(),
  };

  group('Student_Journey', function () {
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
    script += `    let authRes = executeApiCall('${endpointName}', 'POST', '${url}', loginPayload, authHeaders, '15s', session);\n`;
    script += `    let token = '';\n`;
    script += `    let campusIds = '2,4,1,5,6,3,7,8';\n`;
    script += `    try {\n`;
    script += `      const authData = JSON.parse(authRes.body);\n`;
    script += `      token = authData.token || '';\n`;
    script += `      if (authData.campusIds) campusIds = authData.campusIds;\n`;
    script += `    } catch (e) {}\n\n`;
    script += `    const isLoginOk = authRes.status === 200 && Boolean(token);\n`;
    script += `    check(authRes, {\n`;
    script += `      '${endpointName} -> Student Authenticated (200 OK)': () => isLoginOk,\n`;
    script += `    });\n\n`;
    script += `    if (!isLoginOk) {\n`;
    script += `      // Authentication failed for this student - skip remainder of journey without faking credentials\n`;
    script += `      thinkTime(1, 2);\n`;
    script += `      return;\n`;
    script += `    }\n\n`;
    script += `    session.token = token;\n`;
    script += `    session.campusIds = campusIds;\n`;
    script += `    thinkTime(1, 2);\n\n`;
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
  script += `    executeApiCall('${endpointName}', '${method}', '${url}', ${postData}, ${JSON.stringify(headerObj)}, '15s', session);\n`;
  script += `    thinkTime(1, 3);\n\n`;
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
