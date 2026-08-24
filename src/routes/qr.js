import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { trackPayment } from '../polling.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createWithSessionRetry } from '../services/sessionRefresh.js';

const router = Router();

router.use(requireAuth);

// ─── Create QR token ───

router.post('/create', async (req, res) => {
  const { amount, latitude, longitude } = req.body;
  if (!amount) return res.status(400).json({ error: 'amount required' });

  try {
    // Авто-ретрай с переలогином: если сессию кассы выбило («вход с другого
    // устройства»), шлюз сам делает SignInLite и повторяет создание QR один раз.
    const url = `${KASPI_QRPAY_URL}/v01/qr-token/create`;
    const kaspiResponse = await createWithSessionRetry(req, async (session) => {
      const reqBody = JSON.stringify({
        PaymentAmount: Number(amount),
        DeviceInterface: 'Pos',
        Latitude: latitude || 43.204643483375889,
        Longitude: longitude || 76.891962364115912,
      });
      const headers = { ...signedQrPayHeaders(url, session, reqBody), 'Content-Type': 'application/json' };
      const resp = await loggedFetch(url, {
        method: 'POST',
        headers,
        body: reqBody,
      });
      return resp.json();
    });
    const d = kaspiResponse.Data;
    if (d && d.QrOperationId) {
      const opts = d.QrPaymentBehaviorOptions || {};
      trackPayment(
        d.QrOperationId,
        'qr',
        {
          tokenSN: req.session.tokenSN,
          vtokenSecret: req.headers['x-vtoken-secret'],
          profileId: req.session.profileId,
        },
        {
          qrToken: d.QrToken,
          expireDate: d.ExpireDate,
          receiptUrl: d.ReceiptUrl,
          amount: d.Amount,
          pollingIntervals: {
            scanWaitTimeout: Number(opts.qrCodeScanWaitTimeout) || 180,
            scanPollingInterval: Number(opts.qrCodeScanEventPollingInterval) || 3,
            statusCountdown: Number(opts.paymentStatusCountdown) || 2,
            confirmationTimeout: Number(opts.paymentConfirmationTimeout) || 65,
          },
        },
      );
    }
    if (d && d.QrToken) {
      d.QrToken = d.QrToken.replace('https://qr.kaspi.kz/', 'https://pay.kaspi.kz/pay/');
    }
    res.json(kaspiResponse);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── QR payment status ───

router.get('/status', async (req, res) => {
  const { qrOperationId } = req.query;
  if (!qrOperationId) return res.status(400).json({ error: 'qrOperationId required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v02/kaspi-qr/status?qrOperationId=${qrOperationId}`;
    const resp = await loggedFetch(url, { headers: signedQrPayHeaders(url, req.session) });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
