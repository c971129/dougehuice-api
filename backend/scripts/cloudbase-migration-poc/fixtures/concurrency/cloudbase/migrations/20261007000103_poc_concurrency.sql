CREATE SCHEMA poc_concurrency;
CREATE TABLE poc_concurrency.marker (
  id text PRIMARY KEY
);
SELECT pg_sleep(15);
INSERT INTO poc_concurrency.marker (id) VALUES ('applied_once');
