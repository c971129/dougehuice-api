ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wechat_openid varchar(128);

CREATE UNIQUE INDEX IF NOT EXISTS users_wechat_openid_unique
  ON users(wechat_openid)
  WHERE wechat_openid IS NOT NULL;

ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS notification_id varchar(128),
  ADD COLUMN IF NOT EXISTS raw_body_sha256 char(64),
  ADD COLUMN IF NOT EXISTS wechat_serial varchar(128),
  ADD COLUMN IF NOT EXISTS out_trade_no varchar(32);

UPDATE payment_events AS event
SET out_trade_no = payment_order.out_trade_no
FROM payment_orders AS payment_order
WHERE event.order_id = payment_order.id
  AND event.out_trade_no IS NULL;

ALTER TABLE payment_events
  ALTER COLUMN out_trade_no SET NOT NULL;

ALTER TABLE payment_events
  DROP CONSTRAINT IF EXISTS payment_events_wechat_notification_metadata_check;
ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_wechat_notification_metadata_check CHECK (
    source <> 'wechat-notify'
    OR (
      notification_id IS NOT NULL
      AND raw_body_sha256 IS NOT NULL
      AND raw_body_sha256 ~ '^[0-9a-f]{64}$'
      AND wechat_serial IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS payment_events_notification_id_unique
  ON payment_events(notification_id)
  WHERE notification_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_events_out_trade_no_created_idx
  ON payment_events(out_trade_no, created_at DESC);
