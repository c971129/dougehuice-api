-- Invite / fission preparation: protected invite codes, one-time invitee bindings,
-- and reward entitlements that stay awaiting external WeChat share proof + product amounts.
-- This migration MUST NOT invent credit ledger awards.

CREATE TABLE IF NOT EXISTS user_invite_codes (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_invite_codes_code_len CHECK (char_length(code) BETWEEN 8 AND 32)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_invite_codes_code_uidx ON user_invite_codes(code);

CREATE TABLE IF NOT EXISTS invite_bindings (
  invitee_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  inviter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_bindings_no_self CHECK (invitee_user_id <> inviter_user_id)
);
CREATE INDEX IF NOT EXISTS invite_bindings_inviter_idx ON invite_bindings(inviter_user_id);

CREATE TABLE IF NOT EXISTS invite_reward_entitlements (
  id uuid PRIMARY KEY,
  binding_invitee_user_id uuid NOT NULL REFERENCES invite_bindings(invitee_user_id) ON DELETE CASCADE,
  beneficiary_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('inviter', 'invitee')),
  status text NOT NULL CHECK (status IN ('awaiting_external_proof', 'credited', 'rejected')),
  credit_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_reward_entitlements_binding_role_uidx UNIQUE (binding_invitee_user_id, role)
);
CREATE INDEX IF NOT EXISTS invite_reward_entitlements_beneficiary_idx
  ON invite_reward_entitlements(beneficiary_user_id, created_at DESC);
