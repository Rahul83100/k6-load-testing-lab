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
    // Request #1: POST /auth/realms/Student/login-actions/authenticate
    executeApiCall('01_authenticate', 'POST', 'https://studentespro.christuniversity.in/auth/realms/Student/login-actions/authenticate?session_code=7FFf0MvM59QIbxJxFjpGPgILbtbxBYA7q-AVKFzz3kM&execution=41cc53aa-ec6d-4029-92ec-fb90577e931a&client_id=react-app&tab_id=fAqEvX3iECM&client_data=eyJydSI6Imh0dHBzOi8vY3VlLmNocmlzdHVuaXZlcnNpdHkuaW4vIiwicnQiOiJjb2RlIiwicm0iOiJmcmFnbWVudCIsInN0IjoiYjJsa1l5MXpjR0V1a0R3c2FrdUZXLTl5M0laUUR0NzIifQ', "username=2440166&password=55198823&credentialId=", {"Content-Type":"application/x-www-form-urlencoded","Origin":"null","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #2: GET /
    executeApiCall('02_endpoint', 'GET', 'https://cue.christuniversity.in/', null, {"user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #3: GET /config.js
    executeApiCall('03_config.js', 'GET', 'https://cue.christuniversity.in/config.js?v=1791285763332', null, {"referer":"https://cue.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #4: GET /assets/index.C_ni27Tb.js
    executeApiCall('04_index.C_ni27Tb.js', 'GET', 'https://cue.christuniversity.in/assets/index.C_ni27Tb.js', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/"}, '15s', session);
    thinkTime(1, 3);

    // Request #5: GET /assets/index.BZ4km8gr.js
    executeApiCall('05_index.BZ4km8gr.js', 'GET', 'https://cue.christuniversity.in/assets/index.BZ4km8gr.js', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/"}, '15s', session);
    thinkTime(1, 3);

    // Request #6: GET /assets/desiredPostLoginRedirectUrl.-AbHTvC5.js
    executeApiCall('06_desiredPostLoginRedirectUrl.-AbHTvC5.js', 'GET', 'https://cue.christuniversity.in/assets/desiredPostLoginRedirectUrl.-AbHTvC5.js', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/"}, '15s', session);
    thinkTime(1, 3);

    // Request #7: GET /assets/urlSearchParams.CpA8CwXx.js
    executeApiCall('07_urlSearchParams.CpA8CwXx.js', 'GET', 'https://cue.christuniversity.in/assets/urlSearchParams.CpA8CwXx.js', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/"}, '15s', session);
    thinkTime(1, 3);

    // Request #8: GET /assets/getServerDateNow.ClXIBgLt.js
    executeApiCall('08_getServerDateNow.ClXIBgLt.js', 'GET', 'https://cue.christuniversity.in/assets/getServerDateNow.ClXIBgLt.js', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/"}, '15s', session);
    thinkTime(1, 3);

    // Request #9: GET /assets/main.DhjOLAEc.js
    executeApiCall('09_main.DhjOLAEc.js', 'GET', 'https://cue.christuniversity.in/assets/main.DhjOLAEc.js', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/"}, '15s', session);
    thinkTime(1, 3);

    // Request #10: HEAD /config.js
    executeApiCall('10_config.js', 'HEAD', 'https://cue.christuniversity.in/config.js', null, {"referer":"https://cue.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #11: GET /assets/AuthProvider.CKJrTQKL.js
    executeApiCall('11_AuthProvider.CKJrTQKL.js', 'GET', 'https://cue.christuniversity.in/assets/AuthProvider.CKJrTQKL.js', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/"}, '15s', session);
    thinkTime(1, 3);

    // Request #12: GET /assets/oidcConfig.C_l2ZOmt.js
    executeApiCall('12_oidcConfig.C_l2ZOmt.js', 'GET', 'https://cue.christuniversity.in/assets/oidcConfig.C_l2ZOmt.js', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/"}, '15s', session);
    thinkTime(1, 3);

    // Request #13: POST /auth/realms/Student/protocol/openid-connect/token
    executeApiCall('13_token', 'POST', 'https://studentespro.christuniversity.in/auth/realms/Student/protocol/openid-connect/token', "grant_type=authorization_code&redirect_uri=https%3A%2F%2Fcue.christuniversity.in%2F&code=08ad0a1b-cd65-9852-90cf-e9f2eae9ebeb.AfZHxxfEJ02KeIFBb41mLckC.bc0622e2-6d4d-47ee-ad38-12d8abd3320b&code_verifier=e9494d3b7eba4fdfbc6b9de907c74318a2c83eb2b20148c1bddea88390a62868420b58487bd442d7ac6903cfbc814018&client_id=react-app", {"Content-Type":"application/x-www-form-urlencoded","Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #14: OPTIONS /auth/realms/Student/protocol/openid-connect/token
    executeApiCall('14_token', 'OPTIONS', 'https://studentespro.christuniversity.in/auth/realms/Student/protocol/openid-connect/token', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #15: GET /assets/WebProtectedRoute.C9tii17f.js
    executeApiCall('15_WebProtectedRoute.C9tii17f.js', 'GET', 'https://cue.christuniversity.in/assets/WebProtectedRoute.C9tii17f.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #16: GET /assets/web.e4q-deYh.js
    executeApiCall('16_web.e4q-deYh.js', 'GET', 'https://cue.christuniversity.in/assets/web.e4q-deYh.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #17: GET /assets/Home.e0dEAAPO.js
    executeApiCall('17_Home.e0dEAAPO.js', 'GET', 'https://cue.christuniversity.in/assets/Home.e0dEAAPO.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #18: GET /assets/ArrowForward.BC6QlcYb.js
    executeApiCall('18_ArrowForward.BC6QlcYb.js', 'GET', 'https://cue.christuniversity.in/assets/ArrowForward.BC6QlcYb.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #19: GET /assets/CheckCircleOutline.CQhB3KzZ.js
    executeApiCall('19_CheckCircleOutline.CQhB3KzZ.js', 'GET', 'https://cue.christuniversity.in/assets/CheckCircleOutline.CQhB3KzZ.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #20: GET /assets/Stack.D02NRK7j.js
    executeApiCall('20_Stack.D02NRK7j.js', 'GET', 'https://cue.christuniversity.in/assets/Stack.D02NRK7j.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #21: GET /assets/styled.BOuGvz6l.js
    executeApiCall('21_styled.BOuGvz6l.js', 'GET', 'https://cue.christuniversity.in/assets/styled.BOuGvz6l.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #22: GET /assets/useThemeProps.BkuzUr3T.js
    executeApiCall('22_useThemeProps.BkuzUr3T.js', 'GET', 'https://cue.christuniversity.in/assets/useThemeProps.BkuzUr3T.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #23: GET /assets/Skeleton.C5E2TOqj.js
    executeApiCall('23_Skeleton.C5E2TOqj.js', 'GET', 'https://cue.christuniversity.in/assets/Skeleton.C5E2TOqj.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #24: GET /assets/CustomButton.B9dTeyD_.js
    executeApiCall('24_CustomButton.B9dTeyD_.js', 'GET', 'https://cue.christuniversity.in/assets/CustomButton.B9dTeyD_.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #25: GET /assets/CardContent.CcVd_Eac.js
    executeApiCall('25_CardContent.CcVd_Eac.js', 'GET', 'https://cue.christuniversity.in/assets/CardContent.CcVd_Eac.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #26: GET /assets/Input.Ez3DSPC-.js
    executeApiCall('26_Input.Ez3DSPC-.js', 'GET', 'https://cue.christuniversity.in/assets/Input.Ez3DSPC-.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #27: GET /assets/sanitize.BxxWzxDd.js
    executeApiCall('27_sanitize.BxxWzxDd.js', 'GET', 'https://cue.christuniversity.in/assets/sanitize.BxxWzxDd.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #28: GET /assets/purify.es.Jn2rvFN8.js
    executeApiCall('28_purify.es.Jn2rvFN8.js', 'GET', 'https://cue.christuniversity.in/assets/purify.es.Jn2rvFN8.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #29: GET /assets/Search.KYxrZczp.js
    executeApiCall('29_Search.KYxrZczp.js', 'GET', 'https://cue.christuniversity.in/assets/Search.KYxrZczp.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #30: GET /assets/FormControl.Br4MpNF8.js
    executeApiCall('30_FormControl.Br4MpNF8.js', 'GET', 'https://cue.christuniversity.in/assets/FormControl.Br4MpNF8.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #31: GET /assets/utils.DoM3o7-Q.js
    executeApiCall('31_utils.DoM3o7-Q.js', 'GET', 'https://cue.christuniversity.in/assets/utils.DoM3o7-Q.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #32: GET /assets/useFormControl.BLnH7zF1.js
    executeApiCall('32_useFormControl.BLnH7zF1.js', 'GET', 'https://cue.christuniversity.in/assets/useFormControl.BLnH7zF1.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #33: GET /assets/InputLabel.CD64PO-W.js
    executeApiCall('33_InputLabel.CD64PO-W.js', 'GET', 'https://cue.christuniversity.in/assets/InputLabel.CD64PO-W.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #34: GET /assets/formControlState.Dq1zat_P.js
    executeApiCall('34_formControlState.Dq1zat_P.js', 'GET', 'https://cue.christuniversity.in/assets/formControlState.Dq1zat_P.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #35: GET /assets/Select.CGlTkJ78.js
    executeApiCall('35_Select.CGlTkJ78.js', 'GET', 'https://cue.christuniversity.in/assets/Select.CGlTkJ78.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #36: GET /assets/InputBase.BGncOAhP.js
    executeApiCall('36_InputBase.BGncOAhP.js', 'GET', 'https://cue.christuniversity.in/assets/InputBase.BGncOAhP.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #37: GET /assets/TextField.DN1P_8_Y.js
    executeApiCall('37_TextField.DN1P_8_Y.js', 'GET', 'https://cue.christuniversity.in/assets/TextField.DN1P_8_Y.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #38: GET /assets/InputAdornment.D81KSgi5.js
    executeApiCall('38_InputAdornment.D81KSgi5.js', 'GET', 'https://cue.christuniversity.in/assets/InputAdornment.D81KSgi5.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #39: GET /assets/Chip.Diw4M-3D.js
    executeApiCall('39_Chip.Diw4M-3D.js', 'GET', 'https://cue.christuniversity.in/assets/Chip.Diw4M-3D.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #40: GET /assets/RadioGroup.Dx5OtsCI.js
    executeApiCall('40_RadioGroup.Dx5OtsCI.js', 'GET', 'https://cue.christuniversity.in/assets/RadioGroup.Dx5OtsCI.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #41: GET /assets/SwitchBase._eKOx3m2.js
    executeApiCall('41_SwitchBase._eKOx3m2.js', 'GET', 'https://cue.christuniversity.in/assets/SwitchBase._eKOx3m2.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #42: GET /assets/FormControlLabel.DYrvY0iT.js
    executeApiCall('42_FormControlLabel.DYrvY0iT.js', 'GET', 'https://cue.christuniversity.in/assets/FormControlLabel.DYrvY0iT.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #43: GET /assets/Grid.CIJj_LNJ.js
    executeApiCall('43_Grid.CIJj_LNJ.js', 'GET', 'https://cue.christuniversity.in/assets/Grid.CIJj_LNJ.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #44: GET /assets/file-text.yCDNJvjR.js
    executeApiCall('44_file-text.yCDNJvjR.js', 'GET', 'https://cue.christuniversity.in/assets/file-text.yCDNJvjR.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #45: GET /assets/clipboard-list.BG-f77y4.js
    executeApiCall('45_clipboard-list.BG-f77y4.js', 'GET', 'https://cue.christuniversity.in/assets/clipboard-list.BG-f77y4.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #46: GET /assets/graduation-cap.B3gPJuCZ.js
    executeApiCall('46_graduation-cap.B3gPJuCZ.js', 'GET', 'https://cue.christuniversity.in/assets/graduation-cap.B3gPJuCZ.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #47: GET /assets/Today.DwBoGOlu.js
    executeApiCall('47_Today.DwBoGOlu.js', 'GET', 'https://cue.christuniversity.in/assets/Today.DwBoGOlu.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #48: GET /assets/LocationOn.CjyUH70L.js
    executeApiCall('48_LocationOn.CjyUH70L.js', 'GET', 'https://cue.christuniversity.in/assets/LocationOn.CjyUH70L.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #49: GET /assets/LinearProgress.CFWE2uI5.js
    executeApiCall('49_LinearProgress.CFWE2uI5.js', 'GET', 'https://cue.christuniversity.in/assets/LinearProgress.CFWE2uI5.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #50: GET /assets/web.COBBvK1c.js
    executeApiCall('50_web.COBBvK1c.js', 'GET', 'https://cue.christuniversity.in/assets/web.COBBvK1c.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #51: GET /Maintenance/status.json
    executeApiCall('51_status.json', 'GET', 'https://prod-espro-public.s3.ap-south-1.amazonaws.com/Maintenance/status.json', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #52: GET /version.json
    executeApiCall('52_version.json', 'GET', 'https://cue.christuniversity.in/version.json?t=1791285763872', null, {"referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #53: GET /assets/web.Cu9T_ks5.js
    executeApiCall('53_web.Cu9T_ks5.js', 'GET', 'https://cue.christuniversity.in/assets/web.Cu9T_ks5.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/home","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #54: POST /Protected/StudentServices/Common/getNotificationCount
    executeApiCall('54_getNotificationCount', 'POST', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getNotificationCount', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #55: OPTIONS /Protected/StudentServices/Common/getNotificationCount
    executeApiCall('55_getNotificationCount', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getNotificationCount', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #56: POST /Protected/KPServiceNew/rest/isCBCSStudent
    executeApiCall('56_isCBCSStudent', 'POST', 'https://espro.christuniversity.in:84/Protected/KPServiceNew/rest/isCBCSStudent', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #57: POST /Protected/StudentServices/Student/StudentProfile/getStudentProfileData
    executeApiCall('57_getStudentProfileData', 'POST', 'https://espro.christuniversity.in:84/Protected/StudentServices/Student/StudentProfile/getStudentProfileData', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #58: POST /Protected/StudentServices/themes/getThemes
    executeApiCall('58_getThemes', 'POST', 'https://espro.christuniversity.in:84/Protected/StudentServices/themes/getThemes', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #59: OPTIONS /Protected/KPServiceNew/rest/isCBCSStudent
    executeApiCall('59_isCBCSStudent', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/KPServiceNew/rest/isCBCSStudent', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #60: POST /Protected/StudentServices/Common/getReleaseDetails
    executeApiCall('60_getReleaseDetails', 'POST', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getReleaseDetails', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #61: OPTIONS /Protected/StudentServices/Student/StudentProfile/getStudentProfileData
    executeApiCall('61_getStudentProfileData', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/StudentServices/Student/StudentProfile/getStudentProfileData', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #62: POST /Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentClass
    executeApiCall('62_getStudentClass', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentClass', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #63: POST /Protected/StudentServices/Common/getActionableItems
    executeApiCall('63_getActionableItems', 'POST', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getActionableItems', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #64: OPTIONS /Protected/StudentServices/themes/getThemes
    executeApiCall('64_getThemes', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/StudentServices/themes/getThemes', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #65: POST /Protected/StudentServices/Common/getActionableItems
    executeApiCall('65_getActionableItems', 'POST', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getActionableItems', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #66: OPTIONS /Protected/StudentServices/Common/getReleaseDetails
    executeApiCall('66_getReleaseDetails', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getReleaseDetails', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #67: OPTIONS /Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentClass
    executeApiCall('67_getStudentClass', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentClass', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #68: OPTIONS /Protected/StudentServices/Common/getActionableItems
    executeApiCall('68_getActionableItems', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getActionableItems', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #69: OPTIONS /Protected/StudentServices/Common/getActionableItems
    executeApiCall('69_getActionableItems', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getActionableItems', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #70: POST /Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentClass
    executeApiCall('70_getStudentClass', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentClass', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #71: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getOverallPercentage
    executeApiCall('71_getOverallPercentage', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getOverallPercentage', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #72: POST /Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentTimetable
    executeApiCall('72_getStudentTimetable', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentTimetable', "{\"startDate\":\"2026-10-06\",\"endDate\":\"2026-10-06\"}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #73: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getOverallPercentage
    executeApiCall('73_getOverallPercentage', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getOverallPercentage', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #74: POST /Protected/StudentServices/ScreenConfig/getErpNotifications
    executeApiCall('74_getErpNotifications', 'POST', 'https://espro.christuniversity.in:84/Protected/StudentServices/ScreenConfig/getErpNotifications', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #75: OPTIONS /Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentTimetable
    executeApiCall('75_getStudentTimetable', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassTimetableServices/Student/StudentTimeTable/getStudentTimetable', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #76: GET /auth/realms/Student/account/credentials
    executeApiCall('76_credentials', 'GET', 'https://studentespro.christuniversity.in/auth/realms/Student/account/credentials', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #77: OPTIONS /Protected/StudentServices/ScreenConfig/getErpNotifications
    executeApiCall('77_getErpNotifications', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/StudentServices/ScreenConfig/getErpNotifications', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #78: POST /Protected/StudentServices/Hostel/HostelAdmission/isStudentEligibleForHostelMenu
    executeApiCall('78_isStudentEligibleForHostelMenu', 'POST', 'https://espro.christuniversity.in:84/Protected/StudentServices/Hostel/HostelAdmission/isStudentEligibleForHostelMenu', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #79: OPTIONS /auth/realms/Student/account/credentials
    executeApiCall('79_credentials', 'OPTIONS', 'https://studentespro.christuniversity.in/auth/realms/Student/account/credentials', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #80: POST /Protected/StudentServices/Common/getSysMenu
    executeApiCall('80_getSysMenu', 'POST', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getSysMenu?platform=web', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #81: OPTIONS /Protected/StudentServices/Hostel/HostelAdmission/isStudentEligibleForHostelMenu
    executeApiCall('81_isStudentEligibleForHostelMenu', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/StudentServices/Hostel/HostelAdmission/isStudentEligibleForHostelMenu', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #82: OPTIONS /Protected/StudentServices/Common/getSysMenu
    executeApiCall('82_getSysMenu', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/StudentServices/Common/getSysMenu?platform=web', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #83: GET /assets/Attendance.D8XEjfM7.js
    executeApiCall('83_Attendance.D8XEjfM7.js', 'GET', 'https://cue.christuniversity.in/assets/Attendance.D8XEjfM7.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #84: GET /assets/KeyboardArrowUp.DX05fVDY.js
    executeApiCall('84_KeyboardArrowUp.DX05fVDY.js', 'GET', 'https://cue.christuniversity.in/assets/KeyboardArrowUp.DX05fVDY.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #85: GET /assets/Event.CBsDo6d0.js
    executeApiCall('85_Event.CBsDo6d0.js', 'GET', 'https://cue.christuniversity.in/assets/Event.CBsDo6d0.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #86: GET /assets/MedicalServices.TjlR2Jt6.js
    executeApiCall('86_MedicalServices.TjlR2Jt6.js', 'GET', 'https://cue.christuniversity.in/assets/MedicalServices.TjlR2Jt6.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #87: GET /assets/getValidReactChildren.By7zkRRp.js
    executeApiCall('87_getValidReactChildren.By7zkRRp.js', 'GET', 'https://cue.christuniversity.in/assets/getValidReactChildren.By7zkRRp.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #88: GET /assets/MenuBook.CV2u9ogd.js
    executeApiCall('88_MenuBook.CV2u9ogd.js', 'GET', 'https://cue.christuniversity.in/assets/MenuBook.CV2u9ogd.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #89: GET /assets/KeyboardArrowDown.Bn7oQll_.js
    executeApiCall('89_KeyboardArrowDown.Bn7oQll_.js', 'GET', 'https://cue.christuniversity.in/assets/KeyboardArrowDown.Bn7oQll_.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #90: GET /assets/ArrowForwardIos.DF72dhMf.js
    executeApiCall('90_ArrowForwardIos.DF72dhMf.js', 'GET', 'https://cue.christuniversity.in/assets/ArrowForwardIos.DF72dhMf.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #91: GET /assets/Download.mJ5sr7up.js
    executeApiCall('91_Download.mJ5sr7up.js', 'GET', 'https://cue.christuniversity.in/assets/Download.mJ5sr7up.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #92: GET /assets/ViewModule.5NCUl9_z.js
    executeApiCall('92_ViewModule.5NCUl9_z.js', 'GET', 'https://cue.christuniversity.in/assets/ViewModule.5NCUl9_z.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #93: GET /assets/AccordionSummary.DrtrRIfA.js
    executeApiCall('93_AccordionSummary.DrtrRIfA.js', 'GET', 'https://cue.christuniversity.in/assets/AccordionSummary.DrtrRIfA.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #94: GET /assets/Collapse.DZzVbUih.js
    executeApiCall('94_Collapse.DZzVbUih.js', 'GET', 'https://cue.christuniversity.in/assets/Collapse.DZzVbUih.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #95: GET /assets/TableRow.DVI6CLGZ.js
    executeApiCall('95_TableRow.DVI6CLGZ.js', 'GET', 'https://cue.christuniversity.in/assets/TableRow.DVI6CLGZ.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/attendence","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #96: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters
    executeApiCall('96_getStudentSemesters', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #97: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters
    executeApiCall('97_getStudentSemesters', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #98: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount
    executeApiCall('98_getAttendanceCount', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #99: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount
    executeApiCall('99_getAttendanceCount', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount?sessionId=10', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #100: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance
    executeApiCall('100_getCourseWiseAttendance', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #101: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime
    executeApiCall('101_getLastSinkDateTime', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #102: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance
    executeApiCall('102_getCourseWiseAttendance', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance?sessionId=10', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #103: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime
    executeApiCall('103_getLastSinkDateTime', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime?sessionId=10', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #104: GET /assets/Absenceregularcourwise.DzpPqmoz.js
    executeApiCall('104_Absenceregularcourwise.DzpPqmoz.js', 'GET', 'https://cue.christuniversity.in/assets/Absenceregularcourwise.DzpPqmoz.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/AbsentDetails","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #105: GET /assets/TableRows.BERjvKNZ.js
    executeApiCall('105_TableRows.BERjvKNZ.js', 'GET', 'https://cue.christuniversity.in/assets/TableRows.BERjvKNZ.js', null, {"origin":"https://cue.christuniversity.in","referer":"https://cue.christuniversity.in/main/AbsentDetails","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #106: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails
    executeApiCall('106_getCourseAbsentDetails', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails?courseId=5533&sessionId=10&isExtracurricular=false&showCocurricularAbsentDetails=false', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #107: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails
    executeApiCall('107_getCourseAbsentDetails', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails?courseId=5533&sessionId=10&isExtracurricular=false&showCocurricularAbsentDetails=false', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #108: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters
    executeApiCall('108_getStudentSemesters', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #109: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters
    executeApiCall('109_getStudentSemesters', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #110: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount
    executeApiCall('110_getAttendanceCount', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #111: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance
    executeApiCall('111_getCourseWiseAttendance', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #112: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount
    executeApiCall('112_getAttendanceCount', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount?sessionId=10', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #113: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime
    executeApiCall('113_getLastSinkDateTime', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #114: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance
    executeApiCall('114_getCourseWiseAttendance', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance?sessionId=10', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #115: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime
    executeApiCall('115_getLastSinkDateTime', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime?sessionId=10', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #116: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails
    executeApiCall('116_getCourseAbsentDetails', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails?courseId=13658&sessionId=10&isExtracurricular=false&showCocurricularAbsentDetails=false', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #117: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails
    executeApiCall('117_getCourseAbsentDetails', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails?courseId=13658&sessionId=10&isExtracurricular=false&showCocurricularAbsentDetails=false', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #118: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters
    executeApiCall('118_getStudentSemesters', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #119: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount
    executeApiCall('119_getAttendanceCount', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #120: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance
    executeApiCall('120_getCourseWiseAttendance', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #121: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime
    executeApiCall('121_getLastSinkDateTime', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #122: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails
    executeApiCall('122_getCourseAbsentDetails', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails?courseId=5736&sessionId=10&isExtracurricular=false&showCocurricularAbsentDetails=false', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #123: OPTIONS /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails
    executeApiCall('123_getCourseAbsentDetails', 'OPTIONS', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseAbsentDetails?courseId=5736&sessionId=10&isExtracurricular=false&showCocurricularAbsentDetails=false', null, {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #124: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters
    executeApiCall('124_getStudentSemesters', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getStudentSemesters', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #125: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount
    executeApiCall('125_getAttendanceCount', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getAttendanceCount?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #126: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance
    executeApiCall('126_getCourseWiseAttendance', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getCourseWiseAttendance?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

    // Request #127: POST /Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime
    executeApiCall('127_getLastSinkDateTime', 'POST', 'https://espro.christuniversity.in:84/Protected/ClassRoomAttendanceServices/Student/StudentAttendance/getLastSinkDateTime?sessionId=10', "{}", {"Origin":"https://cue.christuniversity.in","Referer":"https://cue.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","content-type":"application/json"}, '15s', session);
    thinkTime(1, 3);

  });
}

export function handleSummary(data) {
  return {
    'tests/christ_university/reports/grafana_summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
