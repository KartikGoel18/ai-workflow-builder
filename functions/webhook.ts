import { Request, Response } from 'express';
import { graphqlClient } from './utils/graphql';
import { runFromStep } from './utils/runner';

export default async function (req: Request, res: Response) {
  const workflowId = req.query.workflow_id as string;
  const secret = req.headers['x-webhook-secret'];

  if (!workflowId) {
    return res.status(400).json({ message: 'Missing workflow_id' });
  }

  try {
    // 1. Get workflow and its webhook trigger
    const query = `
      query GetWebhookTrigger($workflowId: uuid!) {
        workflows_by_pk(id: $workflowId) {
          id
          org_id
          is_active
          workflow_triggers(where: {type: {_eq: "webhook"}, is_enabled: {_eq: true}}) {
            id
            config
          }
        }
      }
    `;
    const data: any = await graphqlClient.request(query, { workflowId });
    const workflow = data.workflows_by_pk;

    if (!workflow || !workflow.is_active) {
      return res.status(404).json({ message: 'Workflow not found or inactive' });
    }

    if (workflow.workflow_triggers.length === 0) {
      return res.status(404).json({ message: 'No enabled webhook trigger for this workflow' });
    }

    const trigger = workflow.workflow_triggers[0];
    const expectedSecret = trigger.config.secret;

    if (expectedSecret && secret !== expectedSecret) {
      return res.status(401).json({ message: 'Unauthorized webhook' });
    }

    const orgId = workflow.org_id;

    // 2. Check Quota
    const orgQuery = `
      query GetOrg($orgId: uuid!) {
        organizations_by_pk(id: $orgId) {
          quota_calls_used
          quota_calls_allowed
        }
      }
    `;
    const orgData: any = await graphqlClient.request(orgQuery, { orgId });
    const org = orgData.organizations_by_pk;

    if (org.quota_calls_used >= org.quota_calls_allowed) {
      return res.status(402).json({ message: 'Quota exhausted' });
    }

    // 3. Create run
    const createRunMutation = `
      mutation CreateRun($workflowId: uuid!, $orgId: uuid!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflowId,
          org_id: $orgId,
          trigger_type: "webhook",
          status: "running"
        }) {
          id
        }
      }
    `;
    const createRunData: any = await graphqlClient.request(createRunMutation, {
      workflowId,
      orgId
    });
    const runId = createRunData.insert_workflow_runs_one.id;

    // 4. Start execution with the webhook payload as initial input
    runFromStep(runId, 0, req.body).catch(console.error);

    return res.status(200).json({ success: true, run_id: runId });
  } catch (error) {
    console.error('Webhook error', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}
