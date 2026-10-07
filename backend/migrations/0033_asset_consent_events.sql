-- Immutable audit history for successful AI asset uploads. New events are
-- committed in the same transaction that publishes the asset. Existing ready
-- AI assets are backfilled with an explicit source so derived history is not
-- confused with consent captured by the current upload path.
CREATE TABLE asset_consent_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL UNIQUE,
  consent_version text NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 64),
  asset_purpose text NOT NULL CHECK (asset_purpose IN ('ai-source', 'ai-intermediate')),
  policy_sha256 char(64) NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  processor text NOT NULL CHECK (char_length(processor) BETWEEN 1 AND 500),
  processing_purpose text NOT NULL CHECK (char_length(processing_purpose) BETWEEN 1 AND 1000),
  retention text NOT NULL CHECK (char_length(retention) BETWEEN 1 AND 1000),
  source text NOT NULL CHECK (source IN ('asset-upload', 'legacy-asset-backfill')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX asset_consent_events_user_occurred_idx
  ON asset_consent_events(user_id, occurred_at DESC, id DESC);

-- Keep asset_id as an immutable snapshot rather than a foreign key so normal
-- purged-asset history compaction cannot erase or rewrite the audit record.
-- This insert-time trigger still proves that the linked asset is ready,
-- belongs to the same tenant, and carries the recorded consent contract.
CREATE FUNCTION validate_asset_consent_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM assets AS asset
    WHERE asset.id = NEW.asset_id
      AND asset.user_id = NEW.user_id
      AND asset.purpose = NEW.asset_purpose
      AND asset.consent_version = NEW.consent_version
      AND asset.ready_at IS NOT NULL
      AND NEW.policy_sha256 = encode(sha256(convert_to(
        NEW.consent_version
          || E'\n' || NEW.processor
          || E'\n' || NEW.processing_purpose
          || E'\n' || NEW.retention,
        'UTF8'
      )), 'hex')
  ) THEN
    RAISE EXCEPTION 'asset consent event does not match a ready tenant asset'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_consent_events_asset_snapshot_valid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_consent_events_validate_insert
BEFORE INSERT ON asset_consent_events
FOR EACH ROW EXECUTE FUNCTION validate_asset_consent_event_insert();

CREATE FUNCTION reject_asset_consent_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'asset consent events are immutable'
    USING ERRCODE = '55000', CONSTRAINT = 'asset_consent_events_immutable';
END;
$$;

CREATE TRIGGER asset_consent_events_immutable
BEFORE UPDATE OR DELETE ON asset_consent_events
FOR EACH ROW EXECUTE FUNCTION reject_asset_consent_event_mutation();

INSERT INTO asset_consent_events(
  id, user_id, asset_id, consent_version, asset_purpose,
  policy_sha256, processor, processing_purpose, retention,
  source, occurred_at, recorded_at
)
SELECT
  asset.id,
  asset.user_id,
  asset.id,
  asset.consent_version,
  asset.purpose,
  encode(sha256(convert_to(
    asset.consent_version
      || E'\nlegacy-unrecorded'
      || E'\nlegacy-unrecorded: 历史素材未记录处理用途快照'
      || E'\nlegacy-unrecorded: 历史素材未记录保留说明快照',
    'UTF8'
  )), 'hex'),
  'legacy-unrecorded',
  'legacy-unrecorded: 历史素材未记录处理用途快照',
  'legacy-unrecorded: 历史素材未记录保留说明快照',
  'legacy-asset-backfill',
  asset.created_at,
  clock_timestamp()
FROM assets AS asset
WHERE asset.purpose IN ('ai-source', 'ai-intermediate')
  AND asset.consent_version IS NOT NULL
  AND asset.ready_at IS NOT NULL
ON CONFLICT (asset_id) DO NOTHING;
