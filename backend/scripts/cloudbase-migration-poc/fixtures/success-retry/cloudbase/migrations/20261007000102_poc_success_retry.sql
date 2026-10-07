CREATE SCHEMA poc_success_retry;
CREATE TABLE poc_success_retry.marker (
  id text PRIMARY KEY
);
INSERT INTO poc_success_retry.marker (id) VALUES ('applied_once');
