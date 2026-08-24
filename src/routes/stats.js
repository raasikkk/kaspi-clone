import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { query } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

// Helper to run aggregated stats SQL query
const getAggregatedStats = async (keyId, eventId = null) => {
  let sql = `
    SELECT 
      COUNT(*) as total_count,
      COALESCE(SUM(amount), 0)::numeric::float as total_amount,
      
      COUNT(CASE WHEN status IN ('Processed', 'success') THEN 1 END) as paid_count,
      COALESCE(SUM(CASE WHEN status IN ('Processed', 'success') THEN amount END), 0)::numeric::float as paid_amount,
      
      COUNT(CASE WHEN status IN ('RemotePaymentCreated', 'QrTokenCreated', 'Wait', 'pending') THEN 1 END) as pending_count,
      COALESCE(SUM(CASE WHEN status IN ('RemotePaymentCreated', 'QrTokenCreated', 'Wait', 'pending') THEN amount END), 0)::numeric::float as pending_amount,
      
      COUNT(CASE WHEN status IN ('RemotePaymentCanceled', 'CancelledByUser', 'CancelledByExternalSource', 'Cancelled') THEN 1 END) as cancelled_count,
      COALESCE(SUM(CASE WHEN status IN ('RemotePaymentCanceled', 'CancelledByUser', 'CancelledByExternalSource', 'Cancelled') THEN amount END), 0)::numeric::float as cancelled_amount,
      
      COUNT(CASE WHEN status = 'Expired' THEN 1 END) as expired_count,
      COALESCE(SUM(CASE WHEN status = 'Expired' THEN amount END), 0)::numeric::float as expired_amount,
      
      COUNT(CASE WHEN status IN ('Error', 'Failed', 'ProcessingFailed', 'Rejected', 'InsufficientFunds', 'InsufficientFundsError', 'SessionExpired') THEN 1 END) as error_count,
      COALESCE(SUM(CASE WHEN status IN ('Error', 'Failed', 'ProcessingFailed', 'Rejected', 'InsufficientFunds', 'InsufficientFundsError', 'SessionExpired') THEN amount END), 0)::numeric::float as error_amount,
      
      COUNT(CASE WHEN status = 'Refunded' THEN 1 END) as refunded_count,
      COALESCE(SUM(CASE WHEN status = 'Refunded' THEN amount END), 0)::numeric::float as refunded_amount
    FROM orders
    WHERE key_id = $1
  `;

  const params = [keyId];
  if (eventId) {
    sql += ` AND event_id = $2`;
    params.push(eventId);
  }

  const result = await query(sql, params);
  return result.rows[0];
};

// ─── 1. Get Event Statistics ───
router.get('/event/:eventId', async (req, res) => {
  const { eventId } = req.params;
  try {
    const keyId = req.keyId;

    const stats = await getAggregatedStats(keyId, eventId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. Get Organization Statistics ───
router.get('/organization', async (req, res) => {
  try {
    const keyId = req.keyId;

    const stats = await getAggregatedStats(keyId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 3. Get Paginated/Searchable Orders List ───
router.get('/orders', async (req, res) => {
  const { eventId, status, search, page = 1, limit = 10 } = req.query;

  try {
    const keyId = req.keyId;

    const conditions = ['o.key_id = $1'];
    const params = [keyId];
    let idx = 2;

    if (eventId) {
      conditions.push(`o.event_id = $${idx++}`);
      params.push(eventId);
    }
    if (status) {
      conditions.push(`o.status = $${idx++}`);
      params.push(status);
    }
    if (search) {
      conditions.push(
        `(o.order_id ILIKE $${idx} OR o.customer_name ILIKE $${idx} OR o.customer_phone ILIKE $${idx} OR o.customer_email ILIKE $${idx})`,
      );
      params.push(`%${search}%`);
      idx++;
    }

    // A. Count Query
    const countQuery = `
      SELECT COUNT(*) 
      FROM orders o
      WHERE ${conditions.join(' AND ')}
    `;
    const countResult = await query(countQuery, params);
    const totalItems = parseInt(countResult.rows[0].count, 10);

    // B. List Query
    const offset = (Number(page) - 1) * Number(limit);
    params.push(Number(limit), offset);

    const listQuery = `
      SELECT o.*, e.event_name 
      FROM orders o
      LEFT JOIN events e ON o.event_id = e.event_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    const listResult = await query(listQuery, params);

    res.json({
      orders: listResult.rows,
      totalItems,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(totalItems / Number(limit)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 4. Batch Status Sync ───
router.post('/sync', async (req, res) => {
  try {
    const keyId = req.keyId;

    // Fetch non-final orders
    const nonFinalResult = await query(
      `SELECT * FROM orders
       WHERE key_id = $1 
         AND status NOT IN (
           'Processed', 'success', 'CancelledByUser', 'NotConfirmedByUser', 'CancelledByExternalSource', 
           'ProcessingFailed', 'Rejected', 'InsufficientFunds', 'InsufficientFundsError', 'Error', 
           'QrTokenDiscarded', 'Expired', 'RemotePaymentCanceled', 'RemotePaymentRejected', 'SessionExpired'
         )`,
      [keyId],
    );

    const synced = [];
    for (const order of nonFinalResult.rows) {
      let url;
      if (order.type === 'qr') {
        url = `${KASPI_QRPAY_URL}/v02/kaspi-qr/status?qrOperationId=${order.kaspi_operation_id}`;
      } else {
        url = `${KASPI_QRPAY_URL}/v02/remote/details?operationId=${order.kaspi_operation_id}`;
      }

      try {
        const headers = signedQrPayHeaders(url, req.session);
        const resp = await loggedFetch(url, { headers });
        const json = await resp.json();

        if (json.Data && json.Data.Status) {
          const newStatus = json.Data.Status;
          const newDesc = json.Data.StatusDesc || json.Data.statusDesc || '';

          if (newStatus !== order.status) {
            await query(
              `UPDATE orders
               SET status = $1, status_desc = $2, updated_at = CURRENT_TIMESTAMP
               WHERE id = $3`,
              [newStatus, newDesc, order.id],
            );
            synced.push({ orderId: order.order_id, oldStatus: order.status, newStatus });
          }
        }
      } catch (err) {
        console.error(`Sync failed for order ${order.order_id}:`, err.message);
      }
    }

    res.json({
      success: true,
      processed: nonFinalResult.rows.length,
      synced,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 5. Daily Pre-aggregated Stats ───
// Returns pre-computed daily stats from the daily_stats table.
// Data is aggregated nightly at 01:00 AM by the cron job.
// Use ?days=N to get the last N days (default: 30, max: 90).
router.get('/daily', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const keyId = req.keyId;

  try {
    const result = await query(
      `SELECT
         stat_date,
         total_count, total_amount,
         paid_count, paid_amount,
         cancelled_count, cancelled_amount,
         refunded_count, refunded_amount,
         error_count,
         aggregated_at
       FROM daily_stats
       WHERE key_id = $1
         AND stat_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
       ORDER BY stat_date DESC`,
      [keyId, days],
    );

    res.json({
      days,
      rows: result.rows,
      note:
        result.rows.length === 0
          ? 'No pre-aggregated data yet. Data is collected nightly at 01:00 AM (Asia/Almaty).'
          : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
