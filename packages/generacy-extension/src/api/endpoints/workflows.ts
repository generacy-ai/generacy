/**
 * Workflow publishing API endpoints for Generacy cloud API.
 * Provides methods for publishing workflows and managing versions.
 */
import { z } from 'zod';
import { getApiClient } from '../client';
import {
  PublishedWorkflowSchema,
  WorkflowVersionSchema,
  PublishWorkflowResponseSchema,
  type PublishedWorkflow,
  type WorkflowVersion,
  type PublishWorkflowRequest,
  type PublishWorkflowResponse,
} from '../types/workflows';

// ============================================================================
// API Functions
// ============================================================================

/**
 * Publish a workflow to the cloud
 */
export async function publishWorkflow(request: PublishWorkflowRequest): Promise<PublishWorkflowResponse> {
  const client = getApiClient();
  const response = await client.postValidated('/workflows/publish', PublishWorkflowResponseSchema, request);
  return response.data;
}

/**
 * Get published workflow details by name
 */
export async function getPublishedWorkflow(name: string): Promise<PublishedWorkflow> {
  const client = getApiClient();
  const response = await client.getValidated(`/workflows/${encodeURIComponent(name)}`, PublishedWorkflowSchema);
  return response.data;
}

/**
 * Get version history for a workflow
 */
export async function getWorkflowVersions(name: string): Promise<WorkflowVersion[]> {
  const client = getApiClient();
  const response = await client.getValidated(
    `/workflows/${encodeURIComponent(name)}/versions`,
    z.object({ versions: z.array(WorkflowVersionSchema) })
  );
  return response.data.versions;
}

/**
 * Get specific version content for a workflow
 */
export async function getWorkflowVersion(name: string, version: number): Promise<string> {
  const client = getApiClient();
  const response = await client.getValidated(
    `/workflows/${encodeURIComponent(name)}/versions/${version}`,
    z.object({ content: z.string() })
  );
  return response.data.content;
}
