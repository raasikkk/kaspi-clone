import { decryptSecret } from '../crypto.js';

/**
 * Extracts Kaspi session properties from request headers.
 */
export const extractSession = (req) => ({
  tokenSN: req.headers['x-token-sn'] || null,
  profileId: req.headers['x-profile-id'] || null,
  vtokenSecret: req.headers['x-vtoken-secret'] || null,
});

/**
 * Express middleware to enforce valid Kaspi session authentication headers.
 */
export const requireAuth = (req, res, next) => {
  const session = extractSession(req);
  if (!session.tokenSN) return res.status(401).json({ error: 'Missing X-Token-SN header.' });
  if (!session.vtokenSecret) return res.status(401).json({ error: 'Missing X-Vtoken-Secret header.' });
  try {
    session.decryptedSecret = decryptSecret(session.vtokenSecret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired vtokenSecret. Re-authenticate.' });
  }
  // Подпись счёта/QR должна идти устройством этой же кассы (apiKeyAuth его уже
  // восстановил). Если его нет — helpers сам возьмёт старое общее устройство.
  if (req.kaspiDevice) session.device = req.kaspiDevice;
  if (req.kaspiEcdhPrivkey) session.ecdhPrivkey = req.kaspiEcdhPrivkey;
  req.session = session;
  next();
};
