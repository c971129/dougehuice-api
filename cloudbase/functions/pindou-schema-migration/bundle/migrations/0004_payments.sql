CREATE TABLE IF NOT EXISTS credit_products (
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '',
  credit_amount integer NOT NULL CHECK (credit_amount > 0),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL CHECK (currency = 'CNY'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

INSERT INTO credit_products(id, version, name, description, credit_amount, amount_cents, currency, enabled)
VALUES
  ('ai-5', 1, '5 次', '轻量体验包', 5, 600, 'CNY', true),
  ('ai-20', 1, '20 次', '最受欢迎', 20, 1800, 'CNY', true),
  ('ai-60', 1, '60 次', '创作者包', 60, 4500, 'CNY', true)
ON CONFLICT (id, version) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  credit_amount = EXCLUDED.credit_amount,
  amount_cents = EXCLUDED.amount_cents,
  currency = EXCLUDED.currency,
  enabled = EXCLUDED.enabled;

CREATE TABLE IF NOT EXISTS payment_orders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  product_id text NOT NULL,
  product_version integer NOT NULL,
  product_name text NOT NULL,
  credit_amount integer NOT NULL CHECK (credit_amount > 0),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL CHECK (currency = 'CNY'),
  out_trade_no varchar(32) NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'closed')),
  provider_reference text NOT NULL,
  provider_trade_state text,
  provider_transaction_id varchar(64),
  payment_expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, product_version) REFERENCES credit_products(id, version),
  CHECK ((status = 'succeeded') = (paid_at IS NOT NULL AND provider_transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_provider_transaction_unique
  ON payment_orders(provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_orders_user_created_idx
  ON payment_orders(user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('fake', 'wechat-notify', 'wechat-query')),
  provider_transaction_id varchar(64) NOT NULL,
  provider_trade_state text NOT NULL,
  processed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_payment_reference_unique
  ON credit_ledger(reference_id)
  WHERE reason = 'payment_credit';
