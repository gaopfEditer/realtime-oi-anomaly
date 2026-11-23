-- Optional PostgreSQL schema. The API uses in-memory fake data by default.
-- Do not run CREATE DATABASE here: connect to an existing database first.
-- Example:
--   createdb mercu_clone
--   psql -d mercu_clone -f database/init.sql

CREATE TABLE IF NOT EXISTS coins (
  id text PRIMARY KEY,
  name text NOT NULL,
  price numeric(16, 8),
  vol24h varchar(16),
  change1h numeric,
  change24h numeric,
  category text
);

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  username text UNIQUE,
  email varchar(80),
  vip_until date,
  subscription_plan text DEFAULT 'free'
);

INSERT INTO coins (id, name, price, vol24h, change1h, change24h, category) VALUES
  ('BTC', 'Bitcoin', 82784.40, '$49.4B', 0.06, 0.80, 'crypto'),
  ('ETH', 'Ethereum', 2444.12, '$34.4B', 1.27, 2.15, 'crypto'),
  ('SOL', 'Solana', 178.65, '$6.1B', -0.22, -0.84, 'crypto'),
  ('XRP', 'XRP', 2.18, '$4.8B', 0.11, 0.41, 'crypto'),
  ('DOGE', 'Dogecoin', 0.182, '$1.9B', -0.40, -1.12, 'crypto'),
  ('PEPE', 'Pepe', 0.0000094, '$980M', 1.10, 3.55, 'crypto')
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_coins_category ON coins (category);
