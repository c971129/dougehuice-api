CREATE SCHEMA poc_repair;
CREATE TABLE poc_repair.marker (
  id text PRIMARY KEY,
  executions integer NOT NULL
);
INSERT INTO poc_repair.marker (id, executions)
VALUES ('execution_count', 1)
ON CONFLICT (id) DO UPDATE
SET executions = poc_repair.marker.executions + 1;
