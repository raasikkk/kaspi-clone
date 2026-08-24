import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { query } from '../db.js';
import { trackPayment } from '../polling.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createWithSessionRetry } from '../services/sessionRefresh.js';

const router = Router();

router.use(requireAuth);

// ─── Create Invoice for Order ───
router.post('/invoice', async (req, res) => {
  const { orderId, eventId, eventName, amount, customerPhone, customerName, customerEmail } = req.body;

  if (!orderId || !eventId || !eventName || !amount || !customerPhone) {
    return res.status(400).json({ error: 'orderId, eventId, eventName, amount, and customerPhone are required.' });
  }

  try {
    const keyId = req.keyId;

    // Check if order already exists for this API key
    const existingOrder = await query(
      'SELECT kaspi_operation_id, status, status_desc, amount, customer_phone, order_id FROM orders WHERE key_id = $1 AND order_id = $2',
      [keyId, orderId],
    );

    if (existingOrder.rows.length > 0) {
      const order = existingOrder.rows[0];
      return res.json({
        StatusCode: 0,
        Message: 'Order already exists.',
        Data: {
          Id: order.kaspi_operation_id,
          Status: order.status,
          StatusDesc: order.status_desc,
          Amount: Number(order.amount),
          ClientMobile: order.customer_phone,
          OrderNumber: order.order_id,
        },
      });
    }

    // 1. Upsert Event
    await query(
      `INSERT INTO events (event_id, key_id, event_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id)
       DO UPDATE SET event_name = EXCLUDED.event_name`,
      [eventId, keyId, eventName],
    );

    // 2. Dispatch Remote Invoice request to Kaspi.
    // Оборачиваем в авто-ретрай: если сессию кассы выбило (кассир зашёл в Kaspi
    // с телефона → «вход с другого устройства»), шлюз сам делает SignInLite и
    // повторяет счёт один раз.
    const url = `${KASPI_QRPAY_URL}/v01/remote/create`;
    const kaspiResponse = await createWithSessionRetry(req, async (session) => {
      const reqBody = JSON.stringify({
        PhoneNumber: customerPhone,
        Amount: Number(amount),
        Comment: `Заказ #${orderId} на ${eventName}`,
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
    // Kaspi returns the remote-invoice operation id as `QrOperationId`; normalize to
    // `Id` so payment tracking and downstream consumers (stylemix) can rely on Data.Id.
    const operationId = d ? (d.QrOperationId ?? d.Id) : undefined;

    // 3. If successfully created, log the order in the database and register for status tracking
    if (d && operationId != null) {
      d.Id = operationId;
      await query(
        `INSERT INTO orders (key_id, order_id, event_id, amount, customer_name, customer_phone, customer_email, kaspi_operation_id, type, status, status_desc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          keyId,
          orderId,
          eventId,
          Number(amount),
          customerName || null,
          customerPhone,
          customerEmail || null,
          String(operationId),
          'invoice',
          d.Status || 'RemotePaymentCreated',
          d.StatusDesc || 'Счет выставлен',
        ],
      );

      trackPayment(
        operationId,
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

// ─── Update Order Status Manually ───
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, status_desc } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'status is required.' });
  }

  try {
    const keyId = req.keyId;

    // 1. Fetch the order to verify ownership and get details
    let orderResult;
    if (Number.isInteger(Number(id)) && Number(id) > 0) {
      orderResult = await query(
        'SELECT id, kaspi_operation_id, order_id, amount, type FROM orders WHERE id = $1 AND key_id = $2',
        [parseInt(id, 10), keyId],
      );
    }
    if (!orderResult || orderResult.rows.length === 0) {
      orderResult = await query(
        'SELECT id, kaspi_operation_id, order_id, amount, type FROM orders WHERE order_id = $1 AND key_id = $2',
        [id, keyId],
      );
    }

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const matchedOrder = orderResult.rows[0];
    const orderDbId = matchedOrder.id;
    const kaspiOpId = matchedOrder.kaspi_operation_id;

    // 2. Update the status in the database
    await query(
      `UPDATE orders
       SET status = $1, status_desc = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [status, status_desc || null, orderDbId],
    );

    // 3. Stop background tracking for this payment if it has a kaspi_operation_id
    if (kaspiOpId) {
      const { untrackPayment } = await import('../polling.js');
      untrackPayment(kaspiOpId);
    }

    // 4. Dispatch webhook notification
    const { resolveEvent, buildPayload, sendWebhooks } = await import('../polling.js');
    const event = resolveEvent(matchedOrder.type, status);
    if (event) {
      const entry = {
        paymentId: kaspiOpId || String(orderDbId),
        type: matchedOrder.type,
        status: status,
        meta: {
          amount: Number(matchedOrder.amount),
          qrToken: null,
          receiptUrl: null,
          orderNumber: matchedOrder.order_id,
        },
      };
      const data = {
        Status: status,
        StatusDesc: status_desc || '',
      };
      const payload = buildPayload(event, entry, data);
      sendWebhooks(event, payload);
    }

    res.json({ success: true, message: `Order status manually updated to ${status}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
