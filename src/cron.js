import cron from 'node-cron';
import { query } from './db.js';
import {
  completeECDHWith,
  completeECDHWithSaved,
  importECDHPrivate,
  computeTokenSnMac,
  computeXSU,
  computeXSign,
  decryptSecret,
  encryptSecret,
} from './crypto.js';
import { loggedFetch, generateUUID, nowISO } from './helpers.js';
import { APP, UA_NATIVE, KASPI_MTOKEN_URL } from './config.js';
import { deviceFromRow, hasOwnDevice } from './deviceIdentity.js';
import { logger } from './logger.js';

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 5000; // 5 seconds between batches

// Обновляем только кассы со своей device-identity (см. runNightlyRefresh).
export const selectRefreshableKeys = (rows) => rows.filter(hasOwnDevice);

/**
 * Performs a SignInLite refresh for a single key row.
 * Returns true on success, false on failure.
 */
const refreshKey = async (keyRow) => {
  try {
    const rawSecret = decryptSecret(keyRow.kaspi_vtoken_secret);
    // Каждую кассу обновляем её собственным устройством.
    const device = deviceFromRow(keyRow);

    const liteUrl = `${KASPI_MTOKEN_URL}/v03/auth/sign-in-lite`;
    const liteHeaders = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'Accept-Language': 'ru',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': UA_NATIVE,
      'X-Kb-TokenSn': keyRow.kaspi_token_sn,
      'X-Kb-TokenSnMac': computeTokenSnMac(keyRow.kaspi_token_sn, rawSecret),
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
        OrganizationId: 0,
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
      const newTokenSN = body.Data.TokenSn || body.Data.tokenSN || keyRow.kaspi_token_sn;
      let newVtokenSecret = keyRow.kaspi_vtoken_secret;

      const serverX509 = body.Data.X509 || body.Data.x509;
      if (serverX509) {
        try {
          const newRawSecret = keyRow.ecdh_privkey
            ? completeECDHWith(serverX509, importECDHPrivate(keyRow.ecdh_privkey))
            : completeECDHWithSaved(serverX509);
          newVtokenSecret = encryptSecret(newRawSecret);
        } catch (e) {
          logger.error('CRON', `ECDH failed for key ${keyRow.id}:`, e.message);
        }
      }

      await query(
        `UPDATE keys SET kaspi_token_sn = $1, kaspi_vtoken_secret = $2 WHERE id = $3`,
        [newTokenSN, newVtokenSecret, keyRow.id],
      );

      logger.info('CRON', `✅ Key ${keyRow.id} (${keyRow.theater_name}) refreshed.`);
      return true;
    } else {
      logger.warn(
        'CRON',
        `⚠️  Key ${keyRow.id} (${keyRow.theater_name}) SignInLite failed — StatusCode: ${body.StatusCode}. Re-auth via SMS required.`,
      );
      return false;
    }
  } catch (err) {
    logger.error('CRON', `❌ Key ${keyRow.id} (${keyRow.theater_name}) error:`, err.message);
    return false;
  }
};

/**
 * Refreshes all active, connected keys in batches.
 */
const runNightlyRefresh = async () => {
  logger.info('CRON', '🌙 Nightly session refresh started...');

  let activeKeys;
  try {
    const result = await query(
      `SELECT id, theater_name, kaspi_token_sn, kaspi_vtoken_secret,
              device_id, install_id, device_pin_hash, device_privkey, ecdh_privkey
       FROM keys
       WHERE status = 'active'
         AND kaspi_token_sn IS NOT NULL
         AND kaspi_vtoken_secret IS NOT NULL`,
    );
    activeKeys = result.rows;
  } catch (err) {
    logger.error('CRON', '❌ Failed to fetch keys from DB:', err.message);
    return;
  }

  if (activeKeys.length === 0) {
    logger.info('CRON', 'No active connected keys found. Skipping.');
    return;
  }

  // Кассы без своего устройства пропускаем: обновление с общего устройства
  // выбивает чужие активные сессии (одна сессия на устройство у Kaspi).
  const refreshable = selectRefreshableKeys(activeKeys);
  const skipped = activeKeys.length - refreshable.length;
  if (skipped > 0) {
    logger.warn(
      'CRON',
      `⏭  Пропущено ${skipped} касс(ы) на общем устройстве — обновление выбило бы чужие сессии. Нужна перепривязка.`,
    );
  }
  if (refreshable.length === 0) {
    logger.info('CRON', 'Ни одной кассы со своим устройством — обновлять нечего.');
    return;
  }

  logger.info('CRON', `Found ${refreshable.length} refreshable key(s). Processing in batches of ${BATCH_SIZE}...`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < refreshable.length; i += BATCH_SIZE) {
    const batch = refreshable.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(refreshKey));
    success += results.filter(Boolean).length;
    failed += results.filter((r) => !r).length;

    // Wait between batches to avoid rate limiting (skip delay after last batch)
    if (i + BATCH_SIZE < refreshable.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  logger.info('CRON', `✅ Nightly refresh complete. Success: ${success}, Failed: ${failed}`);
};

/**
 * Checks for API keys that are expiring soon and logs warnings.
 * Warns at: 7 days, 3 days, and 1 day before expiration.
 * Also logs keys that expired within the last 24 hours (just expired).
 */
const checkExpiringKeys = async () => {
  logger.info('CRON', '🔔 Checking for expiring API keys...');

  try {
    const result = await query(
      `SELECT id, theater_name, api_key, expires_at
       FROM keys
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at > NOW() - INTERVAL '1 day'
         AND expires_at < NOW() + INTERVAL '8 days'
       ORDER BY expires_at ASC`,
    );

    if (result.rows.length === 0) {
      logger.info('CRON', '✅ No keys expiring soon.');
      return;
    }

    const now = new Date();

    for (const row of result.rows) {
      const expiresAt = new Date(row.expires_at);
      const diffMs = expiresAt - now;
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      const dateStr = expiresAt.toISOString().slice(0, 10);

      if (diffMs < 0) {
        // Expired within last 24 hours
        logger.error(
          'CRON',
          `🔴 EXPIRED: Key ${row.id} (${row.theater_name}) expired on ${dateStr}. All requests are now blocked!`,
        );
      } else if (diffDays <= 1) {
        logger.error(
          'CRON',
          `🔴 TOMORROW: Key ${row.id} (${row.theater_name}) expires TOMORROW (${dateStr}). Renew immediately!`,
        );
      } else if (diffDays <= 3) {
        logger.warn(
          'CRON',
          `🟠 3 DAYS: Key ${row.id} (${row.theater_name}) expires in ${diffDays} days (${dateStr}).`,
        );
      } else {
        logger.warn(
          'CRON',
          `🟡 7 DAYS: Key ${row.id} (${row.theater_name}) expires in ${diffDays} days (${dateStr}).`,
        );
      }
    }

    logger.info('CRON', `🔔 Expiry check done. ${result.rows.length} key(s) need attention.`);
  } catch (err) {
    logger.error('CRON', '❌ Expiry check failed:', err.message);
  }
};

/**
 * Aggregates yesterday's order stats per key into the daily_stats table.
 * Uses INSERT ... ON CONFLICT to upsert — safe to re-run.
 */
const aggregateDailyStats = async () => {
  logger.info('CRON', '📊 Aggregating daily stats for yesterday...');

  try {
    // Aggregate yesterday's orders grouped by key_id
    const result = await query(`
      INSERT INTO daily_stats (
        key_id, stat_date,
        total_count, total_amount,
        paid_count, paid_amount,
        cancelled_count, cancelled_amount,
        refunded_count, refunded_amount,
        error_count,
        aggregated_at
      )
      SELECT
        key_id,
        (CURRENT_DATE - INTERVAL '1 day')::DATE AS stat_date,

        COUNT(*)::INTEGER AS total_count,
        COALESCE(SUM(amount), 0) AS total_amount,

        COUNT(CASE WHEN status IN ('Processed', 'success') THEN 1 END)::INTEGER AS paid_count,
        COALESCE(SUM(CASE WHEN status IN ('Processed', 'success') THEN amount END), 0) AS paid_amount,

        COUNT(CASE WHEN status IN ('RemotePaymentCanceled', 'CancelledByUser', 'CancelledByExternalSource', 'Cancelled') THEN 1 END)::INTEGER AS cancelled_count,
        COALESCE(SUM(CASE WHEN status IN ('RemotePaymentCanceled', 'CancelledByUser', 'CancelledByExternalSource', 'Cancelled') THEN amount END), 0) AS cancelled_amount,

        COUNT(CASE WHEN status = 'Refunded' THEN 1 END)::INTEGER AS refunded_count,
        COALESCE(SUM(CASE WHEN status = 'Refunded' THEN amount END), 0) AS refunded_amount,

        COUNT(CASE WHEN status IN ('Error', 'Failed', 'ProcessingFailed', 'Rejected', 'InsufficientFunds', 'SessionExpired') THEN 1 END)::INTEGER AS error_count,

        NOW() AS aggregated_at
      FROM orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
        AND created_at <  CURRENT_DATE
      GROUP BY key_id
      ON CONFLICT (key_id, stat_date)
      DO UPDATE SET
        total_count      = EXCLUDED.total_count,
        total_amount     = EXCLUDED.total_amount,
        paid_count       = EXCLUDED.paid_count,
        paid_amount      = EXCLUDED.paid_amount,
        cancelled_count  = EXCLUDED.cancelled_count,
        cancelled_amount = EXCLUDED.cancelled_amount,
        refunded_count   = EXCLUDED.refunded_count,
        refunded_amount  = EXCLUDED.refunded_amount,
        error_count      = EXCLUDED.error_count,
        aggregated_at    = NOW()
    `);

    const rows = result.rowCount ?? 0;
    logger.info('CRON', `📊 Daily stats aggregated. ${rows} key(s) processed.`);
  } catch (err) {
    logger.error('CRON', '❌ Daily stats aggregation failed:', err.message);
  }
};

/**
 * Starts all cron jobs:
 * - 01:00 AM: Daily stats aggregation for yesterday's orders
 * - 03:00 AM: Nightly Kaspi session refresh for all active keys
 * - 09:00 AM: Daily expiry warning check for API keys
 */
export const startCron = () => {
  cron.schedule('0 1 * * *', aggregateDailyStats, {
    timezone: 'Asia/Almaty',
  });
  logger.info('CRON', '📊 Daily stats aggregation cron scheduled at 01:00 AM (Asia/Almaty).');

  cron.schedule('0 3 * * *', runNightlyRefresh, {
    timezone: 'Asia/Almaty',
  });
  logger.info('CRON', '🕐 Nightly session refresh cron scheduled at 03:00 AM (Asia/Almaty).');

  cron.schedule('0 9 * * *', checkExpiringKeys, {
    timezone: 'Asia/Almaty',
  });
  logger.info('CRON', '🔔 Expiry warning cron scheduled at 09:00 AM (Asia/Almaty).');
};

