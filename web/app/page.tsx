'use client';

import { useAuthenticationStatus, useUserData } from '@nhost/react';
import { useQuery, useSubscription, useMutation } from 'urql';
import { useState } from 'react';

const GET_WORKFLOWS = `
  query GetWorkflows {
    workflows {
      id
      name
      workflow_steps(order_by: {step_order: asc}) {
        id
        step_order
        type
        config
      }
    }
  }
`;

const SUB_RUNS = `
  subscription SubRuns($workflowId: uuid!) {
    workflow_runs(where: {workflow_id: {_eq: $workflowId}}, order_by: {started_at: desc}, limit: 1) {
      id
      status
      step_runs(order_by: {workflow_step: {step_order: asc}}) {
        id
        status
        output
        workflow_step {
          type
          step_order
        }
      }
    }
  }
`;

const TRIGGER_RUN = `
  mutation TriggerRun($workflowId: uuid!) {
    triggerWorkflowRun(workflow_id: $workflowId) {
      id
      status
    }
  }
`;

const APPROVE_STEP = `
  mutation ApproveStep($stepRunId: uuid!) {
    approveStep(step_run_id: $stepRunId) {
      success
    }
  }
`;

export default function Dashboard() {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const user = useUserData();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  const [workflowsResult] = useQuery({ query: GET_WORKFLOWS, pause: !isAuthenticated });
  const [triggerRunResult, triggerRun] = useMutation(TRIGGER_RUN);
  const [approveStepResult, approveStep] = useMutation(APPROVE_STEP);

  const [runsResult] = useSubscription({
    query: SUB_RUNS,
    variables: { workflowId: selectedWorkflowId },
    pause: !selectedWorkflowId
  });

  if (isLoading) return <div>Loading...</div>;
  if (!isAuthenticated) return <div>Please login first</div>;

  const workflows = workflowsResult.data?.workflows || [];
  const latestRun = runsResult.data?.workflow_runs?.[0];

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">AI Agent Workflow Builder</h1>
      <div className="mb-8">
        <h2 className="text-xl">Workflows</h2>
        {workflows.map((wf: any) => (
          <div key={wf.id} className="border p-4 mb-2">
            <h3 className="font-bold">{wf.name}</h3>
            <button 
              className="bg-blue-500 text-white px-4 py-2 mt-2 mr-2"
              onClick={() => setSelectedWorkflowId(wf.id)}
            >
              View Run Dashboard
            </button>
            <button 
              className="bg-green-500 text-white px-4 py-2 mt-2"
              onClick={() => triggerRun({ workflowId: wf.id })}
            >
              Run Workflow
            </button>
          </div>
        ))}
      </div>

      {selectedWorkflowId && (
        <div>
          <h2 className="text-xl font-bold">Latest Run Dashboard</h2>
          {!latestRun ? (
            <p>No runs yet.</p>
          ) : (
            <div className="border p-4 mt-2">
              <p>Run Status: {latestRun.status}</p>
              <div className="mt-4">
                <h3 className="font-bold">Steps:</h3>
                {latestRun.step_runs.map((stepRun: any) => (
                  <div key={stepRun.id} className="border p-2 my-2 bg-gray-50">
                    <p>Step {stepRun.workflow_step.step_order}: {stepRun.workflow_step.type}</p>
                    <p>Status: <span className="font-semibold">{stepRun.status}</span></p>
                    {stepRun.status === 'paused_awaiting_approval' && (
                      <button 
                        className="bg-red-500 text-white px-4 py-2 mt-2"
                        onClick={() => approveStep({ stepRunId: stepRun.id })}
                      >
                        Approve
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
