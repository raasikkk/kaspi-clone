import crypto from 'crypto';
import fetch from 'node-fetch';
import { DEVICE, APP, UA_NATIVE } from './config.js';
import { computeTokenSnMac, computeXSign } from './crypto.js';

// ─── Utilities ───

export const generateUUID = () => crypto.randomUUID().toUpperCase();

export const nowISO = () => {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return (
    d
      .toISOString()
      .replace('Z', '')
      .replace(/\.\d{3}/, `.${String(d.getMilliseconds()).padStart(3, '0')}`) +
    sign +
    hh +
    mm
  );
};

// ─── Cookie builder ───

// device — identity привязываемой кассы. Без него берётся старое общее
// устройство: так продолжают работать кассы, привязанные до перехода.
export const entranceCookie = (extraUserToken, device = DEVICE) => {
  let c = `deviceId=${device.deviceId}; installId=${device.installId}; is_mobile_app=true; locale=${APP.locale}; ma_bld=${APP.build}; ma_platform_type=${APP.platform}; ma_platform_ver=${APP.platformVer}; ma_ver=${APP.version}; pk=${device.pk}; pkTag=${device.pkTag}; xs=R:0|E:0|RH:0|N:0`;
  if (extraUserToken) c += `; user_token=${extraUserToken}`;
  return c;
};

// ─── Extract user_token from set-cookie ───

export const extractUserToken = (resp) => {
  const raw = resp.headers.raw()['set-cookie'] || [];
  for (const c of raw) {
    const m = c.match(/user_token=([^;]+)/);
    if (m) return m[1];
  }
  return null;
};

// ─── Logged fetch wrapper ───

export const loggedFetch = async (url, options = {}) => {
  const fetchOptions = { ...options };
  const redactBody = Boolean(fetchOptions.redactBody);
  delete fetchOptions.redactBody;
  const method = (fetchOptions.method || 'GET').toUpperCase();
  console.log(`\n>>> ${method} ${url}`);
  if (fetchOptions.headers) {
    const sanitized = { ...fetchOptions.headers };
    const sensitive = ['x-kb-tokensn', 'x-kb-tokensnmac', 'x-sign', 'authorization', 'cookie'];
    for (const key of Object.keys(sanitized)) {
      if (sensitive.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      }
    }
    console.log('>>> Headers:', JSON.stringify(sanitized, null, 2));
  }
  if (fetchOptions.body) {
    if (redactBody) {
      console.log('>>> Body: [REDACTED]');
    } else {
      try {
        console.log('>>> Body:', JSON.parse(fetchOptions.body));
      } catch {
        console.log('>>> Body:', fetchOptions.body);
      }
    }
  }

  const resp = await fetch(url, fetchOptions);
  const cloned = resp.clone();
  let body;
  try {
    body = await cloned.json();
  } catch {
    try {
      body = await cloned.text();
    } catch {
      body = '[unreadable]';
    }
  }
  console.log(`<<< ${resp.status} ${resp.statusText}`);
  console.log('<<< Response:', typeof body === 'object' ? JSON.stringify(body, null, 2) : body);
  return resp;
};

// ─── Signed QR-pay headers (session passed as parameter) ───

export const signedQrPayHeaders = (url, session, body) => {
  // Счёт/QR подписываются устройством ТОЙ кассы, которой принадлежит сессия:
  // подпись, pkTag в заголовках и tokenSN должны быть от одного устройства,
  // иначе Kaspi отвергает запрос.
  const device = session.device || DEVICE;
  const xsh =
    'url,X-Install-ID,X-PI,X-App-Bld,X-Platform-Ver,X-Locale,X-App-Ver,X-Device-ID,X-SV,X-Time,X-Platform-Type,X-Call,X-Kb-TokenSnMac,X-Kb-TokenSn';
  const headers = {
    'X-Kb-TokenSn': session.tokenSN,
    'X-Kb-TokenSnMac': computeTokenSnMac(session.tokenSN, session.decryptedSecret),
    'X-PI': session.profileId != null ? String(session.profileId) : '',
    'X-Install-ID': device.installId,
    'X-Device-ID': device.deviceId,
    'X-App-Ver': APP.version,
    'X-App-Bld': APP.build,
    'X-Platform-Type': APP.platform,
    'X-Platform-Ver': APP.platformVer,
    'X-Locale': APP.locale,
    'X-Time': nowISO(),
    'X-Request-ID': generateUUID(),
    'X-Call': 'notConnected',
    'X-SV': '2',
    'X-SH': xsh,
    'User-Agent': UA_NATIVE,
    Accept: '*/*',
    'Accept-Language': 'ru',
    'Accept-Encoding': 'gzip, deflate, br',
  };
  headers['X-Sign'] = computeXSign(url, headers, xsh, body, device.privateKey);
  return headers;
};
