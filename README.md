# AI Agent Workflow Builder — Build Spec

> **Read this whole document before writing any code.** This is a single integrated
> system, not six separate features. The acceptance test is one live scenario
> (see §9) that exercises the schema, both permission layers, the execution
> engine, and live subscriptions together. Getting one layer wrong breaks the
> whole scenario, even if every other layer is individually correct.

## 0. What this is, in one paragraph

A multi-tenant, mini n8n-style tool for chaining AI-agent workflow steps
(`llm_call`, `http_request`, `db_write`, `notify`, `conditional_branch`,
`approval_gate`). Users belong to organizations with a role
(`owner`/`editor`/`viewer`). Every workflow lives inside an org and can be
triggered manually, via webhook, on a schedule, or on a database event. A
Hasura Action runs the workflow step-by-step against real external calls,
supports pausing on an approval gate and resuming after a role-checked
approval, and streams live progress to the frontend via GraphQL
subscriptions. Two independent permission layers must both hold: org+role
scoping (Hasura permissions) and step-type/approval gating (application code
in the Action handler).

---

## 1. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Backend platform | **nhost** | Bundles Postgres + Hasura + Auth + Storage + Serverless Functions |
| Database | **PostgreSQL** | Via nhost, migrations tracked in repo |
| API layer | **Hasura GraphQL Engine** | Auto CRUD + subscriptions + Actions + Event Triggers |
| Custom backend logic | **nhost Serverless Functions** (Node/TypeScript) | Backs the Hasura Actions and the scheduled trigger |
| Auth | **nhost Auth** | Provides `x-hasura-user-id`, `x-hasura-role` session variables to Hasura |
| Frontend | **Next.js (App Router) + React** | TypeScript throughout |
| GraphQL client | **urql** or **Apollo Client** (either is fine) — must support subscriptions over WebSocket | |
| LLM API | Any free tier: **Groq**, **OpenRouter**, or **Gemini** | If no key is available, implement a stub with a disclosed artificial delay (e.g. `setTimeout` + a comment/log saying "STUBBED") — do not silently fake it |
| HTTP step target | Any public API (e.g. a weather API, `httpbin.org`, or your own stub) | |
| Hosting | **Vercel** for Next.js; **nhost cloud** for backend | |

Design principle: **push as much as possible into Hasura's declarative layer**
(permissions, relationships, computed fields) and keep custom code limited to
what genuinely requires it — the two Actions and the scheduled function.
Don't build a separate Express server; nhost Functions are sufficient.

---

## 2. Data model

Exact field names are flexible; these relationships are not:
`organizations → org_members → workflows → workflow_steps/workflow_triggers`,
and `workflows → workflow_runs → step_runs`.

```sql
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
  config jsonb not null default '{}',  -- e.g. { "cron": "*/15 * * * *" } or { "watch_table": "orders" }
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- Execution
create type run_status as enum ('pending', 'running', 'paused', 'succeeded', 'failed');

create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade, -- denormalized for fast permission checks
  status run_status not null default 'pending',
  triggered_by_user_id uuid references auth.users(id), -- null for non-manual triggers
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
```

**Why `org_id` is denormalized onto `workflow_runs`:** Hasura permission
checks need to filter on org membership without chaining through 3 tables at
query time on every subscription tick. Copying `org_id` down keeps the
permission predicate on `workflow_runs` and `step_runs` (via a relationship)
cheap and simple to reason about — this matters a lot for subscriptions,
which re-evaluate the permission on every push.

**Aggregation requirement:** add a Postgres view for org-level usage, e.g.:

```sql
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
```

Track this view in Hasura and expose it as a query, scoped by the same org
permission rules as everything else.

---

## 3. Permission Layer 1 — Hasura declarative permissions (org + role scoping)

This is enforced **entirely in Hasura's permission config**, not in
application code. Every table's select/insert/update/delete permission for
every role must include a check that the row's org matches the caller's org
membership — role alone is never sufficient.

Setup:
- nhost Auth sets `X-Hasura-User-Id` on every request. Use a Hasura
  **permission preset / custom session variable** or a Postgres function to
  resolve `X-Hasura-User-Id` → the set of `(org_id, role)` pairs from
  `org_members`.
- Define three Hasura roles: `owner`, `editor`, `viewer`. (Determine the
  role per-request from `org_members` — e.g. via a `session_argument` /
  webhook, or simpler: always authenticate as a generic `user` role and let
  every permission's `check`/`filter` join through `org_members` on
  `X-Hasura-User-Id` directly instead of relying on a static Hasura role.
  **Recommended**: use the single `user` Hasura role + relationship-based
  filters, because role can change per-org and Hasura roles are static per
  JWT — modeling role as data queried through `org_members`, not as the
  Hasura role itself, avoids re-issuing JWTs when someone's role changes.)

Example `select` permission on `workflows` for role `user`:

```yaml
filter:
  org:
    org_members:
      user_id:
        _eq: X-Hasura-User-Id
```

Example `insert` permission on `workflows` (must be owner or editor):

```yaml
check:
  org:
    org_members:
      _and:
        - user_id: { _eq: X-Hasura-User-Id }
        - role: { _in: [owner, editor] }
```

Apply the same pattern — filter/check through `org_members` — to
`workflow_steps`, `workflow_triggers`, `workflow_runs`, and `step_runs`
(each joins back to `org_id` through its parent). `viewer` gets `select`
only, everywhere. Only `owner` gets insert/update/delete on `org_members`
itself (membership management).

**Cross-org isolation test you must be able to pass:** an editor
authenticated for Org A, given the raw UUID of an Org B workflow, run, or
step, gets zero rows back from any query, mutation, or subscription — not a
403, just an empty result, because the row is outside their permission
filter. Test this explicitly, by ID, before considering this layer done.

---

## 4. Permission Layer 2 — step-level gating (application code)

This layer **cannot** live in Hasura's declarative permissions because it's
either (a) a restriction on which step *types* a role may author, layered on
top of the Layer 1 check, or (b) a decision made mid-execution by the Action
handler, not a static row permission.

**(a) Step-type authoring restriction** — enforce in the `insert` permission
on `workflow_steps`/`workflow_triggers` with a conditional check, OR (cleaner)
via a Postgres check constraint + a `BEFORE INSERT` trigger function that
raises an exception if `type in ('db_write', 'notify')` (steps) or
`type = 'webhook'` (triggers) and the inserting user's role in that org is
not `owner`. Document whichever approach you pick and why — a DB trigger is
more defense-in-depth (holds even if someone bypasses Hasura), a Hasura
permission is simpler to reason about. Prefer the DB trigger for this one,
since "someone reaches the database another way" is exactly the case Layer 2
exists for.

**(b) Approval-gate resume** — this is **only** enforced inside the
`approveStep` Action handler (see §6). It is fundamentally not a row
permission: "may this user write `approved_by = me`" is a static check, but
"is this specific run actually paused on this specific step, and does this
user's *current* role in *this* org qualify them to clear it" is a business
rule evaluated against live state at call time. Implement it as:

```
approveStep(step_run_id):
  1. load step_run + its workflow_run + workflow + org
  2. reject if step_run.status != 'paused_awaiting_approval'
  3. look up caller's role in org_members for that org
  4. reject (403) if role not in ('owner', 'editor')
  5. set approved_by, approved_at on step_run; set status = 'succeeded'
  6. set workflow_run.status back to 'running'
  7. resume execution from the next step (see §6)
```

State the "why" explicitly in your write-up: a Hasura `update` permission
on `step_runs` could let someone flip `status`, but it can't express "and
also atomically continue running the rest of the workflow" — that's a
side-effecting operation, which is exactly what Actions are for.

---

## 5. GraphQL operations to expose

- **Query**: `org_workflows(org_id)` — workflow with nested `workflow_steps`,
  `workflow_triggers`, and the latest `workflow_runs` row (order by
  `started_at desc limit 1` via a Hasura relationship or a Postgres view).
- **Mutation**: `insert_workflows` (+ nested steps/triggers via Hasura's
  nested insert, or three separate mutations run in a client-side
  transaction-like sequence) to create/edit a workflow.
- **Action mutation**: `triggerWorkflowRun(workflow_id: uuid!)` → see §6.
- **Action mutation**: `approveStep(step_run_id: uuid!)` → see §4b/§6.
- **Subscription**: `step_runs(where: {workflow_run_id: {_eq: $id}})`
  ordered by the parent step's `step_order`, so the frontend gets a live
  ordered list including `paused_awaiting_approval`.

---

## 6. The core integration — `triggerWorkflowRun` Action

This is graded as the center of the assignment. Implement as an nhost
Function backing a Hasura Action.

```
triggerWorkflowRun(workflow_id):
  1. Resolve caller's org via workflow_id → workflows.org_id
  2. Look up caller's role in org_members for that org
     → reject (403) unless role in ('owner', 'editor')
  3. Load organizations row, check quota_calls_used < quota_calls_allowed
     → reject (402/429-equivalent) if exhausted
  4. Create workflow_runs row: status = 'running', trigger_type = <caller-supplied>
  5. Load workflow_steps ordered by step_order
  6. For each step:
       a. Create step_runs row: status = 'running', input = <prev output or trigger payload>
       b. Execute by type:
          - llm_call: call the real LLM API with config + input; on failure, retry once
            with backoff before marking failed
          - http_request: call config.url with config.method/body; same retry policy
          - db_write: write output into your own table (e.g. a results table), scoped to org
          - notify: fire an Event Trigger payload (see below) rather than calling
            Slack/email directly from this loop — decouples notify from the run's
            critical path and matches the "notify as an Event Trigger" requirement
          - conditional_branch: evaluate config.condition against the previous
            step's output; select the next step index accordingly (skip/jump, don't
            just log-and-continue)
          - approval_gate: set step_run.status = 'paused_awaiting_approval',
            set workflow_run.status = 'paused', STOP this execution — do not
            proceed to further steps. Execution resumes later via approveStep.
       c. On step success: status = 'succeeded', output = result, continue loop
       d. On step failure after retry: status = 'failed', workflow_run.status = 'failed', STOP
  7. If loop completes fully: workflow_run.status = 'succeeded', finished_at = now()
  8. Increment organizations.quota_calls_used (do this once per run, or per
     external call — decide and document which; per external call is more
     accurate but means updating quota inside the loop, not just at the end)
```

Resuming after `approveStep` re-enters this same loop starting at
`step_order + 1` of the approved step — don't duplicate the execution logic;
factor it into a shared `runFromStep(workflow_run_id, start_index)` so
manual-start and resume-after-approval share one code path.

**Retry policy**: at minimum, one retry with a short delay on `llm_call` and
`http_request` failures; increment `attempt_count` on every attempt; only
mark the step (and the run) `failed` after retries are exhausted.

**Why this has to be an Action, not a plain mutation**: it needs to run
privileged server-side logic (calling external APIs, mutating quota,
sequencing multiple table writes as one unit, checking role beyond a static
row filter) that a client should never be trusted to orchestrate itself.

---

## 7. Triggers beyond manual (implement at least one, ideally two)

- **Webhook**: a Hasura Action (or REST endpoint on your nhost Function)
  `POST /webhook/:workflow_id` that, after validating a shared secret from
  `workflow_triggers.config`, calls the same `triggerWorkflowRun` logic with
  `trigger_type = 'webhook'`.
- **Scheduled**: an nhost **scheduled function** reading `workflow_triggers`
  where `type = 'scheduled'` and `is_enabled`, matching `config.cron`
  against current time, calling `triggerWorkflowRun` for each match.
- **Database event**: a Hasura **Event Trigger** on the watched table
  (`config.watch_table`) that POSTs to a Function which resolves the
  matching `workflow_triggers` row and calls `triggerWorkflowRun` with
  `trigger_type = 'db_event'`.

Pick **webhook or event-based** as your primary "beyond manual" proof for
the final scenario — a webhook is the easiest to demo live with a `curl`
call.

---

## 8. Frontend (Next.js)

- **Auth**: nhost Auth React SDK; after login, resolve the user's orgs +
  roles and hold "current org" in context.
- **Workflow builder screen**: list/create workflows; per workflow, an
  ordered step editor (add/remove/reorder steps, pick `type`, edit `config`
  as structured fields per type — not just a raw JSON textarea, though a
  JSON fallback is fine for `config` internals) and a trigger attachment
  panel.
- **Run button**: visible only to `owner`/`editor` (hide for `viewer` —
  enforce in UI *and* rely on the Action's own role check as the real
  boundary, since the UI check is cosmetic).
- **Run view**: subscribe to `step_runs` for the active `workflow_run_id`;
  render each step's live status; when a step is
  `paused_awaiting_approval`, show an **Approve** button (visible only to
  `owner`/`editor`) that calls `approveStep`.
- **Quota indicator**: show `quota_calls_used / quota_calls_allowed` for the
  current org, sourced from the `org_usage_this_month` view.

---

## 9. Final acceptance scenario — build and rehearse this exactly

This is what gets demoed live and is weighted above everything else. Don't
treat it as a checklist to satisfy after the fact — build toward it from the
start.

1. Two organizations exist (Org A, Org B), each with its own users/roles.
2. In Org A, an owner builds a workflow with ≥3 step types: one `llm_call`,
   one `http_request`, one `conditional_branch` whose branch outcome
   visibly differs based on the LLM step's actual output (not hardcoded).
3. The workflow starts two ways: (a) clicking Run, and (b) a webhook or
   event trigger, without a button click.
4. One step is an `approval_gate`. The run visibly pauses; only an
   owner/editor in Org A can approve it forward (test that a Org B
   owner/editor **cannot**).
5. While running, the frontend shows live step-by-step status with no
   manual refresh, including the paused state rendering distinctly.
6. Logged in as an Org B user, attempt to view, trigger, and approve
   anything belonging to Org A — including by directly editing the URL/ID
   to Org A's known workflow/run/step IDs — and confirm every attempt comes
   back empty/denied.

---

## 10. Repo structure (suggested)

```
/
├── README.md                  (this file)
├── WRITEUP.md                 (~1 page: schema reasoning, how the two
│                                permission layers differ, pause/resume design)
├── hasura/
│   ├── migrations/             (schema as SQL migrations)
│   └── metadata/                (tracked tables, relationships, permissions,
│                                 actions, event triggers — exported via
│                                 `hasura metadata export`)
├── functions/                  (nhost serverless functions: triggerWorkflowRun,
│                                approveStep, scheduled-trigger-runner,
│                                webhook handler, db-event handler)
└── web/                        (Next.js app)
```

---

## 11. Local setup (fill in as you build)

```bash
# 1. Install nhost CLI, run locally
npx nhost up

# 2. Apply migrations + metadata
nhost hasura migrate apply --database-name default
nhost hasura metadata apply

# 3. Env vars (functions/.env and web/.env.local)
LLM_API_KEY=...            # Groq / OpenRouter / Gemini — or omit and set LLM_STUBBED=true
HTTP_STEP_TARGET_URL=...   # optional default target for http_request steps
WEBHOOK_SHARED_SECRET=...
NHOST_SUBDOMAIN=...
NHOST_REGION=...

# 4. Run the frontend
cd web && npm install && npm run dev
```

If no real LLM key is available, set `LLM_STUBBED=true` and implement the
`llm_call` handler with a `setTimeout` delay (document the delay length) and
a clearly-labeled stub response — never silently fabricate a "real" call.

---

## 12. Build order (recommended, for working under time pressure)

1. Schema + migrations (§2) — get this right first, everything depends on it
2. Hasura relationships + Layer 1 permissions (§3) — verify cross-org
   isolation manually via the Hasura console before writing any frontend
3. `triggerWorkflowRun` Action, manual trigger only, all 6 step types,
   no approval pause yet — prove the happy path end to end
4. Add `approval_gate` pause + `approveStep` Action (§4b, §6)
5. Add one non-manual trigger (§7) — webhook is fastest to demo
6. Frontend: auth → workflow builder → run + subscription view →
   approve UI → quota indicator
7. Rehearse the full scenario in §9 end to end, across two real org/user
   accounts, before recording
8. Write `WRITEUP.md`, record the walkthrough, deploy, submit

---

## 13. Deliverables checklist

- [ ] GitHub repo, README (this doc, filled in) covering setup/run
- [ ] Hosted Next.js app URL (Vercel or similar)
- [ ] Hasura metadata + migrations in repo (schema, relationships, both
      permission layers, actions, event triggers)
- [ ] `WRITEUP.md` (~1 page): schema reasoning, how the two permission
      layers are enforced differently, how pause/resume works
- [ ] Recording of the §9 scenario actually happening live
