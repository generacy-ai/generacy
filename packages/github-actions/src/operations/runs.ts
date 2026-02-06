import type { GitHubClient } from '../client.js';
import type { WorkflowRun } from '../types/workflows.js';
import { RunNotFoundError } from '../utils/errors.js';

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
 * Get a specific workflow run by ID
 *
 * @param client - GitHub API client
 * @param runId - Workflow run ID
 * @returns The workflow run
 */
export async function getWorkflowRun(
  client: GitHubClient,
  runId: number
): Promise<WorkflowRun> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    const run = await client.request((octokit) =>
      octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      })
    );

    return mapWorkflowRun(run);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new RunNotFoundError(runId, error);
    }
    throw error;
  }
}

/**
 * List workflow runs for a workflow
 *
 * @param client - GitHub API client
 * @param workflow - Workflow file name or ID
 * @param options - List options
 * @returns Array of workflow runs
 */
export async function listWorkflowRuns(
  client: GitHubClient,
  workflow: string | number,
  options?: {
    branch?: string;
    event?: string;
    status?: 'completed' | 'action_required' | 'cancelled' | 'failure' | 'neutral' | 'skipped' | 'stale' | 'success' | 'timed_out' | 'in_progress' | 'queued' | 'requested' | 'waiting' | 'pending';
    per_page?: number;
    page?: number;
  }
): Promise<WorkflowRun[]> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  const runs = await client.request((octokit) =>
    octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflow,
      branch: options?.branch,
      event: options?.event,
      status: options?.status,
      per_page: options?.per_page ?? 30,
      page: options?.page ?? 1,
    })
  );

  return runs.workflow_runs.map(mapWorkflowRun);
}

/**
 * Cancel a workflow run
 *
 * @param client - GitHub API client
 * @param runId - Workflow run ID
 */
export async function cancelWorkflowRun(
  client: GitHubClient,
  runId: number
): Promise<void> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    await client.request((octokit) =>
      octokit.rest.actions.cancelWorkflowRun({
        owner,
        repo,
        run_id: runId,
      })
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new RunNotFoundError(runId, error);
    }
    throw error;
  }
}

/**
 * Re-run a workflow run
 *
 * @param client - GitHub API client
 * @param runId - Workflow run ID
 * @returns The new workflow run
 */
export async function rerunWorkflowRun(
  client: GitHubClient,
  runId: number
): Promise<WorkflowRun> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    await client.request((octokit) =>
      octokit.rest.actions.reRunWorkflow({
        owner,
        repo,
        run_id: runId,
      })
    );

    // Wait a moment for the rerun to be created
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Fetch the updated run
    return getWorkflowRun(client, runId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new RunNotFoundError(runId, error);
    }
    throw error;
  }
}

/**
 * Re-run failed jobs in a workflow run
 *
 * @param client - GitHub API client
 * @param runId - Workflow run ID
 * @returns The updated workflow run
 */
export async function rerunFailedJobs(
  client: GitHubClient,
  runId: number
): Promise<WorkflowRun> {
  const owner = client.getOwner();
  const repo = client.getRepo();

  try {
    await client.request((octokit) =>
      octokit.rest.actions.reRunWorkflowFailedJobs({
        owner,
        repo,
        run_id: runId,
      })
    );

    // Wait a moment for the rerun to be created
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Fetch the updated run
    return getWorkflowRun(client, runId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Not Found')) {
      throw new RunNotFoundError(runId, error);
    }
    throw error;
  }
}
