import { Router } from 'express';
import {
  DEVICE,
  APP,
  UA_NATIVE,
  ENTRANCE_HEADERS_BASE,
  KASPI_ENTRANCE_URL,
  KASPI_MTOKEN_URL,
  KASPI_QRPAY_URL,
} from '../config.js';
import { createEmptySession, applyOrgContext } from '../session.js';
import {
  generateECDHPair,
  completeECDHWith,
  completeECDHWithSaved,
  exportECDHPrivate,
  importECDHPrivate,
  computeTokenSnMac,
  signDataPayload,
  computeXSU,
  computeXSign,
  encryptSecret,
  decryptSecret,
} from '../crypto.js';
import {
  loggedFetch,
  extractUserToken,
  entranceCookie,
  generateUUID,
  nowISO,
  signedQrPayHeaders,
} from '../helpers.js';
import { isKaspiReauthRequired } from '../services/sessionRefresh.js';
import { createDeviceIdentity, deviceColumns, deviceFromRow, legacyDevice } from '../deviceIdentity.js';

const router = Router();

// Kaspi нерегулярно отдаёт на org-context-otp тело, которое не разбирается как
// JSON. Ответ идемпотентный (ничего не создаёт), поэтому повтор безопасен.
const ORG_CONTEXT_ATTEMPTS = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// In-flight auth sessions keyed by processId (temporary, cleared after finish)
const authSessions = new Map();

// Сообщения об ошибках привязки для обоих финиширующих маршрутов.
const LINK_ERROR_MESSAGES = {
  KASPI_DEVICE_SESSION_CONFLICT:
    'Kaspi отклонил кассу: устройство уже занято другой кассой. Это ограничение на нашей стороне — напишите в поддержку Wevent, самостоятельно повторять подключение бесполезно.',
  KASPI_CASHIER_REGISTRATION_REQUIRED:
    'Kaspi выдала токен без прав кассы. Напишите в поддержку Wevent — подключение требует вмешательства с нашей стороны.',
  KASPI_PIN_REJECTED:
    'Kaspi не принял код быстрого доступа кассира. Проверьте код в приложении Kaspi Pay и повторите подключение.',
};

// restart=true, если processId израсходован (токен выпущен и отвергнут) —
// сессию сбрасываем, нужен новый SMS. Для отклонённого PIN сессия остаётся.
export function describeLinkError(err, processId) {
  const message = LINK_ERROR_MESSAGES[err.code];
  const restart = !!err.code && err.code !== 'KASPI_PIN_REJECTED';
  if (restart) authSessions.delete(processId);
  return {
    status: message ? 400 : 500,
    payload: { error: message || err.message, code: err.code, restart },
  };
}

// Periodic cleanup of abandoned auth sessions (older than 15 minutes, runs every 5 minutes)
const intervalId = setInterval(
  () => {
    const now = Date.now();
    const EXPIRY_MS = 15 * 60 * 1000;
    for (const [processId, session] of authSessions.entries()) {
      if (now - (session.createdAt || 0) > EXPIRY_MS) {
        authSessions.delete(processId);
      }
    }
  },
  5 * 60 * 1000,
);

if (intervalId.unref) {
  intervalId.unref();
}

export const getAuthSessions = () => authSessions;

// ═══════════════════════════════════════════════════
//  Step 1 — Init entrance (get processId)
// ═══════════════════════════════════════════════════

router.post('/init', async (req, res) => {
  const session = createEmptySession();
  // Каждая привязка получает СВОЁ устройство. Kaspi связывает device-identity с
  // одним кассиром, поэтому общее устройство означало бы, что новая касса
  // выбьет уже подключённую. Сохраняется оно в строку кассы на finish.
  session.device = createDeviceIdentity();

  try {
    const resp = await loggedFetch(`${KASPI_ENTRANCE_URL}/api/v1/entrance/step`, {
      method: 'POST',
      headers: {
        ...ENTRANCE_HEADERS_BASE,
        Referer: `${KASPI_ENTRANCE_URL}/process/entrance/?auth=2&appBuild=${APP.build}&appVersion=${APP.version}&platformVersion=${APP.platformVer}&platformType=IOS&deviceBrand=${APP.brand}&deviceModel=${APP.model}&deviceId=${session.device.deviceId}&installId=${session.device.installId}&frontCameraAvailable=true&sf=registration&pc=KPEntrance&noPass=0`,
        Cookie: entranceCookie(undefined, session.device),
      },
      body: JSON.stringify({
        data: {},
        Data: {
          auth: '2',
          appBuild: APP.build,
          appVersion: APP.version,
          platformVersion: APP.platformVer,
          platformType: 'IOS',
          deviceBrand: APP.brand,
          deviceModel: APP.model,
          deviceId: session.device.deviceId,
          installId: session.device.installId,
          frontCameraAvailable: 'true',
          sf: 'registration',
          pc: 'KPEntrance',
          noPass: '0',
        },
        actType: 'Success',
      }),
    });

    const ut = extractUserToken(resp);
    if (ut) session.userToken = ut;

    const body = await resp.json();
    const entranceError = body.view?.onOpenAlarm?.error;
    if (entranceError) {
      return res.status(409).json({
        success: false,
        error: entranceError.label || entranceError.desc || 'Kaspi отклонил вход',
        code: entranceError.code,
        body,
      });
    }
    if (body.meta?.pId) {
      session.processId = body.meta.pId;
      session.createdAt = Date.now();
      authSessions.set(session.processId, session);
    }

    res.json({ success: !!session.processId, processId: session.processId, view: body.view?.code, body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
//  Step 2 — Send phone number (triggers SMS)
// ═══════════════════════════════════════════════════

router.post('/send-phone', async (req, res) => {
  let { phoneNumber } = req.body;
  const { processId } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required (e.g. 7XXXXXXXXX)' });
  if (!processId) return res.status(400).json({ error: 'processId required (from /api/auth/init)' });

  // Entrance API ждёт 10-значный национальный номер (7XXXXXXXXX): срезаем код
  // страны 7 / междугородний 8 и любое форматирование, чтобы вызывающему не
  // приходилось нормализовать номер самому.
  const cleaned = String(phoneNumber).replace(/\D/g, '');
  phoneNumber =
    cleaned.length === 11 && (cleaned.startsWith('7') || cleaned.startsWith('8')) ? cleaned.slice(1) : cleaned;

  const session = authSessions.get(processId);
  if (!session) return res.status(400).json({ error: 'Unknown processId. Call /api/auth/init first' });

  session.phoneNumber = phoneNumber;

  try {
    const resp = await loggedFetch(`${KASPI_ENTRANCE_URL}/api/v1/entrance/step`, {
      method: 'POST',
      headers: {
        ...ENTRANCE_HEADERS_BASE,
        Referer: `${KASPI_ENTRANCE_URL}/process/universal-enter-phone-number?pId=${session.processId}&firstPage=KPUniversalEnterPhoneNumber`,
        Cookie: entranceCookie(session.userToken, session.device),
      },
      body: JSON.stringify({
        meta: { pId: session.processId, sn: 'EnterPhoneNumber' },
        data: { phoneNumber },
        actType: 'Success',
      }),
      redactBody: true,
    });

    const ut = extractUserToken(resp);
    if (ut) session.userToken = ut;

    const body = await resp.json();
    const smsSent = body.view?.code === 'EnterOtp';
    const desc = body.error?.desc || body.error?.label || body.data?.desc;

    res.json({
      success: smsSent,
      processId: session.processId,
      desc,
      error: body.error?.desc || body.error?.label,
      view: body.view?.code,
      body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
//  Step 2b — Send Kaspi password (if required by Kaspi)
// ═══════════════════════════════════════════════════

// Для части аккаунтов Kaspi после номера показывает не SMS, а экран пароля
// (view = KPEnterLoginPassword). Тогда SMS отправляется только после того, как
// пароль принят, — этот шаг закрывает такой сценарий.
router.post('/send-password', async (req, res) => {
  const { password, processId } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  if (!processId) return res.status(400).json({ error: 'processId required' });

  const session = authSessions.get(processId);
  if (!session) return res.status(400).json({ error: 'Unknown processId. Call /api/auth/init first' });

  try {
    const resp = await loggedFetch(`${KASPI_ENTRANCE_URL}/api/v1/entrance/step`, {
      method: 'POST',
      headers: {
        ...ENTRANCE_HEADERS_BASE,
        Referer: `${KASPI_ENTRANCE_URL}/process/universal-enter-phone-number?pId=${session.processId}&firstPage=KPUniversalEnterPhoneNumber`,
        Cookie: entranceCookie(session.userToken, session.device),
      },
      body: JSON.stringify({
        meta: { pId: session.processId, sn: 'EnterLoginPassword' },
        data: { password },
        actType: 'Success',
      }),
      redactBody: true,
    });

    const ut = extractUserToken(resp);
    if (ut) session.userToken = ut;

    const body = await resp.json();
    const smsSent = body.view?.code === 'EnterOtp';
    const desc = body.error?.desc || body.error?.label || body.data?.desc;

    res.json({
      success: smsSent,
      processId: session.processId,
      desc,
      error: body.error?.desc || body.error?.label,
      view: body.view?.code,
      body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
//  Step 3 — Submit SMS OTP code
// ═══════════════════════════════════════════════════

router.post('/verify-otp', async (req, res) => {
  const { otp, processId } = req.body;
  if (!otp) return res.status(400).json({ error: 'otp required' });
  if (!processId) return res.status(400).json({ error: 'processId required' });

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header to identify theater onboarding.' });
  }

  const session = authSessions.get(processId);
  if (!session) return res.status(400).json({ error: 'Unknown processId' });

  try {
    const { query } = await import('../db.js');
    const dbCheck = await query('SELECT id FROM keys WHERE api_key = $1', [apiKey]);
    if (dbCheck.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API Key.' });
    }

    const resp = await loggedFetch(`${KASPI_ENTRANCE_URL}/api/v1/entrance/step`, {
      method: 'POST',
      headers: {
        ...ENTRANCE_HEADERS_BASE,
        Referer: `${KASPI_ENTRANCE_URL}/process/universal-enter-phone-number?pId=${session.processId}&firstPage=KPUniversalEnterPhoneNumber`,
        Cookie: entranceCookie(session.userToken, session.device),
      },
      body: JSON.stringify({
        meta: { pId: session.processId, sn: 'ViewEnterOtp' },
        data: { userOtp: otp, inputType: 'auto' },
        actType: 'Success',
      }),
      redactBody: true,
    });

    const ut = extractUserToken(resp);
    if (ut) session.userToken = ut;

    const body = await resp.json();

    // Kaspi отдаёт на OTP либо `kpDeviceRegistration`, либо `KPMobileCall` с
    // `authMethods.cashierpin` (request: "optional"). В обоих случаях
    // финишируем с пустым pincode.
    if (body.data?.type === 'kpDeviceRegistration' || body.view?.code === 'KPMobileCall') {
      // OTP verified — automatically call finish
      const finishResult = await doFinish(session, '');
      authSessions.delete(processId);

      // Save cashier tokens to database
      await persistLinkedCashier(query, apiKey, finishResult);

      res.json({
        success: true,
        processId: session.processId,
        step: 'finished',
        message: 'OTP verified and cashier profile linked in database.',
      });
    } else {
      // Отклонённый код Kaspi не оформляет ошибкой: она просто снова отдаёт
      // экран ввода OTP. Без этой ветки вызывающий видел общее «Неверный код
      // или ошибка привязки» и не мог отличить опечатку от сломанной привязки.
      const retryOtp = body.view?.code === 'EnterOtp';
      res.json({
        success: false,
        processId: session.processId,
        step: 'otp_response',
        error:
          body.error?.label ||
          body.error?.desc ||
          (retryOtp ? 'Kaspi не принял код из SMS. Введите код из последнего сообщения.' : null),
        retryOtp,
        body,
      });
    }
  } catch (err) {
    const { status, payload } = describeLinkError(err, processId);
    res.status(status).json(payload);
  }
});

// Kaspi may require the cashier's local quick-access PIN after the SMS code.
// It is proxied only for this request and is never stored or logged.
router.post('/finish', async (req, res) => {
  const { pin, processId } = req.body;
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key header.' });
  if (!processId) return res.status(400).json({ error: 'processId required' });
  if (!/^\d{4,6}$/.test(String(pin ?? ''))) {
    return res.status(400).json({ error: 'Введите PIN кассира (4–6 цифр).' });
  }

  const session = authSessions.get(processId);
  if (!session?.otpVerified) {
    return res.status(400).json({ error: 'Сначала подтвердите код из SMS.' });
  }

  try {
    const { query } = await import('../db.js');
    const dbCheck = await query('SELECT id FROM keys WHERE api_key = $1', [apiKey]);
    if (dbCheck.rows.length === 0) return res.status(401).json({ error: 'Invalid API Key.' });

    const finishResult = await doFinish(session, String(pin));
    await persistLinkedCashier(query, apiKey, finishResult);
    authSessions.delete(processId);
    return res.json({ success: true, processId, step: 'finished' });
  } catch (err) {
    const { status, payload } = describeLinkError(err, processId);
    return res.status(status).json(payload);
  }
});

// Привязка сохраняет не только токен, но и устройство, которым она сделана,
// плюс ключ ECDH — без них SignInLite не сможет ни подписаться этим
// устройством, ни вывести общий секрет заново.
async function persistLinkedCashier(query, apiKey, finishResult) {
  const cols = deviceColumns(finishResult.device);
  await query(
    `UPDATE keys
        SET kaspi_token_sn = $1, kaspi_vtoken_secret = $2, profile_id = $3,
            device_id = $4, install_id = $5, device_pin_hash = $6,
            device_privkey = $7, ecdh_privkey = $8
      WHERE api_key = $9`,
    [
      finishResult.tokenSN,
      finishResult.vtokenSecret,
      finishResult.profileId != null ? String(finishResult.profileId) : null,
      cols.device_id,
      cols.install_id,
      cols.device_pin_hash,
      cols.device_privkey,
      finishResult.ecdhPrivateKey ? exportECDHPrivate(finishResult.ecdhPrivateKey) : null,
      apiKey,
    ],
  );
}

// Проверяем кассу реальным запросом по платёжному пути, а не по наличию
// ProfileId в org-context. Тот же вызов делает GET /api/session/check.
async function cashierSessionWorks(session) {
  try {
    const url = `${KASPI_QRPAY_URL}/v02/history/operations`;
    const reqBody = JSON.stringify({
      EndDate: new Date().toISOString().slice(0, 10),
      LastTransactionDate: '',
      StatementPeriodCode: 0,
    });
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers: { ...signedQrPayHeaders(url, session, reqBody), 'Content-Type': 'application/json' },
      body: reqBody,
    });
    const body = await resp.json().catch(() => ({}));
    return { ok: resp.ok && (!body.StatusCode || body.StatusCode === 0), body };
  } catch (e) {
    console.error('Проверка кассы платёжным запросом не удалась:', e.message);
    return { ok: false, body: null };
  }
}

// ═══════════════════════════════════════════════════
//  Finish logic (shared by verify-otp and /finish)
// ═══════════════════════════════════════════════════

async function doFinish(session, cashierPin) {
  // Устройство этой привязки (создано на /init); legacyDevice — запасной.
  const device = session.device || legacyDevice();
  // Ключ ECDH держим в сессии и сохраняем вместе с кассой (для SignInLite).
  const ecdh = generateECDHPair();
  session.ecdhPrivateKey = ecdh.privateKey;
  const ecdhX509 = ecdh.publicB64;

  const signedDataObj = {
    installId: device.installId,
    time: nowISO(),
    auth: [{ value: cashierPin, type: 'pincode' }],
    userIdHash: '',
  };
  const signedDataB64 = Buffer.from(JSON.stringify(signedDataObj)).toString('base64');

  const finishUrl = `${KASPI_ENTRANCE_URL}/api/v1/kpentrance/finish`;
  const finishHeaders = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Language': 'ru',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': UA_NATIVE,
    'X-Time': nowISO(),
    'X-Call': 'notConnected',
    'X-Platform-Type': APP.platform,
    'X-PkTag': device.pkTag,
    'X-SU': computeXSU(finishUrl),
    'X-Net-Type': 'WIFI/ETHERNET',
    'X-Emulator': '0',
    'X-Locale': APP.locale,
    'X-SV': '2',
    'X-Request-ID': generateUUID(),
    'X-Time-Zone': 'GMT+05:00',
    'X-SH': 'url,X-Time-Zone,X-Request-ID,X-Net-Type,X-Emulator,X-Call,X-Platform-Type,X-Locale,X-Time,X-SV',
  };
  finishHeaders['X-Sign'] = computeXSign(finishUrl, finishHeaders, finishHeaders['X-SH'], undefined, device.privateKey);

  const resp = await loggedFetch(finishUrl, {
    method: 'POST',
    headers: finishHeaders,
    body: JSON.stringify({
      signed: { sign: signDataPayload(signedDataB64, device.privateKey), data: signedDataB64 },
      guard: { pinHash: device.pinHash, x509: ecdhX509 },
      processId: session.processId,
    }),
    redactBody: true,
  });

  const body = await resp.json();

  if (body.success && body.data?.tokenSN) {
    session.tokenSN = body.data.tokenSN;

    let vtokenSecret = null;
    let rawSecret = null;
    if (body.data.x509) {
      try {
        rawSecret = completeECDHWith(body.data.x509, ecdh.privateKey);
        vtokenSecret = encryptSecret(rawSecret);
        // Нужен для подписи платёжного заголовка при проверке кассы ниже.
        session.decryptedSecret = rawSecret;
        console.log('vtoken activated successfully');
      } catch (e) {
        console.error('ECDH key agreement failed:', e.message);
      }
    }

    // Fetch org context
    const orgUrl = `${KASPI_MTOKEN_URL}/v08/organizations/org-context-otp`;

    // Заголовки строятся на каждую попытку заново: X-Time, X-Request-ID и
    // подпись над ними одноразовые, переиспользовать их у Kaspi нельзя.
    const requestOrgContext = async () => {
      const piValue = session.profileId != null ? String(session.profileId) : '';
      const orgHeaders = {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'Accept-Language': 'ru',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': UA_NATIVE,
        'X-Kb-TokenSn': session.tokenSN,
        'X-Kb-TokenSnMac': computeTokenSnMac(session.tokenSN, rawSecret),
        'X-Install-ID': device.installId,
        'X-App-Ver': APP.version,
        'X-App-Bld': APP.build,
        'X-Locale': APP.locale,
        'X-Call': 'notConnected',
        'X-Time': nowISO(),
        'X-S': 'R:0|E:0|RH:0|N:0',
        'X-SV': '2',
        'X-Kb-Client-Ip': '192.168.1.96',
        'X-PkTag': device.pkTag,
        'X-SU': computeXSU(orgUrl),
        'X-SH': piValue
          ? 'url,X-Kb-Client-Ip,X-App-Bld,X-S,X-Kb-TokenSn,X-Time,X-App-Ver,X-Kb-TokenSnMac,X-Call,X-PI,X-Install-ID,X-Locale,X-SV'
          : 'url,X-Kb-Client-Ip,X-Time,X-App-Ver,X-SV,X-Locale,X-App-Bld,X-Install-ID,X-Kb-TokenSn,X-S,X-Kb-TokenSnMac,X-Call',
        'X-Request-ID': generateUUID(),
      };
      if (piValue) orgHeaders['X-PI'] = piValue;
      orgHeaders['X-Sign'] = computeXSign(orgUrl, orgHeaders, orgHeaders['X-SH'], undefined, device.privateKey);

      const orgResp = await loggedFetch(orgUrl, {
        method: 'POST',
        headers: orgHeaders,
        body: JSON.stringify({
          DeviceInformation: {
            SdkVersion: 'AOTP service',
            DeviceId: device.deviceId,
            ApplicationId: 'kz.kaspi.business',
            ScreenWidth: APP.screenW,
            Model: APP.model,
            ScreenHeight: APP.screenH,
            DeviceName: APP.deviceName,
            VersionName: APP.version,
            BuildRelease: `${APP.platform} ${APP.platformVer}`,
            Brand: APP.brand,
            Board: APP.platformVer,
            Platform: APP.platform,
            Product: 'Kaspi Pay',
            frontCameraAvailable: true,
            VersionCode: APP.build,
            InstallId: device.installId,
          },
          OrganizationId: 0,
        }),
      });

      try {
        return await orgResp.json();
      } catch (e) {
        console.error('org-context-otp: ответ не разобран:', e.message);
        return null;
      }
    };

    // Контекст организации формально необязателен — tokenSN и vtokenSecret выше
    // уже получены, касса привязана, и раньше незащищённый .json() ронял этим
    // всю успешную привязку («invalid json response body … at position 562»).
    // Но из ответа берётся ProfileId, который потом уходит в подпись счетов
    // заголовком X-PI, поэтому сдаваться с первой попытки нельзя: Kaspi отдаёт
    // битое тело нерегулярно, и повтор обычно приходит нормальным.
    let orgBody = null;
    for (let attempt = 1; attempt <= ORG_CONTEXT_ATTEMPTS; attempt++) {
      orgBody = await requestOrgContext();
      if (orgBody?.Data?.Current?.ProfileId) break;
      if (attempt < ORG_CONTEXT_ATTEMPTS) {
        console.warn(`org-context-otp: попытка ${attempt} без ProfileId, повторяем`);
        await sleep(700);
      }
    }

    if (orgBody?.Data?.Current?.ProfileId) {
      applyOrgContext(session, orgBody.Data);
    } else if ((await cashierSessionWorks(session)).ok) {
      // ProfileId не пришёл, но касса отвечает по платёжному пути — привязка
      // настоящая. X-PI уйдёт пустым, пока SignInLite не подберёт ProfileId
      // позже (createWithSessionRetry пишет его в keys при первом же платеже).
      console.warn(
        'org-context не отдал ProfileId, но касса отвечает на платёжный запрос — принимаем привязку',
      );
    } else {
      // tokenSN сам по себе ещё не доказывает, что касса привязана: finish
      // отвечает success даже когда прав у номера нет. Не сохраняем такую
      // ложную «привязку» — и различаем две разные причины, потому что чинятся
      // они по-разному.
      // `-101001` у Kaspi — дежурный текст «Token not valid», он приходит и
      // когда сессию перехватило другое устройство, и когда прав у номера нет
      // вовсе. Точнее различают роли из самого finish: если Kaspi выдала токен
      // с пустыми roles/perms, отбирать было нечего — номер просто не кассир
      // (в логах такие входы идут как `clientType: "customer"`). Конфликт
      // устройств засчитываем только когда права БЫЛИ, а контекст всё равно
      // отвергли.
      const grantedRoles = Array.isArray(body.roles) ? body.roles : [];
      const takenOver = grantedRoles.length > 0 && isKaspiReauthRequired(orgBody);
      console.warn(
        `Kaspi отклонил контекст организации: StatusCode=${orgBody?.StatusCode ?? 'n/a'}, ` +
          `roles=${JSON.stringify(body.roles ?? [])}, perms=${JSON.stringify(body.perms ?? [])}, ` +
          `showSaleScreen=${body.data?.showSaleScreen}`,
      );
      const error = new Error(
        orgBody?.Message || 'Kaspi did not return an active cashier organization context',
      );
      error.code = takenOver
        ? 'KASPI_DEVICE_SESSION_CONFLICT'
        : 'KASPI_CASHIER_REGISTRATION_REQUIRED';
      throw error;
    }

    return {
      tokenSN: session.tokenSN,
      device,
      ecdhPrivateKey: ecdh.privateKey,
      vtokenSecret,
      profileId: session.profileId,
      organizationId: session.organizationId,
      orgName: session.orgName,
      phone: session.phoneNumber,
      organizations: orgBody?.Data?.Organizations,
    };
  } else {
    // Тело finish содержит выпущенные секреты, наружу его отдавать нельзя —
    // логируем на сервере, а вызывающему возвращаем причину словами Kaspi.
    console.error('Finish failed:', JSON.stringify(body));
    const kaspiMessage =
      body.error?.label || body.error?.desc || body.Message || body.message || null;
    const error = new Error(kaspiMessage || 'Kaspi отклонил завершение привязки кассы');
    // Пустой PIN шлём только когда Kaspi его не запрашивал, значит отказ на
    // непустом коде — это именно отклонённый код быстрого доступа.
    if (cashierPin) error.code = 'KASPI_PIN_REJECTED';
    throw error;
  }
}

// ═══════════════════════════════════════════════════
//  Refresh — SignInLite (new tokenSN + vtokenSecret)
//  POST /v03/auth/sign-in-lite
// ═══════════════════════════════════════════════════

router.post('/refresh', async (req, res) => {
  let tokenSN = req.body?.tokenSN;
  let vtokenSecret = req.body?.vtokenSecret;
  let organizationId = req.body?.organizationId;
  const apiKey = req.headers['x-api-key'];
  // Обновлять сессию надо ТЕМ ЖЕ устройством, которым касса привязана: у Kaspi
  // токен и устройство связаны. Для касс, привязанных до перехода, вернётся
  // старое общее устройство.
  let device = DEVICE;
  let savedEcdh = null;

  if (apiKey) {
    try {
      const { query } = await import('../db.js');
      const dbResult = await query('SELECT * FROM keys WHERE api_key = $1', [apiKey]);
      if (dbResult.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid API Key.' });
      }
      const dbKeyRow = dbResult.rows[0];
      if (dbKeyRow.status !== 'active') {
        return res.status(403).json({ error: 'This API Key has been suspended or is inactive.' });
      }
      tokenSN = dbKeyRow.kaspi_token_sn;
      vtokenSecret = dbKeyRow.kaspi_vtoken_secret;
      device = deviceFromRow(dbKeyRow);
      savedEcdh = dbKeyRow.ecdh_privkey || null;

      if (!tokenSN || !vtokenSecret) {
        return res.status(400).json({ error: 'Kaspi cashier account is not connected yet for this API Key.' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Database connection error: ' + err.message });
    }
  }

  if (!tokenSN) return res.status(400).json({ error: 'tokenSN required' });
  if (!vtokenSecret) return res.status(400).json({ error: 'vtokenSecret required' });

  try {
    const rawSecret = decryptSecret(vtokenSecret);

    const liteUrl = `${KASPI_MTOKEN_URL}/v03/auth/sign-in-lite`;
    const liteHeaders = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'Accept-Language': 'ru',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': UA_NATIVE,
      'X-Kb-TokenSn': tokenSN,
      'X-Kb-TokenSnMac': computeTokenSnMac(tokenSN, rawSecret),
      'X-Install-ID': device.installId,
      'X-App-Ver': APP.version,
      'X-App-Bld': APP.build,
      'X-Locale': APP.locale,
      'X-Call': 'notConnected',
      'X-Time': nowISO(),
      'X-S': 'R:0|E:0|RH:0|N:0',
      'X-SV': '2',
      'X-Kb-Client-Ip': '192.168.1.96',
      'X-PkTag': device.pkTag,
      'X-SU': computeXSU(liteUrl),
      'X-SH':
        'url,X-Kb-Client-Ip,X-Time,X-App-Ver,X-SV,X-Locale,X-App-Bld,X-Install-ID,X-Kb-TokenSn,X-S,X-Kb-TokenSnMac,X-Call',
      'X-Request-ID': generateUUID(),
    };
    liteHeaders['X-Sign'] = computeXSign(liteUrl, liteHeaders, liteHeaders['X-SH'], undefined, device.privateKey);

    const resp = await loggedFetch(liteUrl, {
      method: 'POST',
      headers: liteHeaders,
      body: JSON.stringify({
        OrganizationId: organizationId || 0,
        DeviceInformation: {
          SdkVersion: 'AOTP service',
          DeviceId: device.deviceId,
          ApplicationId: 'kz.kaspi.business',
          ScreenWidth: APP.screenW,
          Model: APP.model,
          ScreenHeight: APP.screenH,
          DeviceName: APP.deviceName,
          VersionName: APP.version,
          BuildRelease: `${APP.platform} ${APP.platformVer}`,
          Brand: APP.brand,
          Board: APP.platformVer,
          Platform: APP.platform,
          Product: 'Kaspi Pay',
          frontCameraAvailable: true,
          VersionCode: APP.build,
          InstallId: device.installId,
        },
      }),
    });

    const body = await resp.json();

    if (body.StatusCode === 0 && body.Data) {
      const newTokenSN = body.Data.TokenSn || body.Data.tokenSN || tokenSN;
      let newVtokenSecret = vtokenSecret;
      let newRawSecret = null;
      const serverX509 = body.Data.X509 || body.Data.x509;

      if (serverX509) {
        try {
          newRawSecret = savedEcdh
            ? completeECDHWith(serverX509, importECDHPrivate(savedEcdh))
            : completeECDHWithSaved(serverX509);
          newVtokenSecret = encryptSecret(newRawSecret);
          console.log('SignInLite: new vtoken activated successfully');
        } catch (e) {
          console.error('SignInLite ECDH failed:', e.message);
        }
      }

      const activeRawSecret = newRawSecret || decryptSecret(newVtokenSecret);

      // ── Step 2: org-context-otp to load organization context ──
      const session = createEmptySession();
      session.tokenSN = newTokenSN;
      let orgContextOk = false;

      // Pre-fill from SignInLite response if available
      if (body.Data.OrganizationContext || body.Data.OrganizationContextLite) {
        applyOrgContext(session, body.Data.OrganizationContext || body.Data.OrganizationContextLite);
      }

      try {
        const orgUrl = `${KASPI_MTOKEN_URL}/v08/organizations/org-context-otp`;
        const orgHeaders = {
          'Content-Type': 'application/json',
          Accept: '*/*',
          'Accept-Language': 'ru',
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': UA_NATIVE,
          'X-Kb-TokenSn': newTokenSN,
          'X-Kb-TokenSnMac': computeTokenSnMac(newTokenSN, activeRawSecret),
          'X-Install-ID': device.installId,
          'X-App-Ver': APP.version,
          'X-App-Bld': APP.build,
          'X-Locale': APP.locale,
          'X-Call': 'notConnected',
          'X-Time': nowISO(),
          'X-S': 'R:0|E:0|RH:0|N:0',
          'X-SV': '2',
          'X-Kb-Client-Ip': '192.168.1.96',
          'X-PkTag': device.pkTag,
          'X-PI': session.profileId || '',
          'X-SU': computeXSU(orgUrl),
          'X-SH':
            'url,X-Kb-Client-Ip,X-Time,X-App-Ver,X-SV,X-Locale,X-App-Bld,X-Install-ID,X-Kb-TokenSn,X-S,X-Kb-TokenSnMac,X-Call',
          'X-Request-ID': generateUUID(),
        };
        orgHeaders['X-Sign'] = computeXSign(orgUrl, orgHeaders, orgHeaders['X-SH']);

        const orgResp = await loggedFetch(orgUrl, {
          method: 'POST',
          headers: orgHeaders,
          body: JSON.stringify({
            OrganizationId: organizationId || session.organizationId || 0,
            DeviceInformation: {
              SdkVersion: 'AOTP service',
              DeviceId: device.deviceId,
              ApplicationId: 'kz.kaspi.business',
              ScreenWidth: APP.screenW,
              Model: APP.model,
              ScreenHeight: APP.screenH,
              DeviceName: APP.deviceName,
              VersionName: APP.version,
              BuildRelease: `${APP.platform} ${APP.platformVer}`,
              Brand: APP.brand,
              Board: APP.platformVer,
              Platform: APP.platform,
              Product: 'Kaspi Pay',
              frontCameraAvailable: true,
              VersionCode: APP.build,
              InstallId: device.installId,
            },
          }),
        });

        const orgBody = await orgResp.json();
        if (orgBody.StatusCode === 0 && orgBody.Data) {
          applyOrgContext(session, orgBody.Data);
          orgContextOk = true;
          console.log('Refresh org-context-otp: OK, profileId:', session.profileId, 'orgId:', session.organizationId);
        } else {
          console.log('Refresh org-context-otp: failed (', orgBody.StatusCode, ')');
        }
      } catch (e) {
        console.error('Refresh org-context-otp error:', e.message);
      }

      if (apiKey) {
        try {
          const { query } = await import('../db.js');
          await query(
            `UPDATE keys
             SET kaspi_token_sn = $1, kaspi_vtoken_secret = $2
             WHERE api_key = $3`,
            [newTokenSN, newVtokenSecret, apiKey],
          );
        } catch (err) {
          console.error('Failed to update refreshed session in database:', err.message);
        }
      }

      res.json({
        success: true,
        tokenSN: newTokenSN,
        vtokenSecret: newVtokenSecret,
        profileId: session.profileId,
        organizationId: session.organizationId,
        orgName: session.orgName,
        sessionId: body.Data.SessionId,
        organizations: body.Data.OrganizationContext?.Organizations || body.Data.OrganizationContextLite?.Organizations,
        orgContext: orgContextOk,
        message: apiKey
          ? 'Session refreshed via SignInLite + org-context and saved in database.'
          : 'Session refreshed via SignInLite + org-context',
      });
    } else {
      res.json({
        success: false,
        statusCode: body.StatusCode,
        message:
          body.Message || body.Description || 'SignInLite failed — token may be expired, re-auth via SMS required',
        body,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Session status (client sends tokenSN) ───

router.post('/session', (req, res) => {
  const { tokenSN } = req.body || {};
  res.json({ authenticated: !!tokenSN, tokenSN });
});

// ─── Logout ───

router.post('/logout', (req, res) => {
  res.json({ success: true });
});

export default router;
