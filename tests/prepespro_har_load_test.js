import http from 'k6/http';
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
    const lines = file.trim().split(/\r?\n/).slice(1);
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
  const vuId = `VU_${__VU}`;
  const credIndex = credentials.length > 0 ? (__VU - 1) % credentials.length : 0;
  const student = (credentials.length > 0 && credentials[credIndex]) 
    ? credentials[credIndex] 
    : { username: vuId, course: 'GENERAL' };

  const reqHeaders = Object.assign({}, headers);
  if (session && session.token) {
    reqHeaders['Authorization'] = `Bearer ${session.token}`;
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
  apiHitsCounter.add(1, { endpoint: endpointName, status: `${res.status}`, vu: vuId });

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

  if (!is2xx) {
    let failureReason = isTimeout ? 'Timeout' : (res.error || `HTTP ${res.status}`);
    apiFailuresCounter.add(1, {
      endpoint: endpointName,
      status: `${res.status}`,
      reason: failureReason,
      vu: vuId,
    });
  }

  const checkLabel = is2xx
    ? `${endpointName} -> 200 OK (${durationMs}ms)`
    : `${endpointName} -> FAILED [Status: ${res.status}, Reason: ${isTimeout ? 'Timeout' : (res.error || 'HTTP ' + res.status)}]`;

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
    // Request #1: POST /Public/Security/Auth (Dynamic VU Authentication)
    const loginPayload = JSON.stringify({
      loginId: userCred.username,
      loginPassword: userCred.password,
      loginReCaptcha: '',
    });
    const authHeaders = {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"};
    let authRes = executeApiCall('01_Auth', 'POST', 'https://prepespro.christuniversity.in:81/Public/Security/Auth', loginPayload, authHeaders, '15s', session);
    let token = '';
    let campusIds = '2,4,1,5,6,3,7,8';
    try {
      const authData = JSON.parse(authRes.body);
      token = authData.token || '';
      if (authData.campusIds) campusIds = authData.campusIds;
    } catch (e) {}

    const isLoginOk = authRes.status === 200 && Boolean(token);
    check(authRes, {
      '01_Auth -> Student Authenticated (200 OK)': () => isLoginOk,
    });

    if (!isLoginOk) {
      // Authentication failed for this student - skip remainder of journey without faking credentials
      thinkTime(1, 2);
      return;
    }

    session.token = token;
    session.campusIds = campusIds;
    thinkTime(1, 2);

    // Request #2: OPTIONS /Public/Security/Auth
    executeApiCall('02_Auth', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Public/Security/Auth', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #3: GET /Maintenance/status.json
    executeApiCall('03_status.json', 'GET', 'https://prod-espro-public.s3.ap-south-1.amazonaws.com/Maintenance/status.json', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #4: POST /Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot
    executeApiCall('04_checkUserRegisterOrNot', 'POST', 'https://prepespro.christuniversity.in:81/Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #5: OPTIONS /Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot
    executeApiCall('05_checkUserRegisterOrNot', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #6: GET /Protected/Common/GUI/getLatestReleasePoster
    executeApiCall('06_getLatestReleasePoster', 'GET', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getLatestReleasePoster', null, {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #7: POST /Protected/ScreenConfig/getSystemMenus
    executeApiCall('07_getSystemMenus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getSystemMenus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #8: OPTIONS /Protected/Common/GUI/getLatestReleasePoster
    executeApiCall('08_getLatestReleasePoster', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getLatestReleasePoster', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #9: POST /Protected/ScreenConfig/GetScreens
    executeApiCall('09_GetScreens', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/GetScreens', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #10: OPTIONS /Protected/ScreenConfig/getSystemMenus
    executeApiCall('10_getSystemMenus', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getSystemMenus', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #11: POST /Protected/Dashboard/UserPreference/getFontByErpUserId
    executeApiCall('11_getFontByErpUserId', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Dashboard/UserPreference/getFontByErpUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #12: OPTIONS /Protected/ScreenConfig/GetScreens
    executeApiCall('12_GetScreens', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/GetScreens', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #13: OPTIONS /Protected/Dashboard/UserPreference/getFontByErpUserId
    executeApiCall('13_getFontByErpUserId', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Dashboard/UserPreference/getFontByErpUserId', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #14: GET /static
    executeApiCall('14_static', 'GET', 'https://accredita.christuniversity.in/static?file_name=logo-black.png', null, {"referer":"https://prepespro.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #15: POST /Protected/KPServiceNew/rest/getEmpAttendance
    executeApiCall('15_getEmpAttendance', 'POST', 'https://prepespro.christuniversity.in:81/Protected/KPServiceNew/rest/getEmpAttendance?duration=STARTTHIRTYDAYS', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #16: OPTIONS /Protected/KPServiceNew/rest/getEmpAttendance
    executeApiCall('16_getEmpAttendance', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/KPServiceNew/rest/getEmpAttendance?duration=STARTTHIRTYDAYS', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #17: POST /Protected/KPServiceNew/rest/getAttendanceGraph
    executeApiCall('17_getAttendanceGraph', 'POST', 'https://prepespro.christuniversity.in:81/Protected/KPServiceNew/rest/getAttendanceGraph?duration=STARTTHIRTYDAYS', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #18: OPTIONS /Protected/KPServiceNew/rest/getAttendanceGraph
    executeApiCall('18_getAttendanceGraph', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/KPServiceNew/rest/getAttendanceGraph?duration=STARTTHIRTYDAYS', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #19: POST /Protected/ScreenConfig/getErpNotifications
    executeApiCall('19_getErpNotifications', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getErpNotifications', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #20: OPTIONS /Protected/ScreenConfig/getErpNotifications
    executeApiCall('20_getErpNotifications', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getErpNotifications', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #21: POST /Protected/ScreenConfig/getUserCampus
    executeApiCall('21_getUserCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getUserCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #22: OPTIONS /Protected/ScreenConfig/getUserCampus
    executeApiCall('22_getUserCampus', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getUserCampus', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #23: POST /Protected/Common/getIsAiEnabled
    executeApiCall('23_getIsAiEnabled', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getIsAiEnabled', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #24: OPTIONS /Protected/Common/getIsAiEnabled
    executeApiCall('24_getIsAiEnabled', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/getIsAiEnabled', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #25: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('25_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #26: OPTIONS /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('26_getFavouriteAndRecentList', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #27: GET /ERP/assets/TrainingRequestGrid-DqRwc4nT.js
    executeApiCall('27_TrainingRequestGrid-DqRwc4nT.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/TrainingRequestGrid-DqRwc4nT.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #28: GET /ERP/assets/AgGridTable-ajHV_YME.js
    executeApiCall('28_AgGridTable-ajHV_YME.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/AgGridTable-ajHV_YME.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #29: GET /ERP/assets/DragIndicator-wkned60S.js
    executeApiCall('29_DragIndicator-wkned60S.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/DragIndicator-wkned60S.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #30: GET /ERP/assets/main-DDw50E1V.js
    executeApiCall('30_main-DDw50E1V.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/main-DDw50E1V.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #31: GET /ERP/assets/ListviewAggridCustumComponent-CLoo63rk.js
    executeApiCall('31_ListviewAggridCustumComponent-CLoo63rk.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/ListviewAggridCustumComponent-CLoo63rk.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #32: GET /ERP/assets/DeleteIconRenderedComponent-CIyTWuJt.js
    executeApiCall('32_DeleteIconRenderedComponent-CIyTWuJt.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/DeleteIconRenderedComponent-CIyTWuJt.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #33: GET /ERP/assets/Close-B1eTFIU1.js
    executeApiCall('33_Close-B1eTFIU1.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/Close-B1eTFIU1.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #34: GET /ERP/assets/index-CYydPY1x.js
    executeApiCall('34_index-CYydPY1x.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/index-CYydPY1x.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #35: GET /ERP/assets/localeData-BeS_Xirp.js
    executeApiCall('35_localeData-BeS_Xirp.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/localeData-BeS_Xirp.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #36: GET /ERP/assets/customParseFormat-CF-vU0FG.js
    executeApiCall('36_customParseFormat-CF-vU0FG.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/customParseFormat-CF-vU0FG.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #37: GET /ERP/assets/PurePanel-Y3tpCNta.js
    executeApiCall('37_PurePanel-Y3tpCNta.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/PurePanel-Y3tpCNta.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #38: GET /ERP/assets/useIcons-CO3dYS7x.js
    executeApiCall('38_useIcons-CO3dYS7x.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/useIcons-CO3dYS7x.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #39: GET /ERP/assets/DownOutlined-B4WlcHXH.js
    executeApiCall('39_DownOutlined-B4WlcHXH.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/DownOutlined-B4WlcHXH.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #40: GET /ERP/assets/CalendarToday-CN5aEAnS.js
    executeApiCall('40_CalendarToday-CN5aEAnS.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/CalendarToday-CN5aEAnS.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #41: GET /ERP/assets/Delete-DvNTYSSl.js
    executeApiCall('41_Delete-DvNTYSSl.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/Delete-DvNTYSSl.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #42: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('42_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":\"\",\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"990\",\"label\":\"Training Request\"},\"sysMenuComponentPath\":\"views/Support/Request/ESProTraining/TrainingRequestGrid.jsx\",\"iconClassName\":\"\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #43: OPTIONS /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('43_saveOrDeleteFavouriteAndRecent', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #44: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('44_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #45: OPTIONS /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('45_getFavouriteAndRecentList', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #46: POST /Secured/AdminServices/Support/ErpTraining/getDataByUserId
    executeApiCall('46_getDataByUserId', 'POST', 'https://prepespro.christuniversity.in:81/Secured/AdminServices/Support/ErpTraining/getDataByUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #47: OPTIONS /Secured/AdminServices/Support/ErpTraining/getDataByUserId
    executeApiCall('47_getDataByUserId', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Secured/AdminServices/Support/ErpTraining/getDataByUserId', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #48: GET /ERP/assets/OfflineHostelApplicationTab-B8lqy1gt.js
    executeApiCall('48_OfflineHostelApplicationTab-B8lqy1gt.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/OfflineHostelApplicationTab-B8lqy1gt.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #49: GET /ERP/assets/HostelRoomAvailablePopup-BFDgvUFc.js
    executeApiCall('49_HostelRoomAvailablePopup-BFDgvUFc.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/HostelRoomAvailablePopup-BFDgvUFc.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #50: GET /ERP/assets/Remove-DD0YVfMs.js
    executeApiCall('50_Remove-DD0YVfMs.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/Remove-DD0YVfMs.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #51: GET /ERP/assets/index-ClcXbEW-.js
    executeApiCall('51_index-ClcXbEW-.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/index-ClcXbEW-.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #52: GET /ERP/assets/ActionButton-CPeyoPU7.js
    executeApiCall('52_ActionButton-CPeyoPU7.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/ActionButton-CPeyoPU7.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #53: GET /ERP/assets/index-LwFGpdW8.js
    executeApiCall('53_index-LwFGpdW8.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/index-LwFGpdW8.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #54: GET /ERP/assets/ToggleButtonGroup-B95osIK8.js
    executeApiCall('54_ToggleButtonGroup-B95osIK8.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/ToggleButtonGroup-B95osIK8.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #55: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('55_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":\"\",\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"967\",\"label\":\"Hostel Application\"},\"sysMenuComponentPath\":\"views/hostel/application/OfflineHostelApplication/OfflineHostelApplicationTab.js\",\"iconClassName\":\"\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #56: OPTIONS /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('56_saveOrDeleteFavouriteAndRecent', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #57: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('57_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #58: OPTIONS /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('58_getFavouriteAndRecentList', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #59: POST /Secured/Hostel/Application/HostelApplication/isHighPrivilege
    executeApiCall('59_isHighPrivilege', 'POST', 'https://prepespro.christuniversity.in:81/Secured/Hostel/Application/HostelApplication/isHighPrivilege', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #60: OPTIONS /Secured/Hostel/Application/HostelApplication/isHighPrivilege
    executeApiCall('60_isHighPrivilege', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Secured/Hostel/Application/HostelApplication/isHighPrivilege', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #61: POST /Protected/Hostel/Common/getAcademicYear
    executeApiCall('61_getAcademicYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getAcademicYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #62: POST /Protected/Hostel/Common/getHostel
    executeApiCall('62_getHostel', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getHostel?showAllHostels=true&sysMenuId=967', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #63: OPTIONS /Protected/Hostel/Common/getAcademicYear
    executeApiCall('63_getAcademicYear', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getAcademicYear', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #64: OPTIONS /Protected/Hostel/Common/getHostel
    executeApiCall('64_getHostel', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getHostel?showAllHostels=true&sysMenuId=967', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

  });
}

export function handleSummary(data) {
  return {
    'tests/christ_university/reports/grafana_summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
