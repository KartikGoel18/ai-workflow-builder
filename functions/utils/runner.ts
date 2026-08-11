import { graphqlClient } from './graphql';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function executeStep(step: any, input: any) {
  const type = step.type;
  const config = step.config;

  switch (type) {
    case 'llm_call':
      // Stub LLM call
      await delay(2000);
      return { response: 'STUBBED LLM RESPONSE: This is a generated response based on ' + JSON.stringify(input) };
      
    case 'http_request':
      const method = config.method || 'GET';
      const url = config.url;
      let attempt = 0;
      while (attempt < 2) {
        try {
          const res = await fetch(url, {
            method,
            headers: config.headers || { 'Content-Type': 'application/json' },
            body: method !== 'GET' ? JSON.stringify(config.body || input) : undefined,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        } catch (e: any) {
          attempt++;
          if (attempt >= 2) throw e;
          await delay(1000);
        }
      }
      break;

    case 'db_write':
      // Write to an audit log or dummy table
      return { success: true, written: input };

    case 'notify':
      // Fire an event trigger (simplified as returning success for webhook pickup)
      return { success: true, notify_payload: input };

    case 'conditional_branch':
      // Evaluate condition (e.g. config.condition = "$.response.includes('STUBBED')")
      // config.true_step_order, config.false_step_order
      const val = JSON.stringify(input);
      const isTrue = val.includes(config.keyword || 'STUBBED');
      return { branch: isTrue ? 'true' : 'false', next_step: isTrue ? config.true_step_order : config.false_step_order };

    case 'approval_gate':
      // Special handled outside execution
      return null;

    default:
      throw new Error(`Unknown step type ${type}`);
  }
}

export async function runFromStep(runId: string, startIndex: number, initialInput: any = {}) {
  // Load workflow run and steps
  const query = `
    query GetRunAndSteps($runId: uuid!) {
      workflow_runs_by_pk(id: $runId) {
        id
        workflow_id
        org_id
        status
        workflow {
          workflow_steps(order_by: {step_order: asc}) {
            id
            step_order
            type
            config
          }
        }
      }
    }
  `;
  const runData: any = await graphqlClient.request(query, { runId });
  const run = runData.workflow_runs_by_pk;
  if (!run || run.status === 'failed' || run.status === 'succeeded') return;

  const steps = run.workflow.workflow_steps;
  let currentInput = initialInput;
  let currentIndex = startIndex;

  while (currentIndex < steps.length) {
    const step = steps[currentIndex];

    // Create step_runs row
    const createStepRunMutation = `
      mutation CreateStepRun($runId: uuid!, $stepId: uuid!, $input: jsonb!) {
        insert_step_runs_one(object: {
          workflow_run_id: $runId,
          workflow_step_id: $stepId,
          status: "running",
          input: $input,
          started_at: "now()"
        }) {
          id
        }
      }
    `;
    const stepRunData: any = await graphqlClient.request(createStepRunMutation, {
      runId,
      stepId: step.id,
      input: currentInput
    });
    const stepRunId = stepRunData.insert_step_runs_one.id;

    if (step.type === 'approval_gate') {
      // Pause
      await graphqlClient.request(`
        mutation PauseRun($runId: uuid!, $stepRunId: uuid!) {
          update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {status: "paused"}) { id }
          update_step_runs_by_pk(pk_columns: {id: $stepRunId}, _set: {status: "paused_awaiting_approval"}) { id }
        }
      `, { runId, stepRunId });
      return; // Execution stops here, wait for approveStep
    }

    try {
      const output = await executeStep(step, currentInput);
      
      // Update step success
      await graphqlClient.request(`
        mutation StepSuccess($stepRunId: uuid!, $output: jsonb!) {
          update_step_runs_by_pk(pk_columns: {id: $stepRunId}, _set: {
            status: "succeeded",
            output: $output,
            finished_at: "now()"
          }) { id }
        }
      `, { stepRunId, output });

      currentInput = output;

      // Handle conditional branch
      if (step.type === 'conditional_branch' && output?.next_step !== undefined) {
        const nextIndex = steps.findIndex((s: any) => s.step_order === output.next_step);
        if (nextIndex !== -1) {
          currentIndex = nextIndex;
          continue;
        }
      }

      currentIndex++;
    } catch (e: any) {
      // Handle failure
      await graphqlClient.request(`
        mutation StepFailed($runId: uuid!, $stepRunId: uuid!, $error: String!) {
          update_step_runs_by_pk(pk_columns: {id: $stepRunId}, _set: {
            status: "failed",
            error: $error,
            finished_at: "now()"
          }) { id }
          update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {
            status: "failed",
            finished_at: "now()"
          }) { id }
        }
      `, { runId, stepRunId, error: e.message });
      return; // Stop on failure
    }
  }

  // Finished all steps successfully
  await graphqlClient.request(`
    mutation RunSuccess($runId: uuid!, $orgId: uuid!) {
      update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {
        status: "succeeded",
        finished_at: "now()"
      }) { id }
      update_organizations_by_pk(pk_columns: {id: $orgId}, _inc: {quota_calls_used: 1}) { id }
    }
  `, { runId, orgId: run.org_id });
}
