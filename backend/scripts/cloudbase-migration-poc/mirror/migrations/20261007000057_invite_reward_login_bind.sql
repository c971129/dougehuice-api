-- Invite reward on login-bind: snapshot invitee_was_new_user, session created_new_user.
-- Does NOT invent credit ledger rows. Historical awaiting entitlements are not backfilled.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS created_new_user boolean NOT NULL DEFAULT false;

ALTER TABLE invite_bindings
  ADD COLUMN IF NOT EXISTS invitee_was_new_user boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sessions.created_new_user IS
  'True only when this session was created together with INSERT of a new users row.';
COMMENT ON COLUMN invite_bindings.invitee_was_new_user IS
  'Snapshot at bind time: invitee account was created on the accepting session login.';
