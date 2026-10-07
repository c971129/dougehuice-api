-- Releases before credential-domain separation stored the Web polling hash in
-- sessions after approval. Once its short-lived challenge row was cleaned up,
-- that legacy Bearer session was indistinguishable from every other session.
-- Revoke all existing sessions once so no pre-0047 polling credential can
-- remain usable for the normal session TTL. Every client must authenticate
-- again after this migration.

DELETE FROM sessions;
