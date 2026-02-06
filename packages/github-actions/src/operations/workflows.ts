import type { GitHubClient } from '../client.js';
import type { WorkflowRun, TriggerWorkflowParams } from '../types/workflows.js';
import { WorkflowNotFoundError } from '../utils/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Map Octokit workflow run response to our WorkflowRun type
 */
function mapWorkflowRun(run: any): WorkflowRun {
  return {
    id: run.id,
    name: run.name ?? '',
    path: run.path ?? '',
    head_branch: run.head_branch ?? '',
    head_sha: run.head_sha ?? '',
    status: (run.status as WorkflowRun['status']) ?? 'queued',
    conclusion: run.conclusion as WorkflowRun['conclusion'],
    html_url: run.html_url ?? '',
    created_at: run.created_at ?? '',
    updated_at: run.updated_at ?? '',
    run_started_at: run.run_started_at ?? null,
    actor: run.actor
      ? {
          id: run.actor.id,
          login: run.actor.login,
          avatar_url: run.actor.avatar_url ?? '',
          type: (run.actor.type as 'User' | 'Bot') ?? 'User',
        }
      : {
          id: 0,
          login: 'unknown',
          avatar_url: '',
          type: 'User',
        },
    event: run.event ?? '',
    run_attempt: run.run_attempt ?? 1,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Trigger a workflow by workflow file name or ID
 *
 * @param client - GitHub API client
 * @param params - Workflow trigger parameters
 * @returns The newly created workflow run
 */
export async function triggerWorkflow(
  client: GitHubClient,
  params: TriggerWorkflowParams
): Promise<WorkflowRun> {
  const owner = client.getOwner();
  const repo = client.getRepo();
  const workflow = params.workflow;
  const ref = params.ref ?? 'main';

  try {
    // Trigger the workflow dispatch event
    await client.request((octokit) =>
      octokit.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: workflow,
        ref,
        inputs: params.inputs,
      })
    );

    // Wait a moment for the run to be created
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Fetch the latest run for this workflow
    const runs = await client.request((octokit) =>
      octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflow,
        event: 'workflow_dispatch',
        per_page: 1,
      })
    );

    if (runs.workflow_runs.length === 0) {
      throw new WorkflowNotFoundError(String(workflow));
    }

    const latestRun = runs.workflow_runs[0];
    if (!latestRun) {
      throw new WorkflowNotFoundError(String(workflow));
    }

    return mapWorkflowRun(latestRun);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Not Found')
    ) {
      throw new WorkflowNotFoundError(String(workflow), error);
    }
    throw error;
  }
}

/**
 * Trigger a workflow dispatch event
 *
 * @param client - GitHub API client
 * @param workflow - Workflow file name or ID
 * @param ref - Git ref (branch/tag)
 * @param inputs - Workflow inputs
 * @returns The newly created workflow run
 */
export async function triggerWorkflowDispatch(
  client: GitHubClient,
  workflow: string,
  ref: string,
  inputs?: Record<string, string>
): Promise<WorkflowRun> {
  return triggerWorkflow(client, { workflow, ref, inputs });
}

/**
 * Get workflow ID by filename
 */
export async function getWorkflowId(
  client: GitHubClient,
  filename: string
): Promise<number> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  const workflows = await client.request((octokit) =>
    octokit.rest.actions.listRepoWorkflows({
      owner,
      repo,
    })
  );

  const workflow = workflows.workflows.find(
    (w) => w.path.endsWith(filename) || w.name === filename
  );

  if (!workflow) {
    throw new WorkflowNotFoundError(filename);
  }

  return workflow.id;
}
