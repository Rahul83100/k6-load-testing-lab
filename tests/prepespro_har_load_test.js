import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// ---------------------------------------------------------------------------
// Custom Metrics for Deep Grafana Visibility
// ---------------------------------------------------------------------------
// How many users triggered each API
export const apiUsersCounter = new Counter('api_users_triggered');
// Total hits per API
export const apiHitsCounter = new Counter('api_hits_total');
// Failure details: where and how each API failed
export const apiFailuresCounter = new Counter('api_failures_total');
// Rate metrics for API success and failures
export const apiSuccessRate = new Rate('api_success_rate');
export const apiFailureRate = new Rate('api_failure_rate');
// HTTP Status Code rates
export const rate2xx = new Rate('rate_status_2xx');
export const rate4xx = new Rate('rate_status_4xx');
export const rate5xx = new Rate('rate_status_5xx');
export const rateTimeout = new Rate('rate_status_timeout');
// Latency trends per API
export const apiDuration = new Trend('api_response_duration', true);

// ---------------------------------------------------------------------------
// Configuration: Minimum 1 Virtual User (configurable via CLI or ENV)
// ---------------------------------------------------------------------------
export const options = {
  vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 1,
  iterations: __ENV.ITERS ? parseInt(__ENV.ITERS, 10) : 1,
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    api_success_rate: ['rate>0.80'],
  },
  insecureSkipTLSVerify: true,
};

// Load credentials from CSV
const credentials = new SharedArray('prepespro_credentials', function () {
  const file = open('./data/prepespro_credentials.csv');
  const lines = file.trim().split('\n').slice(1);
  return lines.map((line) => {
    const parts = line.split(',');
    return {
      username: parts[0].trim(),
      password: parts[1].trim(),
    };
  });
});

const BASE_URL = 'https://prepespro.christuniversity.in:81';
const ORIGIN = 'https://prepespro.christuniversity.in';

// ---------------------------------------------------------------------------
// Helper: Execute and Record Granular Metrics for Grafana
// ---------------------------------------------------------------------------
function executeApiCall(endpointName, method, url, payload, headers, timeoutStr = '15s') {
  const credIndex = credentials.length > 0 ? (__VU - 1) % credentials.length : 0;
  const username = (credentials.length > 0 && credentials[credIndex]) 
    ? credentials[credIndex].username 
    : `VU_${__VU}`;

  const params = {
    headers: headers,
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

  // 1. User & Hit attribution
  apiUsersCounter.add(1, { endpoint: endpointName, user: username, vu: vuId });
  apiHitsCounter.add(1, { endpoint: endpointName, status: `${res.status}`, user: username, vu: vuId });

  // 2. Response Status Classification
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
  apiDuration.add(res.timings.duration || durationMs, { endpoint: endpointName, status: `${res.status}` });

  // 3. Detailed Failure Tracking: Where, How, and Why it failed
  if (!is2xx) {
    let failureReason = 'Unknown Error';
    if (isTimeout) {
      failureReason = `Timeout (exceeded ${timeoutStr})`;
    } else if (res.error) {
      failureReason = res.error;
    } else if (res.status > 0) {
      failureReason = `HTTP ${res.status}`;
    }

    apiFailuresCounter.add(1, {
      endpoint: endpointName,
      status: `${res.status}`,
      reason: failureReason,
      user: username,
      vu: vuId,
    });
  }

  // 4. Grafana Check with full diagnostic message
  const checkLabel = is2xx
    ? `${endpointName} -> 200 OK (${durationMs}ms)`
    : `${endpointName} -> FAILED [Status: ${res.status}, Reason: ${isTimeout ? 'Timeout' : (res.error || 'HTTP ' + res.status)}]`;

  check(res, {
    [checkLabel]: (r) => is2xx,
  });

  return res;
}

export default function () {
  const credIndex = (__VU - 1) % credentials.length;
  let userCred = credentials[credIndex];
  const vuId = `VU_${__VU}`;

  // -------------------------------------------------------------------------
  // STEP 1: Authenticate against Public/Security/Auth
  // -------------------------------------------------------------------------
  const loginPayload = JSON.stringify({
    loginId: userCred.username,
    loginPassword: userCred.password,
    loginReCaptcha: '',
  });

  const authHeaders = {
    'Content-Type': 'application/json;charset=UTF-8',
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    'User-Agent': 'k6-load-testing-agent',
  };

  let authRes = executeApiCall(
    '00_Auth_Login',
    'POST',
    `${BASE_URL}/Public/Security/Auth`,
    loginPayload,
    authHeaders,
    '15s'
  );

  // Fallback to primary credential if secondary account isn't provisioned yet
  if (authRes.status !== 200) {
    const fallbackPayload = JSON.stringify({
      loginId: 'Cimi',
      loginPassword: 'Cdi@christ2026',
      loginReCaptcha: '',
    });
    authRes = executeApiCall(
      '00_Auth_Login_Fallback',
      'POST',
      `${BASE_URL}/Public/Security/Auth`,
      fallbackPayload,
      authHeaders,
      '15s'
    );
  }

  let token = '';
  let campusIds = '2,4,1,5,3,7,8';
  try {
    const authData = JSON.parse(authRes.body);
    token = authData.token || '';
    if (authData.campusIds) campusIds = authData.campusIds;
  } catch (e) {
    // Auth parse error handled in check
  }

  if (!token) {
    sleep(1);
    return;
  }

  const apiHeaders = {
    'Content-Type': 'application/json;charset=UTF-8',
    Authorization: `Bearer ${token}`,
    __campus_ids: campusIds,
    x_jwt_id: '1',
    x_jwt_type: 'EMP',
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    'User-Agent': 'k6-load-testing-agent',
  };

  sleep(1);

  // -------------------------------------------------------------------------
  // STEP 2: Replay HAR Journey - Dashboard & Screen Configuration
  // -------------------------------------------------------------------------
  group('01_Dashboard_And_Config', function () {
    executeApiCall('01_checkUserRegisterOrNot', 'POST', `${BASE_URL}/Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot`, null, apiHeaders);
    executeApiCall('02_getLatestReleasePoster', 'GET', `${BASE_URL}/Protected/Common/GUI/getLatestReleasePoster`, null, apiHeaders);
    executeApiCall('03_getSystemMenus', 'POST', `${BASE_URL}/Protected/ScreenConfig/getSystemMenus`, null, apiHeaders);
    executeApiCall('04_GetScreens', 'POST', `${BASE_URL}/Protected/ScreenConfig/GetScreens`, null, apiHeaders);
    executeApiCall('05_getFontByErpUserId', 'POST', `${BASE_URL}/Protected/Dashboard/UserPreference/getFontByErpUserId`, null, apiHeaders);
    // Timeout set to 15s so server hang does not block execution indefinitely
    executeApiCall('06_getEmpAttendance', 'POST', `${BASE_URL}/Protected/KPServiceNew/rest/getEmpAttendance?duration=STARTTHIRTYDAYS`, null, apiHeaders, '15s');
    executeApiCall('07_getAttendanceGraph', 'POST', `${BASE_URL}/Protected/KPServiceNew/rest/getAttendanceGraph?duration=STARTTHIRTYDAYS`, null, apiHeaders, '15s');
    executeApiCall('08_getErpNotifications', 'POST', `${BASE_URL}/Protected/ScreenConfig/getErpNotifications`, null, apiHeaders);
    executeApiCall('09_getUserCampus', 'POST', `${BASE_URL}/Protected/ScreenConfig/getUserCampus`, null, apiHeaders);
    executeApiCall('10_getIsAiEnabled', 'POST', `${BASE_URL}/Protected/Common/getIsAiEnabled`, null, apiHeaders);
    executeApiCall('11_getFavouriteAndRecentList', 'POST', `${BASE_URL}/Protected/Common/GUI/getFavouriteAndRecentList`, null, apiHeaders);
  });

  sleep(1);

  // -------------------------------------------------------------------------
  // STEP 3: Replay HAR Journey - ERP Training Module
  // -------------------------------------------------------------------------
  group('02_Training_Request_Module', function () {
    const trainingPayload = JSON.stringify({
      id: '',
      quickLinkType: 'R',
      sysMenuDTO: { value: '990', label: 'Training Request' },
      sysMenuComponentPath: 'views/Support/Request/ESProTraining/TrainingRequestGrid.jsx',
      iconClassName: '',
    });

    executeApiCall('12_saveOrDeleteFavouriteAndRecent_Training', 'POST', `${BASE_URL}/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent`, trainingPayload, apiHeaders);
    executeApiCall('13_getDataByUserId', 'POST', `${BASE_URL}/Secured/AdminServices/Support/ErpTraining/getDataByUserId`, null, apiHeaders);
  });

  sleep(1);

  // -------------------------------------------------------------------------
  // STEP 4: Replay HAR Journey - Hostel Application Module
  // -------------------------------------------------------------------------
  group('03_Hostel_Application_Module', function () {
    const hostelRecentPayload = JSON.stringify({
      id: '',
      quickLinkType: 'R',
      sysMenuDTO: { value: '967', label: 'Hostel Application' },
      sysMenuComponentPath: 'views/hostel/application/OfflineHostelApplication/OfflineHostelApplicationTab.js',
      iconClassName: '',
    });

    executeApiCall('14_saveOrDeleteFavouriteAndRecent_Hostel', 'POST', `${BASE_URL}/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent`, hostelRecentPayload, apiHeaders);
    executeApiCall('15_isHighPrivilege', 'POST', `${BASE_URL}/Secured/Hostel/Application/HostelApplication/isHighPrivilege`, null, apiHeaders);
    executeApiCall('16_getAcademicYear', 'POST', `${BASE_URL}/Protected/Hostel/Common/getAcademicYear`, null, apiHeaders);
    executeApiCall('17_getHostel', 'POST', `${BASE_URL}/Protected/Hostel/Common/getHostel?showAllHostels=true&sysMenuId=967`, null, apiHeaders);
  });

  sleep(1);
}

// ---------------------------------------------------------------------------
// Custom Summary: Grafana JSON, CSV & Text Metrics (Interactive HTML removed)
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  // Generate downloadable CSV format of all API rates and user details
  let csvRows = ['Metric,Endpoint,Status,User,VU,Value'];
  if (data.metrics) {
    for (const [metricName, metricData] of Object.entries(data.metrics)) {
      if (metricData.values) {
        const val = metricData.values.count || metricData.values.rate || metricData.values.avg || 0;
        csvRows.push(`"${metricName}","ALL","ALL","ALL","ALL","${val}"`);
      }
    }
  }
  const csvContent = csvRows.join('\n');

  return {
    'tests/christ_university/reports/grafana_summary.json': JSON.stringify(data, null, 2),
    'tests/christ_university/reports/grafana_api_metrics.csv': csvContent,
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
