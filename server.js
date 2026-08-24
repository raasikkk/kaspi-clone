import express from 'express';
import fs from 'fs';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import { PORT, ROOT_DIR } from './src/config.js';
import { initDb } from './src/db.js';
import adminRoutes from './src/routes/admin.js';
import apiKeyAuth from './src/middleware/apiKeyAuth.js';
import authRoutes from './src/routes/auth.js';
import invoiceRoutes from './src/routes/invoice.js';
import qrRoutes from './src/routes/qr.js';
import historyRoutes from './src/routes/history.js';
import refundRoutes from './src/routes/refund.js';
import sessionRoutes from './src/routes/session.js';
import ordersRoutes from './src/routes/orders.js';
import statsRoutes from './src/routes/stats.js';
import { startPolling } from './src/polling.js';
import { startCron } from './src/cron.js';
import 'dotenv/config';

// 1. Initialize PostgreSQL Database Schema at boot
await initDb();

const app = express();

const swaggerDocument = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'docs', 'openapi.json'), 'utf8'));

app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 2. Register public / master-admin endpoints (bypass X-API-Key checks)
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);

// 3. Apply API Key authentication and permission gating globally
app.use(apiKeyAuth);

// 4. Register payment routes (protected by X-API-Key validation)
app.use('/api/invoice', invoiceRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/refund', refundRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/stats', statsRoutes);

app.listen(PORT, () => {
  console.log(`\n  🟢 Kaspi Pay App running at http://localhost:${PORT}\n`);
  startPolling();
  startCron();
});
