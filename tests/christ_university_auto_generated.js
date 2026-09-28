import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

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

function executeApiCall(endpointName, method, url, payload, headers, timeoutStr = '15s') {
  const vuId = `VU_${__VU}`;
  const params = {
    headers: headers,
    tags: {
      name: endpointName,
      endpoint: endpointName,
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
  group('HAR_User_Journey', function () {
    // Request #1: POST /recaptcha/api2/reload
    executeApiCall('01_reload', 'POST', 'https://www.google.com/recaptcha/api2/reload?k=6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y', "\n\u0018BnqMGSY_YP4cCmbNINHpJPkd\u0012\u000f03AFcWeA62r-0g6n9BTFEf7cc3FWpz4qcC9hDMYXpPTwUKyzTRBe9a7rUaXq2Yxe2XFRuD2egrjNmNZk_NizlauWGt-3pMjS00-BnmUFKg24cTppzRbsQdy8-WSxN3jyzKOT0iUqtTRF1_EKYl-aFyhBuN1clhslP7l-x3yecqOyBVHrs3q2Wwoyok_ciVb0tiBxsZT0VLHpqSEA6siwRNRHJCYPV-2oSCbBMK1WatNG4ANctQVb9tw4C26MadSXekIBZ-c4HSkf3_XLmM7V3vdS-UIm7Y-B1Jfut3EyQ2q9nwMp7cm3Gy2dVqbdfZPOMU59fMj4ndX7Y7UNoROga6cM2U0_91nocdKrwRXmEfySe7WUGnFgdyX9Bzh3M1co620Xp1G48_c90FJ0Qr-LZXj7fLJKDDnxRULFgDQYigCwVi-PqNvRnT8IT454kd1AXTwh14eFd8oHBPCzHHJ7mejoKKMnYuAwMlDKo5xtEX2ZfN17t21BS0e2Pfs1zo97sOCiXOzoTD8BUjKUBgY09Pth8BuX7ngZj5_kGukFWEgXXbc4oCO4Es4kIuoMD9OeUZhLx2SyFxCRidBxJZojzqPzZSiykFkP-xJ8etneoLAOCAK1nmam5w_CV0-KZQiH7wMfqWfUx76LTD7aNwnSiIh1DphH2q2Qgmgt8xEo8xaKEbNDUkFln-XC_ukeKtmmFGhXTZlPC4df-XS1cEkxaV_FyYzGWaSz3AX5jd7OUomTGKkANYieXJD9nozQJ3Qgsa1GXOFHo9UeqAUif54u0v8dLZq7vCFNixthRxlZgVXdTP3khDclSIS_mpSs9OR66VkVZeABs46rzyh56r2P6YD1FWy2EtKuFkXWUg0fLH62iz8MUg0iT--8818PT7KdYdz-JPdf7AFkvgHqMGiz5olR5vo8VUynogCXao70ZTcBW3Q7roFh4LYrJS9daIqigiLBwe0HliDLeca5ddj4Euj2mhZZ9B92zVVdJqVjfW018vUWIfDXL28hK31PCA6S622PAHRJz9ssknzX5ROMvVM_S_zBmMeMzO5v-a1kCc6ZIGS2iGoJxO-BLAh98fechpdI_ebdnCODAGk20Um5gbi5yb4Xy2esXJSU74ojJmSPUEVnsNW2HW2VxxZEotYBjJgUmqxhZAogeOxOE_XYxkPQmzYf-wUlTBEGYe4CCnKJOTfCt7_Z_ahWiwxdZ-Dxkciig5mH7_SWj7fD4gdJQWT-E2HD_8EUH8S6FPxy_D4eoBRjj461rf7ZAcuDrBWh9faepdWB8O6kKHXcXfddvuxkOV_GD5obTNlEyTlhXjipK8MTHgcUm08aiXb1TlG5kK6OFY6Mrg7s5WfbJS5PCoBVfe4SbNuMFSuPWkZy57GWEx__OAybekJGuETegUq1jsuyZltBpcNcyw7QsChuri-jF8o56PChyD8II_vreRuBbeJR_fe15YzB_LEzx8CKJmsjSj1ziIBHISGDmsJHC9YeBJvrZuVV7WgeY-XMEe3HHk3tRydFLj-NUJqrvq49e83DARQbGYjI4SF1q_3CD4n8DRkb9Ngdk-mtxSrrNx1GdXj4Tdd6GZ0GLV4zi-of5KScSsEKzb6be2MyYbw8aHXm3m-9oscTUnm38_Z1nqu47WQPmL9LmGJs9IZ_Oe-6zGePI_xpUeVHq2nHZhth5x2IbdKXA455YJKMwQkTcA7OxeNibdKG6CKuxJEvCeKtEYm123nCek9TDqpYWdsUFYV0TlkvsjN-jJ0FsX4kntByrxIm8b4wN0-aHA0I7zTTaqL-LimQbdqma13rb-y0EsbzE9BL7EM5N7LyUz2ScbxwzrNbAq1mESUOF0cwNn_cc7wTe6berrak0BZO2a4YOmRQ-2fO8tOUjcYd1ylQWpN3TsgWsgSbKFMfUcW7Uq_bumuI76HU7Ssvuu*\u000769436492\u0001q:¡\u000205AJ8Qx1Y3otjpzIw9CN9njRfUoP_kvEY8Hmzi0ZARCo0bP1oy29i3zhSMgmt9c8qvbs6Um_pQ7fdv_Oh-6Y-Nc7zsvP02Vy2_iM7nAcGsQ94_DgTRsKqxehTPYFCiRFeyJPAM5FClhxJJvh0wJaxIudAHfBy9VwayDloZcA8JEUcfumIdTGyCDws0vcHNISjJW_uU67hOjtxJ95Fmnc_cYDrqM3aVViPRm7JcvCbXfNauJryHLyM5mMsQ92-PHYxTMSnEtTD1d3fz6AYJVhEcqet5YYkBsp0r(6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y\u0001±+0lF6h2P8vH5HI7x8PgbjfD_9xqM__7xVZg7cWBT91pc9BeJ_PvzFoj7-vIVh_r58RSG-fjwE4X49_8ShPf2_hGD9vX9EIL19PwfgfTz-x6A8_L46F_SliU7voIi9leecGGk9ktdspPWqr9Ao6XG6_1wMybKjWG1-UpbzqGjWgn9X_JYC71TVXaqXsDDp3sdT6S3WV2tAAFU_B-B9PP7HoDz8vodj_Lx-RyO8fD4G43w__cajP_-9hmL_v31GIr9_PLiWVtOQ4QnW60Q1GfrLp6xhVY7rqDF6Fw9wMK1R0xvMGZ6y3Avgob7rIDSWKlcP7HWZ-uv07bIamuOkzgqqVzwQ6aZS_-SxXsK8OBXWZ4Bs6Uoq4te8mWoe03xlMd9DPLiWVugD5WZO93ecldZzq8kolX5bL9itPibznQD-elQUsalWPxPkmVn-57BZwb87FNVaaxwEnNGSj1-NPgKblG0klX5bL8yVPibzlQD-elQUcMKaFv_QpU4Ov6RxFoJ_-9WVq2rXvJFqLt98ZTHXQzy4llbYADTVktrMjMGiJtPA1PGyFv_QpVIqv6RxEoJ_-9WWLvPz3Xp2M2SopaKTp3CVYm87ZMkBwu9cNNDVvptULNV-ZzPNQT66lFSVlfOoEJHGEyQwRI5rKpd8USXekzwk8ZMC_HhWFyffnBT90qdUGL2mcwyAffnXlJjQ1b6TZBjlfmcv8UE-upRVOimWf1gszY4_J-yuAf97VRW2qlc8GO2OVv_krW7CvDgV1j7sPFTmMufsoaly_1PYsirLFDydSZLy17ylYg7jmF0x2q88JPGvAvx4VhZ-zKlh5lMHsI1qA2eYXWm-1xglPVbqj1jhcosffLEhQoer0Vn9z6_02bqOT6DJMd6W47CZnmNvTQGtn2fb2a1Oc2hw0VYnrER87a83mMVuVda_mG0N1n9kLPJCPAThfj3_e1UVWibv5GEtjxdg2OpGpyhpbNW-k2QUzX5nM-VBPrqUVPVRln9YLM2WPyfsrgH_e1UVdscjuGzOEzN_1I1ysuOhJWr3E0yBLo8bl_EV0rLUFW4myrA0md3_UzBs8jKC19idreNrYSW5jqMQxOZ2f8AlPiqa7-jk8YKrs_FlpocoNWXR16-s8M2fZ6B1iWbbb5T1XhqwcLDRrlu0bW4jAygUsd3TnGR1wedHdF0aHjMr8BT92rNgMM2mYyPkfVIOz40A_npUFRlRVj8b2LFZ_uesbcG_hGD9vX761JTx9irb8MEeklc8EPGScxPQlU4e13xxMd9DPLiWVpsUrZIubtyo7VJnZ60JYqcn9FVpvobgMO0Z74NwkNoDJzPRfhYTr-yppmdf7BUmmvAsqXnC-uf8wfZXW-xdMY7vWCVdkvtQdFFy2ow8XRZTJxRhqj5vNDEZWu7r6KDtmsOANOFbG7w0yRKvp8CFbe73mDSudoO8pUGd85vgLbqWy_BRsj5fdFkd3kdvYBVCrxvf5a1a_1AxbR6vSGgdYf68NCBVPibTrHEN1ptkJL2ycxiAffnXlC0R2uOH2NiVflMz8LFWGtOsTRW-s1wxgX761JUZ1mKXfFElzps8JPGjAvx4Vhc3q1Q9GeaPV_zlsl_DvTkW1xyBbepK6-PUvZJjK9h9Zi7QQD25l1fE-Z5XJ1gw_b5TY_yVnqurmBVSKuw0IanuoyRYvVoXs5kp6f6z9BFtuhsgcLHqNqQRMUaa6_zpcZZnIIDGBjez1QEx_pPwnKmWpswowjLvVCRt6nLEBM1ZuwPcFO2u22-cWe5an6QhgbcH6K0Z9idb7F0l6x8QcYXKD3B1JWbq39xhdmbrEBG2JlPoaJWWdtexAPKys_RxAbL3qJzBnp9r7BHqAu-YcXYi93Pk7RLPW9xk0hbvVHEF7l8QtSVau2-w8anbE1wk1bIb6_yl_iOYIBDSbr9YJbIiF9-s7a7qj-wZMY7vXKlxsvsgcN1Rz3PAre2uw6CYlb6b2_DtEuqfvFHqsxvwIJ3W9yeokepHs8htyp6nUGWx3l-sXMGS66_E_cmex_zprcb7nFieMjOYJGUimusQJVmaFvBUvZLfW5gZMnbsNBSlxhcgbLkS6ufE_WZS6xfsliZb7BSR_dOUJFlGsu-cqa2emxOQ7ZnTZ-ylIgLvYFWxsg9gbOo2E5voFe2u1DA1be6n29zGBjdQJG3ubu-cdKm-mtOtJVLq_7BZ7qan-HGp7m_v1MXyd1ORANJe9_QRbiMrM-SyAicPsOzyWstbzQWyq8ylGfLrl7QNmea4MOj93mPfrLIGN6QY6TWmswxxdbob6KjV8u9cIBUyKrOs7PIaqyPYmf7fX9Sl7rKwKGVd7pNj5Rn6cueQ-Z2qv2w1ZZITI_yVpusbF_zRomsbvJFOD4N8-NaXA-CRRlrTrF1dkda_mG0N1n9kLOpCP7uVVdc3v-VJEeMrQSjSstMMJbGeX8vc3hJHj8htMoqTFEWVmyeofJ1qJpvQ-SYXHxRAodsHM_iZafLkHBVCApNgJY5Kk8v0njau85CdIgKcBEU1vyNH1RYGn3-QVeoWv-hMpZJe7ABBFfMHmGll7pAn0ZIeD6BsQVGWf1Ak1a4_J-yqAf97VRXaSvOVBRpaFv_UkU4m65htFeqbPDDxnwL8eFYW3-xoFP3an2QwvaZvKIB9-deUYFmx21_MtepjJ9iI1icb4KUxit78OO22NusU4Nmq_ttUPRHqr1_85a5rw705FtcwcOIqUxw8MaYioBjltjsPUCClVkLj1FEueqeL2OGS90fgldKnU7ENPlZz3D0hXda_mFEt3n9kLOZCP7uVVXIbzKS1qlewGFCVflMr1LE-Ju-lAP56VBSR6bMfmKhVPhLnmFT95q9kwL2uZy_MffnXl_FVltKb5R2uSqvsMaXys7dUPRHiq1P85a5nw705FltAKT0ekxw9IXZ2pACVKk4joITRQZZ_UCjZrlsv8JVeLr-wcR6Cf_vVln7fgOz2ch88KS3pzwOcJaIDN6gZFbajd9VNDl8DsTFh6zdQmO52g9h9MhmWf1Ag8bI_J-yeAf97VRWN6x-8efYCU_vdMVKC0Ij1VuMDWIWaa2uAdbHTDufRcfJXm5vUvZpTK9h9Zi7cQD25l1ew9Wqrb5Stbi4bR_jJEmOMEKHKDxPo7aYjNsyYyWHTf6QpwiK7WOzqRq8QaUUWcwwcbVayyAyk8m5vdBD2AiOMFSjWMt9QrUnKs3edHZ4XZ8k1mmrIBFGSIq9kERVump_cJb63E1_g8d5iz90l8prz3PzyIt9oIJGqqt-gvZqfC9Rp2rabdO0KHpbgoNkZ0puZBa6Ox6_sjcqHRAiaBdNXzJ2qIpvsNOHy7yCtaW6y8xf82Z5zD7yRTg-DfPjWlxgU5apXGCzZfdJ3mFlCLvLUFPjuLtt0kKHad-Pc0imWf1As0aY_J-yaAf97VRX6K4hYtNYaU6jREnKH9BxBil8vbFl2G0doTWn2h6CxHWpfKGRttltb-PThFf7bpGEdvqdsFYF--7h4VZrv1IlB8uODF_yVkmMXlUE-upQFSh4K0AhV1lNH35R9FhbfVQD-elepCcprP-OM2i8XyIEg1b5XUCDVVwPDvI0912hxRd7LqFvVgX77uMWiPv6_kD0NvlfQFVKCk_Co3ZrTGHzlolcvyQXOJuuQlHm6kxt5XdbKs8gQzZbbl8zVafrcKWHaszAkcdmW5DCZpaqjp3hiKk8TaClqXxgAzPG6n6vkOSqjhFx1pf87tO0Byl_b-PYxz6NYHaYXcBzBklaW39jZYq93uJmWJzd8KRJHA0R4qZKrj5Tpmd6jgPCNZn_QFPFlzzNIWVHa84CVNcsrA8AVwb-EYP29f0QgvX0-u8ShPf2-jzwMvVa3lFGF5uOQXBXBv4Rg_b1_RCC9fT8H4H08_nuEYP29fk7_zH0WJz-pEhLPmESlolMe1IB-RyO8fD4G43w__XqHY_y8fU3-z3wVhhrzZ_nmh2NsmYIXFxwkVhrPM2gRsoZjKPEd1tcwoO3R2uvwkbH-l1xkslHXg3z6BuN8P_zNfk7_lPWrJ9uxXPpKp60wulLrFDTVpvfoCGn24ptlGSI3XCydUebmuCFiCuuQII0-Xxv8rJGamzAdZYYymHDhwZLD7MGtUnugGF1R7qB1FWXqb7Q46hcLw1UA_nuEYP29fk7_zH0Wq0iZcVbXgFExkaKf8HGOPqO4EToa5oxMma6CZ3SowYHXg3z6BuN8P_zNfk7_lJVzE1QkrXZXd1DtbfsjZB190kMDVQD-e4Rg_b1-Tv_MfRZ36-hiDtsL9RTarl-A7alia1uIYSnml9UhdoNX09jyWmtcqO16TuxpDN2Xd_SRBkavr4zFgqsT3B2dluPokRVK-yR88Waq0Dh16f47o91pgdeDfPoG43w__M1-Tv-U-honzH0-Dqd4RKGhstAIEIp2k8-c4YpmVAP9eodj_Lx9Tf7PfBUOV2vtEc36a_xUkkr_IJhdeqLnnP1RwoLUgH37B-B9PP3Of0_8lgtkMJ2iXntYePHR0zPchSK20yA4_l6H4Kj1ai-nqP1SAzQIHao2-9yxEZrDrDEVRZcrQABWAf94hWH-vn9P_M1-FB_VfU7XKJxtsqqYVCjuLpsoRKWar8QBdYrCsBv5Ug9MFNWWRzbYfOG2WpxI0WYfdvvxok8TnGiuGd8r6G3yXu-QSJmSE9ig9Qqa1EyRJfMTZCCdZh88VMH-Nw_BGWWua5hRmWKb9B0SFkNTzPmWk2OgWZleWxB9QXLapDEhLrKgHDSRqm9cAUl285-tLOJzY9_Y6l7-1HjdocuXWHFWGm_8zLJi1zv4yX6vMDxlSfMXVDiVowLUgMlS16Qg4RHCgtSAffsH4H08_c5_T_yWqtMQpVIqQwNVAP7HoDz8vodj_Lx9-wfgfTz9zn9P_JXjTvgtlV6rkCxaHm8PqHUaHzNwwan3N_AkmfoCVAP9eodj_Lx9Tf7PfBWGE7QoITaCrAPc2dqu0HjVUrLTrGVJ7y_z2bIW55RwpgYrt8PVgX74BOF-Pf7PfEz9ltwYYNnbb3yYmbbTMIlGLj7sMJEmhs90YPnSQwNVAP57hGD9vX5O_8x9FlLoLKHycrOkfSYTY5Spmcsr0LTqEeqnnRX1prsMzWmB14N8-gbjfD_83X5O_5V5rw7kmFou9vxsrfWzcxjVneYjXHxh4uNTqCmyss-sKLJbNyBoqba7F1j9xlaXkDClaxbPnWHiT2tUdcYfazAcqh7XZ5Ftjj6X8OzWelsf7O2XJzyQxYnW32BZThc3hJEFTws_0GluGthgKfKjG_vJDeIPy_ih3h6gUQTWi1OL7aZCY7hY1Q7SoGkR6pdXJHWKQpff-W4OvudoVNHja0AAVgLCvIVh_r5_-9UaXut0vQHus_AA6abjN1T81lMrQABVPhLTrGUZ3pNoMNl-czPdQT8H4H08_npUFGDh6xuEtQIastRY8YYXi0yRqVY_E-SZWf7nrFHBvzsU1T52oxxVbU6bJITF7pMIKPDqHzQQPa2TM1ApPgajt50hIoazDEkSSda_kGEl6n9kLNJDA¢\u0001\u0004tbMywyLDY0NTNdLFsxLDksNjQ3OV1dLG51bGwsW251bGwsbnVsbCxudWxsLFs2LDQuMTE2NjY2NjY3MTYzMzcyLDAuMDAyOTAwMTg0MzQ0MDUwMTEyLDldLFsxNTIsMC4yOTczNjg0MjExOTQ3ODA4LDAuMDA1MzA3MjE5OTM1MTM4MTI1LDNdLDAsMCwxXSxbImNkbi5qc2RlbGl2ci5uZXQiLCJmb250cy5nb29nbGVhcGlzLmNvbSIsInByZXBlc3Byby5jaHJpc3R1bml2ZXJzaXR5LmluIiwiY29kZS5qcXVlcnkuY29tIiwia2l0LmZvbnRhd2Vzb21lLmNvbSIsImthLWYuZm9udGF3ZXNvbWUuY29tIiwicHJvZC1lc3Byby1wdWJsaWMuczMuYXAtc291dGgtMS5hbWF6b25hd3MuY29tIiwiYWNjcmVkaXRhLmNocmlzdHVuaXZlcnNpdHkuaW4iLCJ3d3cuZ29vZ2xlLmNvbSIsInd3dy5nc3RhdGljLmNvbSJdLFsxLDU2M11dª\u0001t0aAJ8Qx1bBO0MAZ93l6RmeB1TS4Fcn-c82tkDpnk518RLZbC5qDa6cWlfJGPQdEZh-rs0u-kXP3FpM13bia7QNqyj1z3yIpmgd2STGNNTJ_Hxj1eV5mA²\u0001¤\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Ê\u0001:W1tbNTAwNiw5N10sWzY0NjA3LDJdLFs0NTQ2NCwxXSxbMzU4MzcsMV1dXQà\u0001 \u0001è\u0001°ê\u0001", {"content-type":"application/x-protobuffer","origin":"https://www.google.com","referer":"https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y&co=aHR0cHM6Ly9wcmVwZXNwcm8uY2hyaXN0dW5pdmVyc2l0eS5pbjo0NDM.&hl=en&type=image&v=BnqMGSY_YP4cCmbNINHpJPkd&theme=light&size=invisible&badge=bottomright&anchor-ms=20000&execute-ms=30000&cb=ef99wmvfnxmf","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #2: POST /Public/Security/Auth
    executeApiCall('02_Auth', 'POST', 'https://prepespro.christuniversity.in:81/Public/Security/Auth', "{\"loginId\":\"Cimi\",\"loginPassword\":\"Cdi@christ2026\",\"loginReCaptcha\":\"0cAFcWeA5Oy9RT5lWulLnhDalOVn91ij3Eke5S1S9KwHMZRyheq6eow4mlw6MsR179WfE9AsQ1FIjzv6F7ETfU_EhWEXcYXTV4SdMoMZYtQyBybc4qtvLHvkgjmBgbfpk9ee3xlFv5Go-OIuRC67cpmJsGvbwTrzo8tCjyUC3zdzV-hUDFbETDJDNJfNHlV8kH6db49KJbuEFXU8g_F-tZHAGC3hQ6czc8-hreEQaHAogWAQiCdmDubE6J5YHIb0fXSASMBoh_Ey9VIn4tTwuWBFrDq4x-qKsM5HgfhuikfZDDSPNyibrriNRu9F11lkMYRx2oqZo16GM3XLdiwUjT59J2I6ZfAFiNgiKnmw8ULb75DQpYpRH0xA8j7Rue3q0oKqE9vX4wgeBCtFClvm18jnKceNYAYGPDv8BFXOPwaEtSauUyJvvXL2Yp2RsLnzAHy9ynrwI1UFdCktWXyXoDmA8ZDPOdD_1zue3LfgukxhgHVmMY1Ids7bkN9n7s7Kj7WVE4Kblu605Z6RN6qQ-djL9YaBAa9UANQiS-hgCYYF1w50ROAG39qlW6gWdGu0nF9dCm6h8FXf3gGmiZ1LSa63IINrwPQZAh_aRH7QBIuJqVwWnIb9PU-KewWKzwBFrbOjMunGk74V7bbFw-81DGFZqHR6OGWHwt7h7fZbRpZR4fw0anJbjnn9y_n0nM3CzT01E5a-syxV3wiDylZLFIJXioYpHW4YviTLotOFFb4trcGpxPYuDrtcpIxWcBf2QP_HLpy3auPwl86__Cvemi44LmsFklcnWL2aQMk3p9AvY6SM5T_MsOinTC_75j0VJmyaDz8RtmNLexCFdBFcpm6Cpj6P3gX9hlTO-D2BpoJypjlPD3nHc-MptRomWFLuGnMO4dl2GQOugyhzzrzWawP8u6WTyIKRTZgTfZmJic9W-v46CfeJPDR3-DFFg8jJSOz910NPnbRLHFtdZPBwF_6MhtSbXe_UslQbA6ZCsDZgs1XYvap5SkLeZRqrbhylEhfbfyOIHLUktG0-bbYIq9em5Y_68iVpQF0Flz51gFjq1MerftUYhVQQGNA4k20N3zDIjpYTu5kAf6Ypcwa7FktGJevITWui_QH65syOVl4onS_ja2VKpuCMarqwaTcMswYgzq9glinrli8fyqI9Zod336fuawlukztARlTQFHVLET0cUxEvNYqFZJ5kybMHzSuGdJBkjPefZymwTXqPRtm68vrpbSU87UBe_41rMca0IKoKvbzOe6Pw5DQv2LOsYc4PRxi7fBwZtpqBTYsnYLJSlB_0rYL6k1gUykzkl3gLqOvGRSEnolQQigG8fmbe7csaeQzSQtvVC-BXpmx9RitefQYpiMA08TmtioavF9iBCUap0sYIPmWwo\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #3: OPTIONS /Public/Security/Auth
    executeApiCall('03_Auth', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Public/Security/Auth', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #4: POST /recaptcha/api2/clr
    executeApiCall('04_clr', 'POST', 'https://www.google.com/recaptcha/api2/clr?k=6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y', "\n(6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y\u0012\u000f03AFcWeA62r-0g6n9BTFEf7cc3FWpz4qcC9hDMYXpPTwUKyzTRBe9a7rUaXq2Yxe2XFRuD2egrjNmNZk_NizlauWGt-3pMjS00-BnmUFKg24cTppzRbsQdy8-WSxN3jyzKOT0iUqtTRF1_EKYl-aFyhBuN1clhslP7l-x3yecqOyBVHrs3q2Wwoyok_ciVb0tiBxsZT0VLHpqSEA6siwRNRHJCYPV-2oSCbBMK1WatNG4ANctQVb9tw4C26MadSXekIBZ-c4HSkf3_XLmM7V3vdS-UIm7Y-B1Jfut3EyQ2q9nwMp7cm3Gy2dVqbdfZPOMU59fMj4ndX7Y7UNoROga6cM2U0_91nocdKrwRXmEfySe7WUGnFgdyX9Bzh3M1co620Xp1G48_c90FJ0Qr-LZXj7fLJKDDnxRULFgDQYigCwVi-PqNvRnT8IT454kd1AXTwh14eFd8oHBPCzHHJ7mejoKKMnYuAwMlDKo5xtEX2ZfN17t21BS0e2Pfs1zo97sOCiXOzoTD8BUjKUBgY09Pth8BuX7ngZj5_kGukFWEgXXbc4oCO4Es4kIuoMD9OeUZhLx2SyFxCRidBxJZojzqPzZSiykFkP-xJ8etneoLAOCAK1nmam5w_CV0-KZQiH7wMfqWfUx76LTD7aNwnSiIh1DphH2q2Qgmgt8xEo8xaKEbNDUkFln-XC_ukeKtmmFGhXTZlPC4df-XS1cEkxaV_FyYzGWaSz3AX5jd7OUomTGKkANYieXJD9nozQJ3Qgsa1GXOFHo9UeqAUif54u0v8dLZq7vCFNixthRxlZgVXdTP3khDclSIS_mpSs9OR66VkVZeABs46rzyh56r2P6YD1FWy2EtKuFkXWUg0fLH62iz8MUg0iT--8818PT7KdYdz-JPdf7AFkvgHqMGiz5olR5vo8VUynogCXao70ZTcBW3Q7roFh4LYrJS9daIqigiLBwe0HliDLeca5ddj4Euj2mhZZ9B92zVVdJqVjfW018vUWIfDXL28hK31PCA6S622PAHRJz9ssknzX5ROMvVM_S_zBmMeMzO5v-a1kCc6ZIGS2iGoJxO-BLAh98fechpdI_ebdnCODAGk20Um5gbi5yb4Xy2esXJSU74ojJmSPUEVnsNW2HW2VxxZEotYBjJgUmqxhZAogeOxOE_XYxkPQmzYf-wUlTBEGYe4CCnKJOTfCt7_Z_ahWiwxdZ-Dxkciig5mH7_SWj7fD4gdJQWT-E2HD_8EUH8S6FPxy_D4eoBRjj461rf7ZAcuDrBWh9faepdWB8O6kKHXcXfddvuxkOV_GD5obTNlEyTlhXjipK8MTHgcUm08aiXb1TlG5kK6OFY6Mrg7s5WfbJS5PCoBVfe4SbNuMFSuPWkZy57GWEx__OAybekJGuETegUq1jsuyZltBpcNcyw7QsChuri-jF8o56PChyD8II_vreRuBbeJR_fe15YzB_LEzx8CKJmsjSj1ziIBHISGDmsJHC9YeBJvrZuVV7WgeY-XMEe3HHk3tRydFLj-NUJqrvq49e83DARQbGYjI4SF1q_3CD4n8DRkb9Ngdk-mtxSrrNx1GdXj4Tdd6GZ0GLV4zi-of5KScSsEKzb6be2MyYbw8aHXm3m-9oscTUnm38_Z1nqu47WQPmL9LmGJs9IZ_Oe-6zGePI_xpUeVHq2nHZhth5x2IbdKXA455YJKMwQkTcA7OxeNibdKG6CKuxJEvCeKtEYm123nCek9TDqpYWdsUFYV0TlkvsjN-jJ0FsX4kntByrxIm8b4wN0-aHA0I7zTTaqL-LimQbdqma13rb-y0EsbzE9BL7EM5N7LyUz2ScbxwzrNbAq1mESUOF0cwNn_cc7wTe6berrak0BZO2a4YOmRQ-2fO8tOUjcYd1ylQWpN3TsgWsgSbKFMfUcW7Uq_bumuI76HU7Ssvuu\u001a\u0018BnqMGSY_YP4cCmbNINHpJPkd\"y\u0018\u0001*k\n\u0007\b\u0005\u0010ã2\u0018{\n\u0007\b\u000b\u0010w\u0018\u0012\n\u0007\b\u0006\u0010w\u0018%\n\b\b\u0003\u0010øv\u0018Í\u0001\n\u0007\b\u000f\u0010à3\u0018_\n\b\b\u0001\u0010Ñ3\u0018\u0001\n\u0007\b\u0002\u0010ûv\u00185\n\r\b\u0004\u0010²w\u0018\u0001*\u0003\u0010Â`\n\u0007\b\u0014\u0010µ2\u0018\u0002\n\u0007\b\u0012\u0010Ï2\u0018\t\n\u0007\b\u0013\u0010ä2\u0018{8\u0002@ \u0001H°ê\u0001", {"origin":"https://prepespro.christuniversity.in","referer":"https://prepespro.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #5: GET /recaptcha/api2/anchor
    executeApiCall('05_anchor', 'GET', 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y&co=aHR0cHM6Ly9wcmVwZXNwcm8uY2hyaXN0dW5pdmVyc2l0eS5pbjo0NDM.&hl=en&type=image&v=BnqMGSY_YP4cCmbNINHpJPkd&theme=light&size=invisible&badge=bottomright&anchor-ms=20000&execute-ms=30000&cb=ef99wmvfnxmf', null, {"referer":"https://prepespro.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #6: GET /recaptcha/api2/anchor
    executeApiCall('06_anchor', 'GET', 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LfM1AkhAAAAAD-8ddZ4Ooy2bPCF9EFs0cWS5J2Y&co=aHR0cHM6Ly9wcmVwZXNwcm8uY2hyaXN0dW5pdmVyc2l0eS5pbjo0NDM.&hl=en&type=image&v=BnqMGSY_YP4cCmbNINHpJPkd&theme=light&size=invisible&badge=bottomright&anchor-ms=20000&execute-ms=30000&cb=1cda8v54yzh9', null, {"referer":"https://prepespro.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #7: GET /Maintenance/status.json
    executeApiCall('07_status.json', 'GET', 'https://prod-espro-public.s3.ap-south-1.amazonaws.com/Maintenance/status.json', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #8: POST /Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot
    executeApiCall('08_checkUserRegisterOrNot', 'POST', 'https://prepespro.christuniversity.in:81/Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #9: OPTIONS /Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot
    executeApiCall('09_checkUserRegisterOrNot', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/QuestionBankServices/QuestionBank/CodeTantra/api/checkUserRegisterOrNot', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #10: GET /Protected/Common/GUI/getLatestReleasePoster
    executeApiCall('10_getLatestReleasePoster', 'GET', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getLatestReleasePoster', null, {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #11: POST /Protected/ScreenConfig/getSystemMenus
    executeApiCall('11_getSystemMenus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getSystemMenus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #12: OPTIONS /Protected/Common/GUI/getLatestReleasePoster
    executeApiCall('12_getLatestReleasePoster', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getLatestReleasePoster', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #13: POST /Protected/ScreenConfig/GetScreens
    executeApiCall('13_GetScreens', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/GetScreens', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #14: OPTIONS /Protected/ScreenConfig/getSystemMenus
    executeApiCall('14_getSystemMenus', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getSystemMenus', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #15: POST /Protected/Dashboard/UserPreference/getFontByErpUserId
    executeApiCall('15_getFontByErpUserId', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Dashboard/UserPreference/getFontByErpUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #16: OPTIONS /Protected/ScreenConfig/GetScreens
    executeApiCall('16_GetScreens', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/GetScreens', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #17: OPTIONS /Protected/Dashboard/UserPreference/getFontByErpUserId
    executeApiCall('17_getFontByErpUserId', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Dashboard/UserPreference/getFontByErpUserId', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #18: GET /static
    executeApiCall('18_static', 'GET', 'https://accredita.christuniversity.in/static?file_name=logo-black.png', null, {"referer":"https://prepespro.christuniversity.in/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #19: POST /Protected/KPServiceNew/rest/getEmpAttendance
    executeApiCall('19_getEmpAttendance', 'POST', 'https://prepespro.christuniversity.in:81/Protected/KPServiceNew/rest/getEmpAttendance?duration=STARTTHIRTYDAYS', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #20: OPTIONS /Protected/KPServiceNew/rest/getEmpAttendance
    executeApiCall('20_getEmpAttendance', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/KPServiceNew/rest/getEmpAttendance?duration=STARTTHIRTYDAYS', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #21: GET /recaptcha/releases/BnqMGSY_YP4cCmbNINHpJPkd/recaptcha__en.js
    executeApiCall('21_recaptcha__en.js', 'GET', 'https://www.gstatic.com/recaptcha/releases/BnqMGSY_YP4cCmbNINHpJPkd/recaptcha__en.js', null, {"Referer":"https://www.google.com/"}, '15s');
    sleep(0.5);

    // Request #22: GET /recaptcha/api2/webworker.js
    executeApiCall('22_webworker.js', 'GET', 'https://www.google.com/recaptcha/api2/webworker.js?hl=en&v=BnqMGSY_YP4cCmbNINHpJPkd', null, {}, '15s');
    sleep(0.5);

    // Request #23: GET /recaptcha/releases/BnqMGSY_YP4cCmbNINHpJPkd/recaptcha__en.js
    executeApiCall('23_recaptcha__en.js', 'GET', 'https://www.gstatic.com/recaptcha/releases/BnqMGSY_YP4cCmbNINHpJPkd/recaptcha__en.js', null, {"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","Referer":"https://www.google.com/"}, '15s');
    sleep(0.5);

    // Request #24: POST /Protected/KPServiceNew/rest/getAttendanceGraph
    executeApiCall('24_getAttendanceGraph', 'POST', 'https://prepespro.christuniversity.in:81/Protected/KPServiceNew/rest/getAttendanceGraph?duration=STARTTHIRTYDAYS', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #25: OPTIONS /Protected/KPServiceNew/rest/getAttendanceGraph
    executeApiCall('25_getAttendanceGraph', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/KPServiceNew/rest/getAttendanceGraph?duration=STARTTHIRTYDAYS', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #26: POST /Protected/ScreenConfig/getErpNotifications
    executeApiCall('26_getErpNotifications', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getErpNotifications', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #27: OPTIONS /Protected/ScreenConfig/getErpNotifications
    executeApiCall('27_getErpNotifications', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getErpNotifications', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #28: POST /Protected/ScreenConfig/getUserCampus
    executeApiCall('28_getUserCampus', 'POST', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getUserCampus', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #29: OPTIONS /Protected/ScreenConfig/getUserCampus
    executeApiCall('29_getUserCampus', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/ScreenConfig/getUserCampus', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #30: POST /Protected/Common/getIsAiEnabled
    executeApiCall('30_getIsAiEnabled', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/getIsAiEnabled', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #31: OPTIONS /Protected/Common/getIsAiEnabled
    executeApiCall('31_getIsAiEnabled', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/getIsAiEnabled', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #32: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('32_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #33: OPTIONS /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('33_getFavouriteAndRecentList', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #34: GET /ERP/assets/TrainingRequestGrid-DqRwc4nT.js
    executeApiCall('34_TrainingRequestGrid-DqRwc4nT.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/TrainingRequestGrid-DqRwc4nT.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #35: GET /ERP/assets/AgGridTable-ajHV_YME.js
    executeApiCall('35_AgGridTable-ajHV_YME.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/AgGridTable-ajHV_YME.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #36: GET /ERP/assets/DragIndicator-wkned60S.js
    executeApiCall('36_DragIndicator-wkned60S.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/DragIndicator-wkned60S.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #37: GET /ERP/assets/main-DDw50E1V.js
    executeApiCall('37_main-DDw50E1V.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/main-DDw50E1V.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #38: GET /ERP/assets/ListviewAggridCustumComponent-CLoo63rk.js
    executeApiCall('38_ListviewAggridCustumComponent-CLoo63rk.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/ListviewAggridCustumComponent-CLoo63rk.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #39: GET /ERP/assets/DeleteIconRenderedComponent-CIyTWuJt.js
    executeApiCall('39_DeleteIconRenderedComponent-CIyTWuJt.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/DeleteIconRenderedComponent-CIyTWuJt.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #40: GET /ERP/assets/Close-B1eTFIU1.js
    executeApiCall('40_Close-B1eTFIU1.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/Close-B1eTFIU1.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #41: GET /ERP/assets/index-CYydPY1x.js
    executeApiCall('41_index-CYydPY1x.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/index-CYydPY1x.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #42: GET /ERP/assets/localeData-BeS_Xirp.js
    executeApiCall('42_localeData-BeS_Xirp.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/localeData-BeS_Xirp.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #43: GET /ERP/assets/customParseFormat-CF-vU0FG.js
    executeApiCall('43_customParseFormat-CF-vU0FG.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/customParseFormat-CF-vU0FG.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #44: GET /ERP/assets/PurePanel-Y3tpCNta.js
    executeApiCall('44_PurePanel-Y3tpCNta.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/PurePanel-Y3tpCNta.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #45: GET /ERP/assets/useIcons-CO3dYS7x.js
    executeApiCall('45_useIcons-CO3dYS7x.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/useIcons-CO3dYS7x.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #46: GET /ERP/assets/DownOutlined-B4WlcHXH.js
    executeApiCall('46_DownOutlined-B4WlcHXH.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/DownOutlined-B4WlcHXH.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #47: GET /ERP/assets/CalendarToday-CN5aEAnS.js
    executeApiCall('47_CalendarToday-CN5aEAnS.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/CalendarToday-CN5aEAnS.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #48: GET /ERP/assets/Delete-DvNTYSSl.js
    executeApiCall('48_Delete-DvNTYSSl.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/Delete-DvNTYSSl.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #49: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('49_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":\"\",\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"990\",\"label\":\"Training Request\"},\"sysMenuComponentPath\":\"views/Support/Request/ESProTraining/TrainingRequestGrid.jsx\",\"iconClassName\":\"\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #50: OPTIONS /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('50_saveOrDeleteFavouriteAndRecent', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #51: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('51_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #52: OPTIONS /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('52_getFavouriteAndRecentList', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #53: POST /Secured/AdminServices/Support/ErpTraining/getDataByUserId
    executeApiCall('53_getDataByUserId', 'POST', 'https://prepespro.christuniversity.in:81/Secured/AdminServices/Support/ErpTraining/getDataByUserId', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #54: OPTIONS /Secured/AdminServices/Support/ErpTraining/getDataByUserId
    executeApiCall('54_getDataByUserId', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Secured/AdminServices/Support/ErpTraining/getDataByUserId', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #55: GET /ERP/assets/OfflineHostelApplicationTab-B8lqy1gt.js
    executeApiCall('55_OfflineHostelApplicationTab-B8lqy1gt.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/OfflineHostelApplicationTab-B8lqy1gt.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #56: GET /ERP/assets/HostelRoomAvailablePopup-BFDgvUFc.js
    executeApiCall('56_HostelRoomAvailablePopup-BFDgvUFc.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/HostelRoomAvailablePopup-BFDgvUFc.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #57: GET /ERP/assets/Remove-DD0YVfMs.js
    executeApiCall('57_Remove-DD0YVfMs.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/Remove-DD0YVfMs.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #58: GET /ERP/assets/index-ClcXbEW-.js
    executeApiCall('58_index-ClcXbEW-.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/index-ClcXbEW-.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #59: GET /ERP/assets/ActionButton-CPeyoPU7.js
    executeApiCall('59_ActionButton-CPeyoPU7.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/ActionButton-CPeyoPU7.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #60: GET /ERP/assets/index-LwFGpdW8.js
    executeApiCall('60_index-LwFGpdW8.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/index-LwFGpdW8.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #61: GET /ERP/assets/ToggleButtonGroup-B95osIK8.js
    executeApiCall('61_ToggleButtonGroup-B95osIK8.js', 'GET', 'https://prepespro.christuniversity.in/ERP/assets/ToggleButtonGroup-B95osIK8.js', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/ERP/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #62: POST /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('62_saveOrDeleteFavouriteAndRecent', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', "{\"id\":\"\",\"quickLinkType\":\"R\",\"sysMenuDTO\":{\"value\":\"967\",\"label\":\"Hostel Application\"},\"sysMenuComponentPath\":\"views/hostel/application/OfflineHostelApplication/OfflineHostelApplicationTab.js\",\"iconClassName\":\"\"}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #63: OPTIONS /Protected/Common/GUI/saveOrDeleteFavouriteAndRecent
    executeApiCall('63_saveOrDeleteFavouriteAndRecent', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/saveOrDeleteFavouriteAndRecent', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #64: POST /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('64_getFavouriteAndRecentList', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #65: OPTIONS /Protected/Common/GUI/getFavouriteAndRecentList
    executeApiCall('65_getFavouriteAndRecentList', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Common/GUI/getFavouriteAndRecentList', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #66: POST /Secured/Hostel/Application/HostelApplication/isHighPrivilege
    executeApiCall('66_isHighPrivilege', 'POST', 'https://prepespro.christuniversity.in:81/Secured/Hostel/Application/HostelApplication/isHighPrivilege', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #67: OPTIONS /Secured/Hostel/Application/HostelApplication/isHighPrivilege
    executeApiCall('67_isHighPrivilege', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Secured/Hostel/Application/HostelApplication/isHighPrivilege', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #68: POST /Protected/Hostel/Common/getAcademicYear
    executeApiCall('68_getAcademicYear', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getAcademicYear', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #69: POST /Protected/Hostel/Common/getHostel
    executeApiCall('69_getHostel', 'POST', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getHostel?showAllHostels=true&sysMenuId=967', "{}", {"Content-Type":"application/json;charset=UTF-8","Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36","__campus_ids":"2,4,1,5,3,7,8,","x_jwt_id":"1","x_jwt_type":"EMP"}, '15s');
    sleep(0.5);

    // Request #70: OPTIONS /Protected/Hostel/Common/getAcademicYear
    executeApiCall('70_getAcademicYear', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getAcademicYear', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

    // Request #71: OPTIONS /Protected/Hostel/Common/getHostel
    executeApiCall('71_getHostel', 'OPTIONS', 'https://prepespro.christuniversity.in:81/Protected/Hostel/Common/getHostel?showAllHostels=true&sysMenuId=967', null, {"Origin":"https://prepespro.christuniversity.in","Referer":"https://prepespro.christuniversity.in/","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"}, '15s');
    sleep(0.5);

  });
}

export function handleSummary(data) {
  return {
    'tests/christ_university/reports/grafana_summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
