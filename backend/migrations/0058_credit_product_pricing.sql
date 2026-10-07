-- Replace starter credit packs and add lifetime membership SKU.
-- Old ai-5 / ai-20 / ai-60 rows stay for historical payment_orders snapshots but are disabled.

UPDATE credit_products
SET enabled = false
WHERE id IN ('ai-5', 'ai-20', 'ai-60')
  AND version = 1;

INSERT INTO credit_products(id, version, name, description, credit_amount, amount_cents, currency, enabled)
VALUES
  ('ai-9', 1, '9 次', '轻量体验包', 9, 390, 'CNY', true),
  ('ai-49', 1, '49 次', '最受欢迎', 49, 1990, 'CNY', true),
  ('ai-99', 1, '99 次', '创作者包', 99, 3990, 'CNY', true),
  ('ai-lifetime', 1, '不限次数', '终身会员', 999999, 19900, 'CNY', true)
ON CONFLICT (id, version) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  credit_amount = EXCLUDED.credit_amount,
  amount_cents = EXCLUDED.amount_cents,
  currency = EXCLUDED.currency,
  enabled = EXCLUDED.enabled;
