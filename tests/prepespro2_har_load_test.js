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
    // Request #1: GET /ERP/config.json
    executeApiCall('01_config.json', 'GET', 'https://prepespro.christuniversity.in/ERP/config.json?t=1790595292144', null, {"Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #2: POST /Public/Security/Auth (Dynamic VU Authentication)
    const loginPayload = JSON.stringify({
      loginId: userCred.username,
      loginPassword: userCred.password,
      loginReCaptcha: '',
    });
    const authHeaders = {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"};
    let authRes = executeApiCall('02_Auth', 'POST', 'https://prepespro.christuniversity.in:81/Public/Security/Auth', loginPayload, authHeaders, '15s', session);
    let token = '';
    let campusIds = '2,4,1,5,6,3,7,8';
    try {
      const authData = JSON.parse(authRes.body);
      token = authData.token || '';
      if (authData.campusIds) campusIds = authData.campusIds;
    } catch (e) {}

    const isLoginOk = authRes.status === 200 && Boolean(token);
    check(authRes, {
      '02_Auth -> Student Authenticated (200 OK)': () => isLoginOk,
    });

    if (!isLoginOk) {
      // Authentication failed for this student - skip remainder of journey without faking credentials
      thinkTime(1, 2);
      return;
    }

    session.token = token;
    session.campusIds = campusIds;
    thinkTime(1, 2);

    // Request #3: GET /Maintenance/status.json
    executeApiCall('03_status.json', 'GET', 'https://prod-espro-public.s3.ap-south-1.amazonaws.com/Maintenance/status.json', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #4: POST /Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot
    executeApiCall('04_checkUserRegisterOrNot', 'POST', 'https://prepespro.christuniversity.in:81/Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #5: GET /Protected/Common/GUI/getLatestReleasePoster
    executeApiCall('05_getLatestReleasePoster', 'GET', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getLatestReleasePoster', null, {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #6: POST /Protected/ScreenConfig/getSystemMenus
    executeApiCall('06_getSystemMenus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getSystemMenus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #7: POST /Protected/ScreenConfig/GetScreens
    executeApiCall('07_GetScreens', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/GetScreens', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #8: POST /Protected/Dashboard/UserPreference/getFontByErpUserId
    executeApiCall('08_getFontByErpUserId', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Dashboard/UserPreference/getFontByErpUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #9: POST /Protected/ScreenConfig/getErpNotifications
    executeApiCall('09_getErpNotifications', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getErpNotifications', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #10: POST /Protected/ScreenConfig/getUserCampus
    executeApiCall('10_getUserCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getUserCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #11: POST /Protected/Common/getIsAiEnabled
    executeApiCall('11_getIsAiEnabled', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getIsAiEnabled', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #12: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('12_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #13: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('13_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":1214071,\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"1052\",\"label\":\"Timetable View \"},\"sysMenuComponentPath\":\"views/curriculum/TimeTable/TimeTableView/TimeTableView.js\",\"iconClassName\":\"fa-solid fa-book-open-reader\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #14: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('14_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #15: POST /Protected/ClassTimetableServices/Common/getAcademicYearNew
    executeApiCall('15_getAcademicYearNew', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getAcademicYearNew', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #16: POST /Protected/Common/getCampusesByUserPrivilegeNew
    executeApiCall('16_getCampusesByUserPrivilegeNew', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampusesByUserPrivilegeNew?sysMenuId=1052', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #17: POST /Protected/Employee/CommonEmployee/getEmpIdByUserId
    executeApiCall('17_getEmpIdByUserId', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Employee/CommonEmployee/getEmpIdByUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #18: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForIPMStaff
    executeApiCall('18_privilegeEnabledForIPMStaff', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForIPMStaff', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #19: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForHOD
    executeApiCall('19_privilegeEnabledForHOD', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForHOD', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #20: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForFaculty
    executeApiCall('20_privilegeEnabledForFaculty', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForFaculty', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #21: POST /Protected/Common/getDepartmentByUser
    executeApiCall('21_getDepartmentByUser', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getDepartmentByUser', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #22: POST /Protected/ClassTimetableServices/Common/getSessionType
    executeApiCall('22_getSessionType', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getSessionType', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #23: POST /Protected/Curriculum/Common/CommonCurriculum/getEmpsByDepartment
    executeApiCall('23_getEmpsByDepartment', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Curriculum/Common/CommonCurriculum/getEmpsByDepartment?departmentId=116', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #24: POST /Protected/ClassTimetableServices/Common/getAllTeachingAndNonTeachingEmployee
    executeApiCall('24_getAllTeachingAndNonTeachingEmployee', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getAllTeachingAndNonTeachingEmployee?campusId=', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #25: POST /Protected/ClassTimetableServices/Common/getClassOrCourseView
    executeApiCall('25_getClassOrCourseView', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getClassOrCourseView?type=classes&year=23&campus=4&sessionType=&sessionGroup=&sessionId=', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #26: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/getViewTimeTableData
    executeApiCall('26_getViewTimeTableData', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/getViewTimeTableData?yearId=23&campusId=4&classId=&empId=1210&registerNumber=&type=classes', "{\"isAdmin\":false,\"isIPMStaff\":true,\"isHODView\":true,\"isFacultyView\":true,\"isStudentView\":false,\"isClassView\":false,\"isDepartmentView\":false,\"isHavingMulRoles\":false}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #27: POST /Protected/ClassTimetableServices/Common/getAllTeachingAndNonTeachingEmployee
    executeApiCall('27_getAllTeachingAndNonTeachingEmployee', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getAllTeachingAndNonTeachingEmployee?campusId=', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #28: POST /Protected/ClassTimetableServices/Common/getClassOrCourseView
    executeApiCall('28_getClassOrCourseView', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getClassOrCourseView?type=classes&year=23&campus=2&sessionType=&sessionGroup=&sessionId=', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #29: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/getViewTimeTableData
    executeApiCall('29_getViewTimeTableData', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/getViewTimeTableData?yearId=23&campusId=2&classId=&empId=1210&registerNumber=&type=classes', "{\"isAdmin\":false,\"isIPMStaff\":true,\"isHODView\":true,\"isFacultyView\":true,\"isStudentView\":false,\"isClassView\":false,\"isDepartmentView\":false,\"isHavingMulRoles\":false}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #30: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('30_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":1214068,\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"967\",\"label\":\"Hostel Application\"},\"sysMenuComponentPath\":\"views/hostel/application/OfflineHostelApplication/OfflineHostelApplicationTab.js\",\"iconClassName\":\"fa-solid fa-hotel\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #31: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('31_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #32: POST /Secured/Hostel/Application/HostelApplication/isHighPrivilege
    executeApiCall('32_isHighPrivilege', 'POST', 'https://prepespro.christuniversity.in:81/Secured/Hostel/Application/HostelApplication/isHighPrivilege', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #33: POST /Protected/Hostel/Common/getAcademicYear
    executeApiCall('33_getAcademicYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getAcademicYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #34: POST /Protected/Hostel/Common/getHostel
    executeApiCall('34_getHostel', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getHostel?showAllHostels=true&sysMenuId=967', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #35: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('35_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":1214067,\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"990\",\"label\":\"Book a Training\"},\"sysMenuComponentPath\":\"views/Support/Request/ESProTraining/TrainingRequestGrid.jsx\",\"iconClassName\":\"fa-solid fa-headset\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #36: POST /Secured/AdminServices/Support/ErpTraining/getDataByUserId
    executeApiCall('36_getDataByUserId', 'POST', 'https://prepespro.christuniversity.in:81/Secured/AdminServices/Support/ErpTraining/getDataByUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #37: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('37_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #38: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('38_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":\"\",\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"1173\",\"label\":\"Student details\"},\"sysMenuComponentPath\":\"views/Studentinformation/StudentInformationdashbord.jsx\",\"iconClassName\":\"\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #39: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('39_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #40: POST /Protected/Common/getCampus
    executeApiCall('40_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #41: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('41_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #42: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('42_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #43: POST /Protected/Common/getCampus
    executeApiCall('43_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #44: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('44_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #45: POST /Protected/Common/getCampus
    executeApiCall('45_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #46: GET /Maintenance/status.json
    executeApiCall('46_status.json', 'GET', 'https://prod-espro-public.s3.ap-south-1.amazonaws.com/Maintenance/status.json', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s', session);
    thinkTime(1, 3);

    // Request #47: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('47_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #48: POST /Protected/Common/getCampus
    executeApiCall('48_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #49: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('49_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":\"\",\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"1164\",\"label\":\"Attendance Entry\"},\"sysMenuComponentPath\":\"views/curriculum/attendance/AttendanceEntry/AttendanceEntryTab.jsx\",\"iconClassName\":\"\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #50: POST /Secured/ClassRoomAttendanceServices/AttendanceView/privilegeEnabledForAdmin
    executeApiCall('50_privilegeEnabledForAdmin', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassRoomAttendanceServices/AttendanceView/privilegeEnabledForAdmin', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #51: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('51_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #52: POST /Protected/ClassTimetableServices/Common/getAcademicYearNew
    executeApiCall('52_getAcademicYearNew', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getAcademicYearNew', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #53: POST /Protected/Common/getUserLocation
    executeApiCall('53_getUserLocation', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getUserLocation', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #54: POST /Protected/ClassRoomAttendanceServices/Common/getAllFacultyByYear
    executeApiCall('54_getAllFacultyByYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassRoomAttendanceServices/Common/getAllFacultyByYear?year=21', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #55: POST /Protected/ClassRoomAttendanceServices/Common/getPublishedClassesByYear
    executeApiCall('55_getPublishedClassesByYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassRoomAttendanceServices/Common/getPublishedClassesByYear?year=21', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #56: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('56_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #57: POST /Protected/Common/getCampus
    executeApiCall('57_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

    // Request #58: POST /Protected/Common/getDepartmentByLocation
    executeApiCall('58_getDepartmentByLocation', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getDepartmentByLocation?locationId=2', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s', session);
    thinkTime(1, 3);

  });
}

export function handleSummary(data) {
  return {
    'tests/christ_university/reports/grafana_summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
