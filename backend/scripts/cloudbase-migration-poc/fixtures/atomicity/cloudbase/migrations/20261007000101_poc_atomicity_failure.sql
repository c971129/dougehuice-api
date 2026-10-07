CREATE SCHEMA poc_atomicity;
CREATE TABLE poc_atomicity.marker (
  id text PRIMARY KEY
);
INSERT INTO poc_atomicity.marker (id) VALUES ('first_statement_committed');
SELECT 1 / 0;
