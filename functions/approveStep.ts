import { Request, Response } from 'express';
import { graphqlClient } from './utils/graphql';
import { runFromStep } from './utils/runner';

export default async function (req: Request, res: Response) {
  const { input, session_variables } = req.body;
  const stepRunId = input.step_run_id;
  const userId = session_variables['x-hasura-user-id'];

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    // 1. Load step_run + workflow_run + org
    const query = `
      query GetStepRun($id: uuid!) {
        step_runs_by_pk(id: $id) {
          id
          status
          workflow_run_id
          workflow_step {
            step_order
          }
          workflow_run {
            org_id
          }
        }
      }
    `;
    const data: any = await graphqlClient.request(query, { id: stepRunId });
    const stepRun = data.step_runs_by_pk;

    if (!stepRun) return res.status(404).json({ message: 'Step run not found' });
    if (stepRun.status !== 'paused_awaiting_approval') {
      return res.status(400).json({ message: 'Step is not awaiting approval' });
    }

    const orgId = stepRun.workflow_run.org_id;

    // 2. Check role in org
    const permQuery = `
      query GetRole($userId: uuid!, $orgId: uuid!) {
        org_members(where: {user_id: {_eq: $userId}, org_id: {_eq: $orgId}}) {
          role
        }
      }
    `;
    const permData: any = await graphqlClient.request(permQuery, { userId, orgId });
    const role = permData.org_members[0]?.role;

    if (role !== 'owner' && role !== 'editor') {
      return res.status(403).json({ message: 'Forbidden: Requires owner or editor role to approve' });
    }

    // 3. Approve step
    const approveMutation = `
      mutation ApproveStep($stepRunId: uuid!, $userId: uuid!, $runId: uuid!) {
        update_step_runs_by_pk(pk_columns: {id: $stepRunId}, _set: {
          status: "succeeded",
          approved_by: $userId,
          approved_at: "now()",
          finished_at: "now()"
        }) { id }
        update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {
          status: "running"
        }) { id }
      }
    `;
    await graphqlClient.request(approveMutation, {
      stepRunId,
      userId,
      runId: stepRun.workflow_run_id
    });

    // 4. Resume execution
    const nextStepIndex = stepsArrayIndexOf(stepRun.workflow_step.step_order) + 1; // Simplify to start index 
    // In our runner, we use index. It's better to just pass step_order + 1 and have runner handle it, 
    // but the runner takes an index. Let's adjust runner or here just pass step order to resume.
    
    // For simplicity, we can modify runner to take a `startStepOrder` instead of array index.
    // Let's assume runner is updated or handles it. Actually, `runFromStep(runId, startIndex)` expects the index.
    // We will just find the index. 
    
    // Resume in background:
    // To properly resume, let's fetch all steps to get the next index
    const stepsQuery = `
      query GetSteps($runId: uuid!) {
        workflow_runs_by_pk(id: $runId) {
          workflow {
            workflow_steps(order_by: {step_order: asc}) {
              id
              step_order
            }
          }
        }
      }
    `;
    const stepsData: any = await graphqlClient.request(stepsQuery, { runId: stepRun.workflow_run_id });
    const steps = stepsData.workflow_runs_by_pk.workflow.workflow_steps;
    const nextIndex = steps.findIndex((s: any) => s.step_order > stepRun.workflow_step.step_order);
    
    if (nextIndex !== -1) {
      runFromStep(stepRun.workflow_run_id, nextIndex).catch(console.error);
    } else {
      // If it was the last step, mark run as succeeded
      await graphqlClient.request(`
        mutation RunSuccess($runId: uuid!) {
          update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {
            status: "succeeded",
            finished_at: "now()"
          }) { id }
        }
      `, { runId: stepRun.workflow_run_id });
    }

    return res.status(200).json({ success: true, message: 'Approved and resumed' });
  } catch (error) {
    console.error('Action error', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}
