import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { trackPayment } from '../polling.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

// ─── Client info ───

router.get('/client-info', async (req, res) => {
  const { phoneNumber } = req.query;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/client-info?phoneNumber=${phoneNumber}`;
    const resp = await loggedFetch(url, { headers: signedQrPayHeaders(url, req.session) });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create invoice ───

router.post('/create', async (req, res) => {
  const { phoneNumber, amount, comment } = req.body;
  if (!phoneNumber || !amount) return res.status(400).json({ error: 'phoneNumber and amount required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/create`;
    const reqBody = JSON.stringify({ PhoneNumber: phoneNumber, Amount: Number(amount), Comment: comment || '' });
    const headers = { ...signedQrPayHeaders(url, req.session, reqBody), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: reqBody,
    });
    const kaspiResponse = await resp.json();
    const d = kaspiResponse.Data;
    if (d && d.Id && d.Status === 'RemotePaymentCreated') {
      trackPayment(
        d.Id,
        'invoice',
        {
          tokenSN: req.session.tokenSN,
          vtokenSecret: req.headers['x-vtoken-secret'],
          profileId: req.session.profileId,
        },
        {
          amount: d.Amount,
          clientMobile: d.ClientMobile,
          receiptUrl: d.ReceiptUrl,
          orderNumber: d.OrderNumber,
        },
      );
    }
    res.json(kaspiResponse);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Invoice details ───

router.get('/details', async (req, res) => {
  const { operationId } = req.query;
  if (!operationId) return res.status(400).json({ error: 'operationId required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v02/remote/details?operationId=${operationId}`;
    const resp = await loggedFetch(url, { headers: signedQrPayHeaders(url, req.session) });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cancel invoice ───

router.post('/cancel', async (req, res) => {
  const { operationId } = req.body;
  if (!operationId) return res.status(400).json({ error: 'operationId required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/cancel`;
    const reqBody = JSON.stringify({ qrOperationId: Number(operationId) });
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

// ─── Invoice history ───

router.post('/history', async (req, res) => {
  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/history`;
    const reqBody = JSON.stringify({ MaxResult: 20 });
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
