import { Request, Response } from 'express';
import { graphqlClient } from './graphql';
import { runFromStep } from './runner';

export default async function (req: Request, res: Response) {
  const { input, session_variables } = req.body;
  const workflowId = input.workflow_id;
  const userId = session_variables['x-hasura-user-id'];

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    // 1. Resolve workflow and org
    const workflowQuery = `
      query GetWorkflow($id: uuid!) {
        workflows_by_pk(id: $id) {
          id
          org_id
        }
      }
    `;
    const workflowData: any = await graphqlClient.request(workflowQuery, { id: workflowId });
    const workflow = workflowData.workflows_by_pk;
    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

    const orgId = workflow.org_id;

    // 2. Check permissions
    const permQuery = `
      query GetRole($userId: uuid!, $orgId: uuid!) {
        org_members(where: {user_id: {_eq: $userId}, org_id: {_eq: $orgId}}) {
          role
        }
        organizations_by_pk(id: $orgId) {
          quota_calls_used
          quota_calls_allowed
        }
      }
    `;
    const permData: any = await graphqlClient.request(permQuery, { userId, orgId });
    const role = permData.org_members[0]?.role;
    
    if (role !== 'owner' && role !== 'editor') {
      return res.status(403).json({ message: 'Forbidden: Requires owner or editor role' });
    }

    const org = permData.organizations_by_pk;
    if (org.quota_calls_used >= org.quota_calls_allowed) {
      return res.status(402).json({ message: 'Quota exhausted' });
    }

    // 4. Create workflow run
    const createRunMutation = `
      mutation CreateRun($workflowId: uuid!, $orgId: uuid!, $userId: uuid!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflowId,
          org_id: $orgId,
          triggered_by_user_id: $userId,
          trigger_type: "manual",
          status: "running"
        }) {
          id
        }
      }
    `;
    const createRunData: any = await graphqlClient.request(createRunMutation, {
      workflowId,
      orgId,
      userId
    });
    const runId = createRunData.insert_workflow_runs_one.id;

    // Trigger async execution so the HTTP response is fast
    // In a real environment, you'd use a queue, but here we just don't await the runner.
    runFromStep(runId, 0).catch(console.error);

    return res.status(200).json({ id: runId, status: 'running' });
  } catch (error) {
    console.error('Action error', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}
