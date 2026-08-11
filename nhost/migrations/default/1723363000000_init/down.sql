DROP TRIGGER IF EXISTS restrict_workflow_triggers_insert ON workflow_triggers;
DROP TRIGGER IF EXISTS restrict_workflow_steps_insert ON workflow_steps;
DROP FUNCTION IF EXISTS restrict_step_and_trigger_authors;

DROP VIEW IF EXISTS org_usage_this_month;

DROP TABLE IF EXISTS step_runs;
DROP TYPE IF EXISTS step_run_status;

DROP TABLE IF EXISTS workflow_runs;
DROP TYPE IF EXISTS run_status;

DROP TABLE IF EXISTS workflow_triggers;
DROP TYPE IF EXISTS trigger_type;

DROP TABLE IF EXISTS workflow_steps;
DROP TYPE IF EXISTS step_type;

DROP TABLE IF EXISTS workflows;

DROP TABLE IF EXISTS org_members;
DROP TYPE IF EXISTS org_role;

DROP TABLE IF EXISTS organizations;
