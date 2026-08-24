import { Router } from 'express';
import crypto from 'crypto';
import { ADMIN_SECRET_KEY } from '../config.js';
import { query } from '../db.js';

const router = Router();

// Middleware to authorize Admin requests
const requireAdminAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header.' });
  }

  const token = authHeader.replace('Bearer ', '').trim();

  // Use timing-safe comparison to prevent timing attack brute-force
  let isValid;
  try {
    isValid = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_SECRET_KEY));
  } catch {
    // Buffer lengths differ — definitely not equal
    isValid = false;
  }
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid Admin Secret Key.' });
  }

  next();
};

// Apply admin auth check to all routes in this file
router.use(requireAdminAuth);

// ─── 1. Create a new Theater Key ───
router.post('/keys', async (req, res) => {
  const { name, allow_invoice, allow_qr, allow_refund, expires_at } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Theater name ("name") is required.' });
  }

  try {
    // Generate a secure API Key
    const apiKey = 'apipay_org_' + crypto.randomBytes(24).toString('hex');

    const result = await query(
      `INSERT INTO keys (theater_name, api_key, allow_invoice, allow_qr, allow_refund, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, theater_name, api_key, status, allow_invoice, allow_qr, allow_refund, expires_at, created_at`,
      [
        name,
        apiKey,
        allow_invoice !== undefined ? Boolean(allow_invoice) : false,
        allow_qr !== undefined ? Boolean(allow_qr) : true,
        allow_refund !== undefined ? Boolean(allow_refund) : false,
        expires_at || null,
      ],
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. List all Theater Keys ───
router.get('/keys', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, theater_name, api_key, status, allow_invoice, allow_qr, allow_refund, profile_id,
              expires_at, (kaspi_token_sn IS NOT NULL) AS is_connected, created_at
       FROM keys
       ORDER BY id DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 3. Update permissions or status of a Key ───
router.patch('/keys/:id', async (req, res) => {
  const { id } = req.params;
  const { name, allow_invoice, allow_qr, allow_refund, status, expires_at } = req.body;

  if (isNaN(Number(id))) {
    return res.status(400).json({ error: 'Invalid ID parameter.' });
  }

  if (status !== undefined) {
    const validStatuses = ['active', 'suspended'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status value. Allowed values are: ${validStatuses.join(', ')}` });
    }
  }

  const fields = [];
  const params = [];
  let idx = 1;

  if (name !== undefined) {
    fields.push(`theater_name = $${idx++}`);
    params.push(name);
  }
  if (allow_invoice !== undefined) {
    fields.push(`allow_invoice = $${idx++}`);
    params.push(Boolean(allow_invoice));
  }
  if (allow_qr !== undefined) {
    fields.push(`allow_qr = $${idx++}`);
    params.push(Boolean(allow_qr));
  }
  if (allow_refund !== undefined) {
    fields.push(`allow_refund = $${idx++}`);
    params.push(Boolean(allow_refund));
  }
  if (status !== undefined) {
    fields.push(`status = $${idx++}`);
    params.push(status);
  }
  if (expires_at !== undefined) {
    fields.push(`expires_at = $${idx++}`);
    params.push(expires_at || null);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'No fields to update provided.' });
  }

  params.push(Number(id));
  const updateQuery = `
    UPDATE keys
    SET ${fields.join(', ')}
    WHERE id = $${idx}
    RETURNING id, theater_name, api_key, status, allow_invoice, allow_qr, allow_refund, expires_at, (kaspi_token_sn IS NOT NULL) AS is_connected, created_at
  `;

  try {
    const result = await query(updateQuery, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'API Key profile not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 4. Revoke/Delete a Key ───
router.delete('/keys/:id', async (req, res) => {
  const { id } = req.params;
  if (isNaN(Number(id))) {
    return res.status(400).json({ error: 'Invalid ID parameter.' });
  }

  try {
    const result = await query(
      `DELETE FROM keys
       WHERE id = $1
       RETURNING id, theater_name`,
      [Number(id)],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'API Key profile not found.' });
    }

    res.json({ success: true, message: `API Key for '${result.rows[0].theater_name}' has been deleted.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
