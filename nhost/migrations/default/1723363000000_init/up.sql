-- Organizations & membership
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  quota_calls_allowed int not null default 1000,
  quota_calls_used int not null default 0,
  quota_period_start date not null default date_trunc('month', now()),
  created_at timestamptz not null default now()
);

create type org_role as enum ('owner', 'editor', 'viewer');

create table org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role org_role not null,
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

-- Workflows
create table workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type step_type as enum
  ('llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate');

create table workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  step_order int not null,
  type step_type not null,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (workflow_id, step_order)
);

create type trigger_type as enum ('manual', 'webhook', 'scheduled', 'db_event');

create table workflow_triggers (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  type trigger_type not null,
  config jsonb not null default '{}',
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- Execution
create type run_status as enum ('pending', 'running', 'paused', 'succeeded', 'failed');

create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  status run_status not null default 'pending',
  triggered_by_user_id uuid references auth.users(id),
  trigger_type trigger_type not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create type step_run_status as enum
  ('pending', 'running', 'succeeded', 'failed', 'paused_awaiting_approval');

create table step_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id) on delete cascade,
  workflow_step_id uuid not null references workflow_steps(id),
  status step_run_status not null default 'pending',
  input jsonb,
  output jsonb,
  error text,
  attempt_count int not null default 0,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
);

-- Aggregation view
create view org_usage_this_month as
select
  o.id as org_id,
  o.quota_calls_allowed,
  o.quota_calls_used,
  round(avg(extract(epoch from (r.finished_at - r.started_at))))::int
    filter (where r.finished_at is not null) as avg_run_duration_seconds
from organizations o
left join workflow_runs r
  on r.org_id = o.id and r.started_at >= date_trunc('month', now())
group by o.id, o.quota_calls_allowed, o.quota_calls_used;

-- Permission Layer 2: step-type authoring restriction (DB trigger)
-- Prevent non-owners from creating db_write, notify steps, or webhook triggers.
CREATE OR REPLACE FUNCTION restrict_step_and_trigger_authors()
RETURNS TRIGGER AS $$
DECLARE
  caller_role org_role;
  workflow_org_id uuid;
  hasura_user_id uuid;
BEGIN
  -- Extract user_id from Hasura's session variables via current_setting
  BEGIN
    hasura_user_id := (current_setting('hasura.user', true)::json->>'x-hasura-user-id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    -- If not called via Hasura (e.g. raw DB access), bypass or reject. We'll allow it for admin.
    RETURN NEW;
  END;

  IF hasura_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get the org_id for the workflow
  SELECT org_id INTO workflow_org_id FROM workflows WHERE id = NEW.workflow_id;
  
  -- Get the caller's role in this org
  SELECT role INTO caller_role FROM org_members 
  WHERE user_id = hasura_user_id AND org_id = workflow_org_id;

  -- Apply restrictions for workflow_steps
  IF TG_TABLE_NAME = 'workflow_steps' THEN
    IF NEW.type IN ('db_write', 'notify') AND caller_role != 'owner' THEN
      RAISE EXCEPTION 'Only owners can create db_write or notify steps';
    END IF;
  END IF;

  -- Apply restrictions for workflow_triggers
  IF TG_TABLE_NAME = 'workflow_triggers' THEN
    IF NEW.type = 'webhook' AND caller_role != 'owner' THEN
      RAISE EXCEPTION 'Only owners can create webhook triggers';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER restrict_workflow_steps_insert
  BEFORE INSERT ON workflow_steps
  FOR EACH ROW
  EXECUTE FUNCTION restrict_step_and_trigger_authors();

CREATE TRIGGER restrict_workflow_triggers_insert
  BEFORE INSERT ON workflow_triggers
  FOR EACH ROW
  EXECUTE FUNCTION restrict_step_and_trigger_authors();

