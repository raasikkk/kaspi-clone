import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

// ─── Operations history (QR + remote) ───

router.post('/operations', async (req, res) => {
  const { endDate, lastTransactionDate, statementPeriodCode } = req.body;
  if (!endDate) return res.status(400).json({ error: 'endDate required' });
  try {
    const url = `${KASPI_QRPAY_URL}/v02/history/operations`;
    const reqBody = JSON.stringify({
      EndDate: endDate,
      LastTransactionDate: lastTransactionDate || '',
      StatementPeriodCode: statementPeriodCode ?? 0,
    });
    const headers = { ...signedQrPayHeaders(url, req.session, reqBody), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: reqBody,
    });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Operation details ───

router.post('/details', async (req, res) => {
  const { id, operationMethod } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const url = `${KASPI_QRPAY_URL}/v01/kaspi-qr/operations/details`;
    const reqBody = JSON.stringify({
      Id: Number(id),
      OperationMethod: operationMethod ?? 0,
    });
    const headers = { ...signedQrPayHeaders(url, req.session, reqBody), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: reqBody,
    });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
