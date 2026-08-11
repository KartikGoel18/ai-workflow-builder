# AI Agent Workflow Builder Writeup

## Schema Reasoning

The schema was designed to keep the core entities—`organizations`, `workflows`, `workflow_steps`, and runs—tightly coupled to a single `org_id` root. By denormalizing `org_id` onto `workflow_runs`, we enable Hasura to filter runs strictly based on the user's organization membership without deep joins.

This denormalization directly powers Permission Layer 1. The `org_usage_this_month` view relies on this denormalized structure to safely aggregate usage across the entire organization without bypassing row-level filters.

## Two Permission Layers

### Layer 1: Declarative Scoping
Hasura's row-level permissions enforce cross-tenant isolation.
We enforce this by mapping the session variable `x-hasura-user-id` against the `org_members` table on every query. If an editor belonging to Org A attempts to query or subscribe to Org B's workflow runs, Hasura intercepts the query at the AST level, applies the `org_id` filter natively in Postgres, and returns zero rows instead of a 403 error. 

### Layer 2: Business Logic Gates
Not all authorization can be modeled declaratively as row-level data access constraints.
We have two rules requiring Layer 2 implementation:
1. **Authoring Restrictions:** Only owners can create `db_write` and `notify` steps, or `webhook` triggers. This is enforced using a PostgreSQL `BEFORE INSERT` trigger function (`restrict_step_and_trigger_authors`). If the operation fails, it throws an exception natively in the database, preventing bypassing even if someone directly connects to Postgres.
2. **Approval Gating:** The ability to unpause a workflow requires checking the `paused_awaiting_approval` state atomically and verifying the current role of the caller at the exact moment of approval. This is implemented in the `approveStep` Nhost Serverless Function because it involves side-effects (resuming execution, incrementing attempt counts, logging), which cannot be done cleanly in a simple Hasura `UPDATE` permission.

## Pause & Resume Architecture

The execution engine (`triggerWorkflowRun` and `approveStep`) models workflow runs as a state machine. The function `runFromStep(runId, startIndex)` sequences through steps.
When an `approval_gate` step is encountered, it explicitly marks the step and the workflow run as `paused` and terminates the Node.js function execution completely. 
Later, when `approveStep` is invoked, it updates the state, computes the next execution index, and re-invokes `runFromStep(runId, nextIndex)` in the background. This architecture is stateless, preventing zombie processes or memory leaks while workflows await human input for days.
