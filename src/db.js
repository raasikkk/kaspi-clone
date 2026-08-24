import pg from 'pg';
import { DATABASE_URL } from './config.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: DATABASE_URL,
});

/**
 * Initialize database schema and verify connection.
 * Includes a retry mechanism to wait for the PostgreSQL container to boot up.
 */
export const initDb = async (retries = 5, delay = 2000) => {
  const schemaQuery = `
    CREATE TABLE IF NOT EXISTS keys (
      id SERIAL PRIMARY KEY,
      theater_name VARCHAR(255) NOT NULL,
      api_key VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) DEFAULT 'active',
      allow_qr BOOLEAN DEFAULT TRUE,
      allow_invoice BOOLEAN DEFAULT FALSE,
      allow_refund BOOLEAN DEFAULT FALSE,
      kaspi_token_sn VARCHAR(255),
      kaspi_vtoken_secret TEXT,
      profile_id VARCHAR(255),
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

    -- Своё устройство на каждую кассу (NULL = касса на общем устройстве).
    ALTER TABLE keys ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
    ALTER TABLE keys ADD COLUMN IF NOT EXISTS install_id VARCHAR(64);
    ALTER TABLE keys ADD COLUMN IF NOT EXISTS device_pin_hash VARCHAR(64);
    ALTER TABLE keys ADD COLUMN IF NOT EXISTS device_privkey TEXT;
    ALTER TABLE keys ADD COLUMN IF NOT EXISTS ecdh_privkey TEXT;

    CREATE TABLE IF NOT EXISTS events (
      event_id VARCHAR(255) PRIMARY KEY,
      key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
      event_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
      order_id VARCHAR(255) NOT NULL,
      event_id VARCHAR(255) NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      customer_name VARCHAR(255),
      customer_phone VARCHAR(255),
      customer_email VARCHAR(255),
      kaspi_operation_id VARCHAR(255) UNIQUE,
      type VARCHAR(50) NOT NULL,
      status VARCHAR(100) NOT NULL DEFAULT 'pending',
      status_desc TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (key_id, order_id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_event_id ON orders(event_id);
    CREATE INDEX IF NOT EXISTS idx_orders_key_id ON orders(key_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_key_order') THEN
        ALTER TABLE orders ADD CONSTRAINT unique_key_order UNIQUE (key_id, order_id);
      END IF;
    END;
    $$;

    CREATE TABLE IF NOT EXISTS daily_stats (
      id SERIAL PRIMARY KEY,
      key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
      stat_date DATE NOT NULL,
      total_count INTEGER DEFAULT 0,
      total_amount NUMERIC DEFAULT 0,
      paid_count INTEGER DEFAULT 0,
      paid_amount NUMERIC DEFAULT 0,
      cancelled_count INTEGER DEFAULT 0,
      cancelled_amount NUMERIC DEFAULT 0,
      refunded_count INTEGER DEFAULT 0,
      refunded_amount NUMERIC DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      aggregated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (key_id, stat_date)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_stats_key_date ON daily_stats(key_id, stat_date DESC);
  `;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Connecting to PostgreSQL (Attempt ${attempt}/${retries})...`);
      const client = await pool.connect();
      try {
        await client.query(schemaQuery);
        console.log('  🟢 PostgreSQL connected & schema verified.');
        return;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error(`  🔴 Connection attempt ${attempt} failed: ${err.message}`);
      if (attempt === retries) {
        console.error('Max database connection retries reached. Exiting.');
        process.exit(1);
      }
      console.log(`Waiting ${delay / 1000}s before retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

export const query = (text, params) => pool.query(text, params);
export { pool };
