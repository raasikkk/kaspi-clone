import { query } from '../db.js';
import { deviceFromRow } from '../deviceIdentity.js';

/**
 * Express middleware to authenticate requests using an X-API-Key.
 * Verifies key status, enforces permission gating, and injects Kaspi credentials
 * into headers so that existing payment handlers run unmodified.
 */
const apiKeyAuth = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header.' });
  }

  try {
    // 1. Fetch Key record from PostgreSQL
    const result = await query(
      `SELECT id, theater_name, api_key, status, expires_at,
              allow_invoice, allow_qr, allow_refund,
              kaspi_token_sn, kaspi_vtoken_secret, profile_id,
              device_id, install_id, device_pin_hash, device_privkey, ecdh_privkey
       FROM keys WHERE api_key = $1`,
      [apiKey],
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API Key.' });
    }

    const keyRow = result.rows[0];

    // 2. Verify active subscription/status
    if (keyRow.status !== 'active') {
      return res.status(403).json({ error: 'This API Key has been suspended or is inactive.' });
    }

    // 2.1 Verify expiration
    if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
      return res.status(403).json({ error: 'This API Key has expired.' });
    }

    // 3. Enforce permission checks based on endpoint paths
    const fullPath = req.baseUrl + req.path;

    if (fullPath.startsWith('/api/invoice') && !keyRow.allow_invoice) {
      return res.status(403).json({ error: 'Remote invoicing is not enabled for this API Key.' });
    }
    if (fullPath.startsWith('/api/qr') && !keyRow.allow_qr) {
      return res.status(403).json({ error: 'QR payments are not enabled for this API Key.' });
    }
    if (fullPath.startsWith('/api/refund') && !keyRow.allow_refund) {
      return res.status(403).json({ error: 'Refund processing is not enabled for this API Key.' });
    }

    // 4. Verify Kaspi account is connected
    if (!keyRow.kaspi_token_sn || !keyRow.kaspi_vtoken_secret) {
      return res.status(403).json({
        error: 'Kaspi cashier account is not connected yet. Please complete OTP onboarding at /connect.html.',
      });
    }

    // 5. Inject Kaspi credentials into request headers
    // This allows existing route middlewares (requireAuth) to function without change
    req.headers['x-token-sn'] = keyRow.kaspi_token_sn;
    req.headers['x-vtoken-secret'] = keyRow.kaspi_vtoken_secret;
    if (keyRow.profile_id) {
      req.headers['x-profile-id'] = keyRow.profile_id;
    }

    req.keyId = keyRow.id;
    // Устройство кассы нельзя пронести заголовком (в нём объект ключа), поэтому
    // кладём на запрос — requireAuth перенесёт его в req.session.
    req.kaspiDevice = deviceFromRow(keyRow);
    req.kaspiEcdhPrivkey = keyRow.ecdh_privkey || null;

    next();
  } catch (err) {
    res.status(500).json({ error: 'Database authentication error: ' + err.message });
  }
};

export default apiKeyAuth;
