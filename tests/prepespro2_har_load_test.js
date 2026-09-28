import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

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

// ---------------------------------------------------------------------------
// Custom Metrics for Deep Grafana Visibility
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
  const vuId = `VU_${__VU}`;
  const credIndex = credentials.length > 0 ? (__VU - 1) % credentials.length : 0;
  const username = (credentials.length > 0 && credentials[credIndex]) 
    ? credentials[credIndex].username 
    : `VU_${__VU}`;

  const reqHeaders = Object.assign({}, headers);
  if (currentToken) {
    reqHeaders['Authorization'] = `Bearer ${currentToken}`;
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
    : { username: 'Cimi', password: 'Cdi@christ2026' };

  group('HAR_User_Journey', function () {
    // Request #1: GET /ERP/config.json
    executeApiCall('01_config.json', 'GET', 'https://prepespro.christuniversity.in/ERP/config.json?t=1790595292144', null, {"Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #2: POST /recaptcha/api2/reload
    executeApiCall('02_reload', 'POST', 'https://www.google.com/recaptcha/api2/reload?k=6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y', "\n\u0018kemdRjWFxNjgsGdhRslyEPwU\u0012Ž\u000f03AFcWeA617UpZEY_FryDy1IFcCpaDc1mGYWevgAQfP3VmFJAnbAUkT_D7iq3YLuXUCXhIQ-2Czz6m3jpPyUrRWmKGy5oaJqFgR1TjQaFqCpDFKjasuDxCOnpj9c3vSagb2JQ6oLU6uEx0WZcznUPGTt6ar2nE55M6DJ5cqGu_B00IciZjK5kuQLrsLRxBGRMU-SW6PEpC-JoM5mypMJTA7YMt-0VE4_4nET-C3aJfaDxujIc3FCHpRH9vOEM05q5WmMe978sUVSMXsxb4dvosLqdG9jpeWH-ToT7cIT0LckoJBzevFGJs0jYMHqpuvQkEKMExpE0q2sb0lTlW-rnYRHg4irook-0FqzbArRuN_SOSwlK_lRIdSJVpPkpzaO3xepFjp5e5YXoN4GamSatrSgIzcHYqtjnb5K3JaU-hDXUs2nK1k-yszG39PK2qxl9sOf9INTmJD-L3-Rf8VwWRT8M9fNML99F4xl1lmdcXQZKVG3w00VXIBRosiqXTFFsWkOF50Zsp_t6SeqvzothlgEdh39gOcs15g1ymfm6_WwyEBS8avNwt8LkF7EZMdDiFoZTFBDjmZbTRUGqVZIelYo7NL4-8czSYUpnPpFAiH993HgkLTnuyKuPixfDPCGPDa1JEFmhC-4N5lk_PYvIM0EoWX6D-D1vas9UWyLJpw-pQQA5HBcG-_59hHPHDLPt-CcKZYhCxYs0nF0PTZ9-Q9uhBva1bS1wgr9W4yjEb4M7SMBVOt7meSdHdXpWy2MC5ggHm0BBMsA5-nJ-x_BNqS8mRYLXbWj45_t-A9652GS2D86t1Rq7_JqYanF5xRSLV_ya59U4IW_JNUXfVWvLy2apibLap5nM5DzZ4dBMPgNWredQUHUcdt8kxcFF3NvKkGyhZl_7GCyta9wwNh8y05ox0a3E5K8uBvIcQibd7poVZGe0qSnZH3denWdiyKjybyXUSLwD8YJMSk7wZxiZzWwzC3z4bWI48XZEiblozEbtZvs1D9InqerTPLVv8SzZUfqqYZQuIHIaboTMyh8G4ZUes4NMiRMJEmSOpDfBVFvejV4iRGbyoh8-vQEBpDuwWCoabd3dR_JNWoXJYiQHp365BqplPQuf70owOqEiY2cbGdLN32474ZQCsUPQ5N5mFgrC-474r99Rg3nO81MJhQQIi0iDOwISRs2AMgHBdQ7iFnit8W-d1R-X2jNTEJYaFZhs9pU-aIcrQHYewhk-LxYS8jJGTVUrXDruueJ4E5g0qUBSf0WIc8aQ5KZ9Fycow9sR25rtrEHtHtsQlj_D96ra36lkcNODlO4NB5g8MwoNKAS6Hegu2Zl1H2wSeI0zBnwdgQhdGMpE-sPAuiQPpkrCLi2EMbm2U8gIFCHX5p46GXHyqJZWCk9F5xU8FRo1zXNjFoHZqoLR4Cyllk-sbFIKyCUB8lt4xJWcDjS0jxNS5AUDf_p213LbBJ7mqws-2fdF9wVh8yJPDwt4KCbbR5dktRKHB8lHF_bMBqBkcNyBrbOE5VRtllOP-y7Bs8NRKV2NF1T3IWM9F7Jo1ogZSGrFPXWqntu-P2k-x4OVCDsDSToyt7cE78o0dKmjqIQFr1kIwHMrtNbZURers9Pq1J1h3fP4ErhU_BJsR1fqiwQfj8CbS2EuZGZxSJZdKuGqvbC-OSbq4eYtIm3YceqZGjyWVkgFXjZ41q487euXg_-GZR-J0ghnoe8X5W01MHsv9Sk1PafC4BhLboWeKNjIQ8thB4o9R9XEyYQEWNIi_TwZc5JK_E6wDa8SU8gWNf4czNf6BXWWON3qbmMJBDFfLXnEj9Y6ckYrPVADGHpwUVQ-fTMaY698CyqEsoJl2iELeCWE4fBzhRo-VyMSxioqVIp11RyE08qzhDLE7aueMdWW_E1c2BaXKyNn5beorSW0X9eUzqgX3716j*\n15325194052\u0001qr(6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y‚\u0001œ*0uXFfQRPuiaaIWjXQ7c-hfBc0FujDXi8e89Lcdls8FewJ672YM1AyBN96l3lLJsHewJJtCCUH2bRPbE4g-5azlWdC3frcrokkQSP10GuIajwXsrxeY1g8_fOOqV8xDRjzyH-ILhbVx5tifywR4KWYZGAZ-uK6qoN3W_P_o3GHMRLnuL6kaTVCIuznl5JnUAP91ndwPRTvr5Sxk2VA2_jarIciPyHzzmmGaDoVsM2vgVz3FPbIoz5bPQ_qhaKEVjHM1niTXTg37Mq6fGNHKgnrmHBYERPuu7iKczcS3LB7eFAOGgrAtlcyJBrTw4aWTCUI1cmMc2FKJuu2c09EPhGnjGxNJ_3TuJZvcBokxuGwoohSFfjReV5AH_fPpYpoQULs9pizg3QYIwjdqF1GQRMMv8JILQ_vxaV0WTcQEbvFZ4JUPdO4mHhQK__kwpucRlDyDdnIoIVWDunTtmmAZx0X-NFYPR__0q-EaUcfIcvVd5JUHwK-o4NjPBTqz62FhzE73fiow0kuDu_LonVaOBASvMZog09E_M-ppk5pIQTQpo19LwrOs5NzSSr6372Vl0FL7QjZtaBGWELc1NB6ZEs72c2rmXctMerFu4JjNeHGqIJjOA3y0KeqVF4AG9bBg5xhLCTi0sBwLU8qsJV1VS4G3MGfdnkjLc_q2bJNFvvbu5JuQicF29-JkzVQPPWhhmZGHvzNspBmahQewNuWpiwR8dCtg1g9G_H1n6lLZjkht5x-XjEO48imfIAqNNbxto1YXwf988-RlGQWAvPetU85NfjglYE5HgPfs5RpSiT71ayRb0pJ8_2fupaFMwvxzaOZdSo4EtqnZVRFJcnqoH5yMCH53ZV-RlD-5ciPjWMb9ti-mJByI_W6vayMTkoR0NCTaWAf89XQhjofAeG0kWZLKf8Drcqsfln0_qC7d1UyG-XDhpNRWgkLzpqVgQbry6uCWzIX9c_PeYMlQBPVkXZYOAvovaKAVVoEDrDLh5A7RyrTuKlSYiXkvZaiUj4m8LfEqHpcEP7lz7JFRTgUyo2GWkM5-d_CjEZMGBXOoGZWPRIVxbmbWUgO8eS9nGk0_ADFspJ5JBAHmquUQAslBLiteXUoG9quc4dqFvPhvXdgaj0Y69ZwYGEs8_HKs2Ql-h_To2d7WEETyZGSUBk3Gcd3XEMZ8c2thmFAGurKpH9aYgwWuNO_eCQJ68anfFA1E-jtl7SWaEPe6IqlZ1ML4tOydH4Y_d2-lm1LKgfftphmTikCA623WXQ2QRvov3lIQBP11ZqUYzE16suodl1P-Avkp2xVRirP3n-APFgtyaTCXjIl-t2vkJxGQSnxvr2XLTvp-dCMTkhHEfeqsGY4HRTTzYl-Sxres4qlRFv87OGrgkFaOe3lzmNgNjft7aGhOxcz6OmqeVVFF9u9kXZ-KSPg54NuWx3Zvp57Wy4Q68KjelknD-rDxG54GjURA76YhksVzbKac00oBeG4l3BAKADd3YeRM04a9MJ6Xz8f9NKmi2lCQ-33mbSnbwXqzKp_XDEW9M3OeIIkP_wA5rBzRi_XvJx7WC8D6MWgoEpU9hHtqLdrQkjl6beVXkUcI97CnVtnQejq069eVT_U1qF5UU745cSic39aCwfcy4Y8JTfytq9gShT-ycC5n1w2_gjBm2swPSLimZB3UD8c5ayNUUYl6QK9cpNtFBjwloZdOR_r3aqdV0UR7NewgV1cC-6snpR4UQnntKB-hiE7AcCiYks9GhOjl15QLyHN16ZxSkIMA8quflNUGd6et5VFRQK8rq52cyL0wLaNUC8yEc-UiGNlJR7pp7ODRRAc8KepalAh2NnTnn9FNgbknmVyGRDT0YiJPko409afhFVGFcrrgYJNUB3vobCLLyMv_MafmUYxLQWysnRGTxXgvptqPw0R866agUQXI8qrqY9FR--9jKBsPTcM6sOqPzEJ8-LCaGg2DQXCramEXg7iwb95OlUVBtiBlV8RB97Ww492CwwM0ppYNCIC0-OJa2Yi5daynZJLPBfSvoSTZjXu4tuPW2cYAbnIsldDQtvoyWl2MQ3-9qikd2EKF-PJgXo1DArNmX9TTPUF3Lx1cyYpC-uPfWwRBtuowH5EJhjqtaybZx0N1s6xUS0_-uaqi4s9I_HdpqlHRin03qmCekn_CrioillhMBHFzXp4JSnr7LKFWho79cvBdnFKOvHjlJs8MyICwJ9zbyYz-deFnmUl_9zUqIxhMurTspKKczAV5c-Kdl8M-e7MeW1aSODzrbRPKBcT59J9ZhL317ePaj4e-NPbhY8xTBL1zKSUXT8WAbl1Wjwc78yhhmQ5PujylK96fUr_A6B_fC1S5wq9d2h2HPf9rZiQSEX_06-wXSkgH8vZpYU4FvC4saZcQzDZz5KLgTcU58aTe3QdE-69nHh9VxQNw5ipci4B77uecHUwF-TonGtmTR4BsY2dUyge4qOJZzYm4cGjk2NCLPnN3XOOXAMT8ZGAPCEB4biZaE0r_wWvuVt2OwD5571pWxkQCZ-EaEcb-dayjGQ3H_rT1H6IKkUiEdtxVjgU8c-dgmA0OuTukKuJMjPo9LugmGE9FeyqqZFuShjZ2YyGXjsG3pSyWzo63KaLa0wo_9K3lWlvGSPF4KKdZGEW9OePl2EsNRPyvp5aOQXcwpV9Rykn3cGAbURIB9mxq4thJCbdzoCGSS3nsJV3UDIJ3MGfc3kjLc_qnHGJahkB19meVxP42LmPcT8kAtbchpAyTRcYtbuFdArvz6-HYTYb-c3TfV4-FvPPn6lLZigr6-h-fHVEFtnVkVBXMh6xlnZVMgfdwqB0eiQu0MzFqXQpMvPPkZ1uYf0C18alNhv72rmUbkglANeuhGxHICHL1XeSWDnxFMambk5GNvKkqGxrIwgAybF-bCIQ69G9bVgo9ge8nWJTKfT9oJCFQvbbu5t0TCIH5bi_aXMVMPn2sZ1gIDYewsuRYjpB09ibqVwdE-3izX5dMhQP6aBbcjYrzpd8XDwY9cOohllgChS20ZZoVk0Kwra5djAs99m-uI5fOAUDz5aRSyb_ys23iE0BC7bUj24hIOvavHmKVB4P4719ZlcUCeiQmIdOHfHmjYVATvXS5JiiWzUr2riComNLBdrKu3l5Jg7CvcBpRUP9_r-aiEIpG8-rkHZgQhzPnahTYAEXs6-Qg0MfDeemjn5SF_zGjX5WUBoZsaKVYRko6MSqml48NO7Bs25yMQwEupxtS0M0-9q2kGFDH-fGe4hp_OHBoXdXKAjivcVveRs28sOXi08pJx_Tp4pnVzjd_rFzYiT7H82xj1ovPebTiVY7HfjWroJnRCAfydN1kHQrFA3Pgm43OC3o6pqiWwsI6LN8aFpUH9i8tnxLJyzyrr52Yxoq5NmvcDz02buZc00gBeK-vWdxTCfJxcWqglsyGex8YTIc-9WetF5oCgoN6LubbwUDA-jAmWwE6bqkg10mPObwkpmVdfz4uq-6hGw91ruMflkdMw64l24_Tzwc7dO2jRct1-G8qoxeOdSzimlAEUPd6sakWyEd8Pa_fVMi--3koJpvXCTv0MBeVFYO66uGW2kvBPqnopN0NiHgsXh9Zg76_rzAeWg7Ie7de4VRPxjSuXBdQxL_ssdveUEm3NqhhYpeAO3SnYJCXw4G6ruLYlgY5sOecm9gBwHxtqR5VRENzsF_UEoiAOzCnkwP79_VoWlXJxra3JZ6ZFHixLaMdmZFIOC3mXA6If7FoGB2ID0f8cxnhGY4E664pohaNdCvhmU8DTP4zpmWWjH4wNaAnX9RLMfkxphzDisN37pVX00vAdx3Vi0M47S-mG9vHwPVrKltRAvT6ZOwkmQ_2vfZq4YhKxn7zahDIvnYr4CMbCgyBtSnrkdg_tatjoaEXRvty6JhTVUM39y3lG1M6cvlwIxJWh_Y1ZlwN_8Vv8m3mWtG4cCXdk0eIfq9uY9pZz4pvceXhVcfAN_Nn5BIHCDv0KFtaSUbt56lizMh9M3Jd4k8Mvb1jZV0HC0Go5pzORbyFOObbnYt_QvImJ9lFRLbwJ2PVibhAdiPZ2Uh1euVn41vQRy3lm1MI_Qf2cSYjUgZHNuwcG4nRhXnonBMI0P707N3QD5AzM2Uby9F7_nnyZt2EfDHpn1OOUMIAL-2gj0xEO7WjVZUVuLjqoVFWwUP_d-xjCcG3byTZG4nJPMDnYtTLRof_cmSXTY077uwboszFx73n6p8WfjNz9JsQUI70uSMfD0R-QDYlIZ1WvLmzJGPRhnyDOaYjXUPAAPAs5VMJwzd0oNDWQMN-92viiUE27qRYnMnBQK5smxxKRke-biQYFkx_7WkiV49_cXbhY99XzEMp4ZdPBPk7NKcmlpXJdCqhINvUDED449YVljk5ayHR10HEf_hs44pCN--lWZ5ZEUi-NGadUI0-QKvtmgoJODfkp1hNxv11MCeSTksCcTLa1pCM_fuw2ZeSTT37IV5cSL9vdN9h3VXKQSfflU0C9zrpK57akMq6rC5ikRD39nTr2gvPxfewZRObwrj9reGZG8WHNDDtINrD_35p3x6MiTs2NF-ZEQwENKOgEA5JwWtiXl5SyUR4oebXygL8eqYX3kv8vnYwHl1UCLp356KODPs09mgVzUp6QbVpJFFQB_ZnZWJTxsd8qm0hSoPAM7OpWs0_hPQlYVZZQAZ7LOBUTQx8tWdgHE9KxW8xIKDRivuwoB8VSYQDup_X1sgIMjdjpczSiHg0ntkSkEL2ZmTUiok_vKjY3kjQCL0z2qHaTsWsc6wgl34AvDSpH8a-dCvhlddYR334LB4XDsdE-2nmHEQAQLumHJ-EQoL5LlmJjzm8N7Akm0I576ddEVTKxjnvaqaRE8hvstzjy0-_7mcpGNhGu2706pmXQIWt6-fej4SHL2YWG4YIhDyxJ86GfDPpneIgiwt5u_Mgn9YKOKkmZJbJiIGyZBfe1Yp5KuGRlwGEP7gso0oB969lGV_ZBYp4qaqhC0zIbyboU47Jtu0mIiCISLxwouEhV4z4KC2YGpYOgzngmU4F-6_xKJveC85FK6RjUw7LPjJv3h9Ii_DxJ-SSysfwcaNli06Iga4mYZGIOnxq69VbDMY3bqmjGM98O2oc31HRN-xq65GNwAM2M-BaRw19Keqqz0bDvXdpnN2UCjMt6tzVBH-zdaadW44CPrTlZ5yQQ3fv3qFTjAj0NCTlUAsFOGptlVLF_7KlXePXkDg2aSPgEQV7-yybENRLPG5qmxqThjfunqQaxUyFObBXGYIBPaqwWFqFffMwqN8bUMCBuluUzMS6MqfelQ4EeHJpH1-KEUn-dRvjG5AG7bAYn1CQQG7vIFPXQMg89eJV2M07unLkVZSD_qzq3VCKzXx36OCfz4R8ON1Wjoa8cqhhmM-Phk¢\u0001ø\u0003tbMywxMDksNDg2XSxbMSw0LDU5N11dLG51bGwsW251bGwsbnVsbCxudWxsLFs2LDMuNTMzMzMzMzMzMjA5MTU3LDAuMDAwNzc3NDk5NDU5MDIzNjk1NSw4XSxbNTEzLDAuMjMyMzU4Njc0NDMzNDM4MTYsMC4wMDQzNzE2MDA3MzE0NDg4OTk1LDNdLDAsMCwwXSxbImNkbi5qc2RlbGl2ci5uZXQiLCJmb250cy5nb29nbGVhcGlzLmNvbSIsInByZXBlc3Byby5jaHJpc3R1bml2ZXJzaXR5LmluIiwiY29kZS5qcXVlcnkuY29tIiwia2l0LmZvbnRhd2Vzb21lLmNvbSIsImthLWYuZm9udGF3ZXNvbWUuY29tIiwid3d3Lmdvb2dsZS5jb20iLCJwcm9kLWVzcHJvLXB1YmxpYy5zMy5hcC1zb3V0aC0xLmFtYXpvbmF3cy5jb20iLCJ3d3cuZ3N0YXRpYy5jb20iXSxbMSw1NTZdXQª\u0001t0aAKlZI5FCI8pUCxwcg_VarbpMHV8BJqcF24SMMdlTKgTuB2Qqj3JL7TJNxMv8ZEabyhcA8H6M_a76GEm79oW8vR_xXbbhWumHrgkXA9dFKHSapgwVyA²\u0001¤\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Ê\u0001VW1tbNTAwNiwzODddLFszMTYxNywyXSxbMzcxNzgsMl0sWzY0NjA3LDJdLFs0NTQ2NCwxXSxbMzU4MzcsMV1dXQà\u0001 œ\u0001è\u0001°ê\u0001", {"content-type":"application/x-protobuffer","origin":"https://www.google.com","referer":"https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y&co=aHR0cHM6Ly9wcmVwZXNwcm8uY2hyaXN0dW5pdmVyc2l0eS5pbjo0NDM.&hl=en-GB&type=image&v=kemdRjWFxNjgsGdhRslyEPwU&theme=light&size=invisible&badge=bottomright&anchor-ms=20000&execute-ms=30000&cb=uarekgwqnftz","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #3: POST /Public/Security/Auth
    const loginPayload = JSON.stringify({
      loginId: userCred.username,
      loginPassword: userCred.password,
      loginReCaptcha: '',
    });
    const authHeaders = {
      'Content-Type': 'application/json;charset=UTF-8',
      Origin: 'https://prepespro.christuniversity.in',
      Referer: 'https://prepespro.christuniversity.in/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    };
    let authRes = executeApiCall('03_Auth', 'POST', 'https://prepespro.christuniversity.in:81/Public/Security/Auth', loginPayload, authHeaders, '15s');

    let token = '';
    let campusIds = '2,4,1,5,6,3,7,8';
    try {
      const authData = JSON.parse(authRes.body);
      token = authData.token || '';
      if (authData.campusIds) campusIds = authData.campusIds;
    } catch (e) {}

    // Fallback if secondary account is placeholder
    if (!token && userCred.username !== 'Cimi') {
      const fallbackPayload = JSON.stringify({
        loginId: 'Cimi',
        loginPassword: 'Cdi@christ2026',
        loginReCaptcha: '',
      });
      authRes = executeApiCall('03_Auth_Fallback', 'POST', 'https://prepespro.christuniversity.in:81/Public/Security/Auth', fallbackPayload, authHeaders, '15s');
      try {
        const authData = JSON.parse(authRes.body);
        token = authData.token || '';
      } catch (e) {}
    }
    currentToken = token;
    sleep(0.5);

    // Request #4: POST /recaptcha/api2/clr
    executeApiCall('04_clr', 'POST', 'https://www.google.com/recaptcha/api2/clr?k=6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y', "\n(6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y\u0012\u000f03AFcWeA617UpZEY_FryDy1IFcCpaDc1mGYWevgAQfP3VmFJAnbAUkT_D7iq3YLuXUCXhIQ-2Czz6m3jpPyUrRWmKGy5oaJqFgR1TjQaFqCpDFKjasuDxCOnpj9c3vSagb2JQ6oLU6uEx0WZcznUPGTt6ar2nE55M6DJ5cqGu_B00IciZjK5kuQLrsLRxBGRMU-SW6PEpC-JoM5mypMJTA7YMt-0VE4_4nET-C3aJfaDxujIc3FCHpRH9vOEM05q5WmMe978sUVSMXsxb4dvosLqdG9jpeWH-ToT7cIT0LckoJBzevFGJs0jYMHqpuvQkEKMExpE0q2sb0lTlW-rnYRHg4irook-0FqzbArRuN_SOSwlK_lRIdSJVpPkpzaO3xepFjp5e5YXoN4GamSatrSgIzcHYqtjnb5K3JaU-hDXUs2nK1k-yszG39PK2qxl9sOf9INTmJD-L3-Rf8VwWRT8M9fNML99F4xl1lmdcXQZKVG3w00VXIBRosiqXTFFsWkOF50Zsp_t6SeqvzothlgEdh39gOcs15g1ymfm6_WwyEBS8avNwt8LkF7EZMdDiFoZTFBDjmZbTRUGqVZIelYo7NL4-8czSYUpnPpFAiH993HgkLTnuyKuPixfDPCGPDa1JEFmhC-4N5lk_PYvIM0EoWX6D-D1vas9UWyLJpw-pQQA5HBcG-_59hHPHDLPt-CcKZYhCxYs0nF0PTZ9-Q9uhBva1bS1wgr9W4yjEb4M7SMBVOt7meSdHdXpWy2MC5ggHm0BBMsA5-nJ-x_BNqS8mRYLXbWj45_t-A9652GS2D86t1Rq7_JqYanF5xRSLV_ya59U4IW_JNUXfVWvLy2apibLap5nM5DzZ4dBMPgNWredQUHUcdt8kxcFF3NvKkGyhZl_7GCyta9wwNh8y05ox0a3E5K8uBvIcQibd7poVZGe0qSnZH3denWdiyKjybyXUSLwD8YJMSk7wZxiZzWwzC3z4bWI48XZEiblozEbtZvs1D9InqerTPLVv8SzZUfqqYZQuIHIaboTMyh8G4ZUes4NMiRMJEmSOpDfBVFvejV4iRGbyoh8-vQEBpDuwWCoabd3dR_JNWoXJYiQHp365BqplPQuf70owOqEiY2cbGdLN32474ZQCsUPQ5N5mFgrC-474r99Rg3nO81MJhQQIi0iDOwISRs2AMgHBdQ7iFnit8W-d1R-X2jNTEJYaFZhs9pU-aIcrQHYewhk-LxYS8jJGTVUrXDruueJ4E5g0qUBSf0WIc8aQ5KZ9Fycow9sR25rtrEHtHtsQlj_D96ra36lkcNODlO4NB5g8MwoNKAS6Hegu2Zl1H2wSeI0zBnwdgQhdGMpE-sPAuiQPpkrCLi2EMbm2U8gIFCHX5p46GXHyqJZWCk9F5xU8FRo1zXNjFoHZqoLR4Cyllk-sbFIKyCUB8lt4xJWcDjS0jxNS5AUDf_p213LbBJ7mqws-2fdF9wVh8yJPDwt4KCbbR5dktRKHB8lHF_bMBqBkcNyBrbOE5VRtllOP-y7Bs8NRKV2NF1T3IWM9F7Jo1ogZSGrFPXWqntu-P2k-x4OVCDsDSToyt7cE78o0dKmjqIQFr1kIwHMrtNbZURers9Pq1J1h3fP4ErhU_BJsR1fqiwQfj8CbS2EuZGZxSJZdKuGqvbC-OSbq4eYtIm3YceqZGjyWVkgFXjZ41q487euXg_-GZR-J0ghnoe8X5W01MHsv9Sk1PafC4BhLboWeKNjIQ8thB4o9R9XEyYQEWNIi_TwZc5JK_E6wDa8SU8gWNf4czNf6BXWWON3qbmMJBDFfLXnEj9Y6ckYrPVADGHpwUVQ-fTMaY698CyqEsoJl2iELeCWE4fBzhRo-VyMSxioqVIp11RyE08qzhDLE7aueMdWW_E1c2BaXKyNn5beorSW0X9eUzqgX3716j\u001a\u0018kemdRjWFxNjgsGdhRslyEPwU\"\u0001\u0018\u0001*s\n\b\b\u0005\u0010\u0005\u0018·\u0001\n\b\b\u000b\u0010ßÜ\u0001\u0018\u000b\n\b\b\u0006\u0010ÞÜ\u0001\u0018\u0018\n\t\b\u0003\u0010×Ü\u0001\u0018Ì\u0001\n\b\b\u000f\u0010É\u0006\u0018\u0001\n\b\b\u0001\u0010º\u0006\u0018½\u0001\n\b\b\u0002\u0010ÙÜ\u0001\u0018\"\n\u000e\b\u0004\u0010ýÜ\u0001\u0018\u0001*\u0003\u0010]\n\u0007\b\u0014\u0010æ\u0003\u0018m\n\u0007\b\u0012\u0010Õ\u0004\u0018\u0004\n\b\b\u0013\u0010\u0005\u0018·\u00018\u0002@ \u0001H°ê\u0001", {"origin":"https://prepespro.christuniversity.in","referer":"https://prepespro.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #5: GET /Maintenance/status.json
    executeApiCall('05_status.json', 'GET', 'https://prod-espro-public.s3.ap-south-1.amazonaws.com/Maintenance/status.json', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #6: POST /Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot
    executeApiCall('06_checkUserRegisterOrNot', 'POST', 'https://prepespro.christuniversity.in:81/Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #7: GET /Protected/Common/GUI/getLatestReleasePoster
    executeApiCall('07_getLatestReleasePoster', 'GET', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getLatestReleasePoster', null, {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #8: POST /Protected/ScreenConfig/getSystemMenus
    executeApiCall('08_getSystemMenus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getSystemMenus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #9: POST /Protected/ScreenConfig/GetScreens
    executeApiCall('09_GetScreens', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/GetScreens', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #10: POST /Protected/Dashboard/UserPreference/getFontByErpUserId
    executeApiCall('10_getFontByErpUserId', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Dashboard/UserPreference/getFontByErpUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #11: POST /Protected/ScreenConfig/getErpNotifications
    executeApiCall('11_getErpNotifications', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getErpNotifications', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #12: POST /Protected/ScreenConfig/getUserCampus
    executeApiCall('12_getUserCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getUserCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #13: POST /Protected/Common/getIsAiEnabled
    executeApiCall('13_getIsAiEnabled', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getIsAiEnabled', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #14: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('14_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #15: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('15_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":1214071,\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"1052\",\"label\":\"Timetable View \"},\"sysMenuComponentPath\":\"views/curriculum/TimeTable/TimeTableView/TimeTableView.js\",\"iconClassName\":\"fa-solid fa-book-open-reader\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #16: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('16_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #17: POST /Protected/ClassTimetableServices/Common/getAcademicYearNew
    executeApiCall('17_getAcademicYearNew', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getAcademicYearNew', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #18: POST /Protected/Common/getCampusesByUserPrivilegeNew
    executeApiCall('18_getCampusesByUserPrivilegeNew', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampusesByUserPrivilegeNew?sysMenuId=1052', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #19: POST /Protected/Employee/CommonEmployee/getEmpIdByUserId
    executeApiCall('19_getEmpIdByUserId', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Employee/CommonEmployee/getEmpIdByUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #20: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForIPMStaff
    executeApiCall('20_privilegeEnabledForIPMStaff', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForIPMStaff', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #21: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForHOD
    executeApiCall('21_privilegeEnabledForHOD', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForHOD', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #22: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForFaculty
    executeApiCall('22_privilegeEnabledForFaculty', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/privilegeEnabledForFaculty', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #23: POST /Protected/Common/getDepartmentByUser
    executeApiCall('23_getDepartmentByUser', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getDepartmentByUser', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #24: POST /Protected/ClassTimetableServices/Common/getSessionType
    executeApiCall('24_getSessionType', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getSessionType', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #25: POST /Protected/Curriculum/Common/CommonCurriculum/getEmpsByDepartment
    executeApiCall('25_getEmpsByDepartment', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Curriculum/Common/CommonCurriculum/getEmpsByDepartment?departmentId=116', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #26: POST /Protected/ClassTimetableServices/Common/getAllTeachingAndNonTeachingEmployee
    executeApiCall('26_getAllTeachingAndNonTeachingEmployee', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getAllTeachingAndNonTeachingEmployee?campusId=', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #27: POST /Protected/ClassTimetableServices/Common/getClassOrCourseView
    executeApiCall('27_getClassOrCourseView', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getClassOrCourseView?type=classes&year=23&campus=4&sessionType=&sessionGroup=&sessionId=', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #28: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/getViewTimeTableData
    executeApiCall('28_getViewTimeTableData', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/getViewTimeTableData?yearId=23&campusId=4&classId=&empId=1210&registerNumber=&type=classes', "{\"isAdmin\":false,\"isIPMStaff\":true,\"isHODView\":true,\"isFacultyView\":true,\"isStudentView\":false,\"isClassView\":false,\"isDepartmentView\":false,\"isHavingMulRoles\":false}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #29: POST /Protected/ClassTimetableServices/Common/getAllTeachingAndNonTeachingEmployee
    executeApiCall('29_getAllTeachingAndNonTeachingEmployee', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getAllTeachingAndNonTeachingEmployee?campusId=', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #30: POST /Protected/ClassTimetableServices/Common/getClassOrCourseView
    executeApiCall('30_getClassOrCourseView', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getClassOrCourseView?type=classes&year=23&campus=2&sessionType=&sessionGroup=&sessionId=', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #31: POST /Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/getViewTimeTableData
    executeApiCall('31_getViewTimeTableData', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassTimetableServices/ClassTimetable/TimeTable/TimeTableView/getViewTimeTableData?yearId=23&campusId=2&classId=&empId=1210&registerNumber=&type=classes', "{\"isAdmin\":false,\"isIPMStaff\":true,\"isHODView\":true,\"isFacultyView\":true,\"isStudentView\":false,\"isClassView\":false,\"isDepartmentView\":false,\"isHavingMulRoles\":false}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #32: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('32_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":1214068,\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"967\",\"label\":\"Hostel Application\"},\"sysMenuComponentPath\":\"views/hostel/application/OfflineHostelApplication/OfflineHostelApplicationTab.js\",\"iconClassName\":\"fa-solid fa-hotel\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #33: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('33_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #34: POST /Secured/Hostel/Application/HostelApplication/isHighPrivilege
    executeApiCall('34_isHighPrivilege', 'POST', 'https://prepespro.christuniversity.in:81/Secured/Hostel/Application/HostelApplication/isHighPrivilege', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #35: POST /Protected/Hostel/Common/getAcademicYear
    executeApiCall('35_getAcademicYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getAcademicYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #36: POST /Protected/Hostel/Common/getHostel
    executeApiCall('36_getHostel', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getHostel?showAllHostels=true&sysMenuId=967', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #37: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('37_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":1214067,\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"990\",\"label\":\"Book a Training\"},\"sysMenuComponentPath\":\"views/Support/Request/ESProTraining/TrainingRequestGrid.jsx\",\"iconClassName\":\"fa-solid fa-headset\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #38: POST /Secured/AdminServices/Support/ErpTraining/getDataByUserId
    executeApiCall('38_getDataByUserId', 'POST', 'https://prepespro.christuniversity.in:81/Secured/AdminServices/Support/ErpTraining/getDataByUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #39: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('39_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #40: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('40_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":\"\",\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"1173\",\"label\":\"Student details\"},\"sysMenuComponentPath\":\"views/Studentinformation/StudentInformationdashbord.jsx\",\"iconClassName\":\"\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #41: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('41_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #42: POST /Protected/Common/getCampus
    executeApiCall('42_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #43: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('43_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #44: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('44_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #45: POST /Protected/Common/getCampus
    executeApiCall('45_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #46: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('46_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #47: POST /Protected/Common/getCampus
    executeApiCall('47_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #48: GET /Maintenance/status.json
    executeApiCall('48_status.json', 'GET', 'https://prod-espro-public.s3.ap-south-1.amazonaws.com/Maintenance/status.json', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #49: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('49_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #50: POST /Protected/Common/getCampus
    executeApiCall('50_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #51: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('51_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":\"\",\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"1164\",\"label\":\"Attendance Entry\"},\"sysMenuComponentPath\":\"views/curriculum/attendance/AttendanceEntry/AttendanceEntryTab.jsx\",\"iconClassName\":\"\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #52: POST /Secured/ClassRoomAttendanceServices/AttendanceView/privilegeEnabledForAdmin
    executeApiCall('52_privilegeEnabledForAdmin', 'POST', 'https://prepespro.christuniversity.in:81/Secured/ClassRoomAttendanceServices/AttendanceView/privilegeEnabledForAdmin', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #53: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('53_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #54: POST /Protected/ClassTimetableServices/Common/getAcademicYearNew
    executeApiCall('54_getAcademicYearNew', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassTimetableServices/Common/getAcademicYearNew', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #55: POST /Protected/Common/getUserLocation
    executeApiCall('55_getUserLocation', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getUserLocation', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #56: POST /Protected/ClassRoomAttendanceServices/Common/getAllFacultyByYear
    executeApiCall('56_getAllFacultyByYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassRoomAttendanceServices/Common/getAllFacultyByYear?year=21', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #57: POST /Protected/ClassRoomAttendanceServices/Common/getPublishedClassesByYear
    executeApiCall('57_getPublishedClassesByYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ClassRoomAttendanceServices/Common/getPublishedClassesByYear?year=21', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #58: POST /Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear
    executeApiCall('58_getBatchYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/CurriculumServices/Curriculum/Common/CommonCurriculum/getBatchYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #59: POST /Protected/Common/getCampus
    executeApiCall('59_getCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #60: POST /Protected/Common/getDepartmentByLocation
    executeApiCall('60_getDepartmentByLocation', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getDepartmentByLocation?locationId=2', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,6,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

  });
}

export function handleSummary(data) {
  return {
    'tests/christ_university/reports/grafana_summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
