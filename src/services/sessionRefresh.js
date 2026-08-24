import { DEVICE, APP, UA_NATIVE, KASPI_MTOKEN_URL } from '../config.js';
import { createEmptySession, applyOrgContext } from '../session.js';
import {
  completeECDHWith,
  completeECDHWithSaved,
  importECDHPrivate,
  computeTokenSnMac,
  computeXSU,
  computeXSign,
  encryptSecret,
  decryptSecret,
} from '../crypto.js';
import { loggedFetch, generateUUID, nowISO } from '../helpers.js';
import { query } from '../db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Kaspi привязывает сессию кассы к ОДНОМУ устройству. Когда касса логинится
// где-то ещё (кассир открыл свой Kaspi с телефона), Kaspi ротирует tokenSN и
// сессия шлюза протухает — при создании счёта/QR приходит «Был выполнен вход с
// другого устройства», операция не создаётся, оплата зависает.
//
// SignInLite по сохранённому vtoken выдаёт свежий tokenSN, снова привязанный к
// устройству шлюза, БЕЗ SMS (пока жив vtoken). Этот модуль переиспользует ту же
// механику, что и /auth/refresh, но как сервис — чтобы создание счёта/QR могло
// само восстановить сессию и повторить запрос один раз.
//
// ВНИМАНИЕ: логика SignInLite здесь намеренно дублирует обработчик
// routes/auth.js `/refresh` (проверенный онбордингом путь трогать не стали).
// Если правите здесь — синхронизируйте и там.
// ─────────────────────────────────────────────────────────────────────────────

// Выполняет SignInLite (+ org-context) и возвращает свежие креды сессии.
// { ok:true, tokenSN, vtokenSecret, decryptedSecret, profileId, organizationId, orgName, data }
// либо { ok:false, statusCode, message, body }.
export const signInLiteRefresh = async ({ tokenSN, vtokenSecret, organizationId, device = DEVICE, ecdhPrivkey = null }) => {
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

  const deviceInformation = {
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
  };

  const resp = await loggedFetch(liteUrl, {
    method: 'POST',
    headers: liteHeaders,
    body: JSON.stringify({ OrganizationId: organizationId || 0, DeviceInformation: deviceInformation }),
  });

  const body = await resp.json();

  if (!(body.StatusCode === 0 && body.Data)) {
    return {
      ok: false,
      statusCode: body.StatusCode,
      message: body.Message || body.Description || 'SignInLite failed — token may be expired, re-auth via SMS required',
      body,
    };
  }

  const newTokenSN = body.Data.TokenSn || body.Data.tokenSN || tokenSN;
  let newVtokenSecret = vtokenSecret;
  let newRawSecret = null;
  const serverX509 = body.Data.X509 || body.Data.x509;

  if (serverX509) {
    try {
      newRawSecret = ecdhPrivkey
        ? completeECDHWith(serverX509, importECDHPrivate(ecdhPrivkey))
        : completeECDHWithSaved(serverX509);
      newVtokenSecret = encryptSecret(newRawSecret);
    } catch (e) {
      console.error('[session-refresh] SignInLite ECDH failed:', e.message);
    }
  }

  const activeRawSecret = newRawSecret || decryptSecret(newVtokenSecret);

  // ── org-context-otp: подгружаем контекст организации (profileId и т.д.) ──
  const session = createEmptySession();
  session.tokenSN = newTokenSN;
  let orgContextOk = false;

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
    orgHeaders['X-Sign'] = computeXSign(orgUrl, orgHeaders, orgHeaders['X-SH'], undefined, device.privateKey);

    const orgResp = await loggedFetch(orgUrl, {
      method: 'POST',
      headers: orgHeaders,
      body: JSON.stringify({
        OrganizationId: organizationId || session.organizationId || 0,
        DeviceInformation: deviceInformation,
      }),
    });

    const orgBody = await orgResp.json();
    if (orgBody.StatusCode === 0 && orgBody.Data) {
      applyOrgContext(session, orgBody.Data);
      orgContextOk = true;
    }
  } catch (e) {
    console.error('[session-refresh] org-context error:', e.message);
  }

  return {
    ok: true,
    tokenSN: newTokenSN,
    vtokenSecret: newVtokenSecret,
    decryptedSecret: activeRawSecret,
    profileId: session.profileId,
    organizationId: session.organizationId,
    orgName: session.orgName,
    orgContextOk,
    data: body.Data,
  };
};

// Достаёт id операции из ответа Kaspi (invoice → Id/QrOperationId, qr → QrOperationId).
const operationIdOf = (body) => {
  const d = body && body.Data;
  if (!d) return null;
  return d.QrOperationId ?? d.Id ?? null;
};

export const KASPI_REAUTH_REQUIRED = 'KASPI_REAUTH_REQUIRED';

// Kaspi invalidates a cashier session when the same cashier signs in on
// another device or when Kaspi rotates the required app/auth version. Keep
// this classification in the gateway so every consumer gets one stable,
// machine-readable error instead of depending on Kaspi's changing wording.
export const isKaspiReauthRequired = (body) => {
  const statusCode = Number(body?.StatusCode);
  if (statusCode === -101001 || statusCode === -209) return true;

  const message = String(body?.Message || body?.Description || '');
  return /вход с другого устройства|введите логин|обновите приложение.*войти/i.test(message);
};

export const reauthRequiredResponse = (sourceBody = {}) => ({
  StatusCode: sourceBody.StatusCode ?? -101001,
  Message: 'Сессия кассы Kaspi завершена. Переподключите кассу по SMS и PIN в профиле.',
  ErrorCode: KASPI_REAUTH_REQUIRED,
  RequiresReauth: true,
});

// Оборачивает создание счёта/QR одним авто-ретраем с переลогином сессии.
// doCreate(session) должен выполнить запрос к Kaspi и вернуть распарсенный JSON.
// Если первая попытка не вернула id операции — делаем SignInLite, сохраняем
// свежие креды в БД, обновляем req.session и повторяем ровно один раз.
export const createWithSessionRetry = async (req, doCreate) => {
  const firstBody = await doCreate(req.session);
  if (operationIdOf(firstBody) != null) return firstBody;
  // Business/validation failures cannot be repaired by rotating the cashier
  // token. Refresh only a session that Kaspi explicitly says is no longer
  // valid; otherwise preserve the original response without extra auth calls.
  if (!isKaspiReauthRequired(firstBody)) return firstBody;

  console.log('[session-retry] no operationId on first attempt — trying SignInLite refresh');

  let refreshed;
  try {
    refreshed = await signInLiteRefresh({
      tokenSN: req.session.tokenSN,
      vtokenSecret: req.headers['x-vtoken-secret'],
      organizationId: req.session.organizationId,
      // То же устройство, которым касса привязана: apiKeyAuth положил его в
      // сессию. Обновление чужим устройством выбило бы кассу вместо починки.
      device: req.session.device,
      ecdhPrivkey: req.session.ecdhPrivkey,
    });
  } catch (e) {
    console.error('[session-retry] SignInLite threw:', e.message);
    return isKaspiReauthRequired(firstBody) ? reauthRequiredResponse(firstBody) : firstBody;
  }

  if (!refreshed.ok) {
    // vtoken мёртв → нужен полный вход по SMS. Отдаём исходную ошибку Kaspi,
    // чтобы наверху показать реальную причину.
    console.log('[session-retry] SignInLite failed — cashier needs SMS re-auth:', refreshed.message);
    return isKaspiReauthRequired(firstBody) || isKaspiReauthRequired(refreshed.body)
      ? reauthRequiredResponse(firstBody)
      : firstBody;
  }

  // Сохраняем свежие креды, чтобы следующие запросы этой кассы были валидны.
  // profile_id пишем, только если он у нас есть и в базе ещё пусто: касса,
  // привязанная без контекста организации, подписывает счета пустым X-PI —
  // здесь мы этот пробел закрываем, а уже заполненное значение не трогаем.
  if (req.keyId) {
    try {
      await query(
        `UPDATE keys
         SET kaspi_token_sn = $1,
             kaspi_vtoken_secret = $2,
             profile_id = COALESCE(NULLIF(profile_id, ''), $3)
         WHERE id = $4`,
        [
          refreshed.tokenSN,
          refreshed.vtokenSecret,
          refreshed.profileId != null ? String(refreshed.profileId) : null,
          req.keyId,
        ],
      );
    } catch (e) {
      console.error('[session-retry] failed to persist refreshed creds:', e.message);
    }
  }

  // Обновляем сессию текущего запроса (подпись + tracking должны идти на свежих кредах).
  req.session.tokenSN = refreshed.tokenSN;
  req.session.decryptedSecret = refreshed.decryptedSecret;
  req.headers['x-vtoken-secret'] = refreshed.vtokenSecret;
  if (refreshed.profileId != null) req.session.profileId = refreshed.profileId;
  if (refreshed.organizationId != null) req.session.organizationId = refreshed.organizationId;

  const retryBody = await doCreate(req.session);
  console.log(
    '[session-retry] retry after refresh',
    operationIdOf(retryBody) != null ? 'succeeded' : 'still failed',
  );
  return isKaspiReauthRequired(retryBody) ? reauthRequiredResponse(retryBody) : retryBody;
};
