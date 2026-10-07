-- Split the public polling credential from the Bearer session credential.
-- Challenges live for only five minutes, so deployment intentionally
-- invalidates all in-flight pairing codes instead of deriving/reusing the old
-- polling hash as authentication material.

DELETE FROM web_login_challenges;

ALTER TABLE web_login_challenges
  ADD COLUMN session_token_hash text NOT NULL,
  ADD CONSTRAINT web_login_challenges_session_token_hash_key
    UNIQUE (session_token_hash),
  ADD CONSTRAINT web_login_challenges_session_token_hash_contract
    CHECK (
      session_token_hash ~ '^[0-9a-f]{64}$'
      AND session_token_hash <> token_hash
    );
