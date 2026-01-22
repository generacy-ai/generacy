/**
 * Workflow publishing API type definitions.
 * Provides type-safe workflow version management and publishing.
 */
import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum workflow content size (5 MB)
 */
export const MAX_WORKFLOW_SIZE = 5 * 1024 * 1024;

/**
 * Sync status cache TTL (5 minutes)
 */
export const SYNC_STATUS_CACHE_TTL = 5 * 60 * 1000;

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Workflow version metadata
 */
export interface WorkflowVersion {
  /** Incremental version number (1, 2, 3, ...) */
  version: number;
  /** Optional semantic version tag (e.g., "v1.0.0", "v2.1.3") */
  tag?: string;
  /** ISO 8601 timestamp when this version was published */
  publishedAt: string;
  /** User ID of the person who published this version */
  publishedBy: string;
  /** Optional changelog message describing changes */
  changelog?: string;
}

/**
 * Zod schema for workflow version
 */
export const WorkflowVersionSchema = z.object({
  version: z.number().int().positive(),
  tag: z.string().optional(),
  publishedAt: z.string().datetime(),
  publishedBy: z.string(),
  changelog: z.string().optional(),
});

/**
 * Published workflow with version history
 */
export interface PublishedWorkflow {
  /** Unique workflow identifier (UUID) */
  id: string;
  /** Workflow name (must match filename without .yaml extension) */
  name: string;
  /** Latest version number */
  currentVersion: number;
  /** Complete version history (sorted newest first) */
  versions: WorkflowVersion[];
  /** ISO 8601 timestamp of last successful sync (optional) */
  lastSyncedAt?: string;
}

/**
 * Zod schema for published workflow
 */
export const PublishedWorkflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  currentVersion: z.number().int().positive(),
  versions: z.array(WorkflowVersionSchema),
  lastSyncedAt: z.string().datetime().optional(),
});

/**
 * Publish workflow request payload
 */
export interface PublishWorkflowRequest {
  /** Workflow name (used for identification) */
  name: string;
  /** Complete YAML content of the workflow */
  content: string;
  /** Optional changelog describing changes in this version */
  changelog?: string;
  /** Optional semantic version tag (e.g., "v1.2.0") */
  tag?: string;
}

/**
 * Zod schema for publish workflow request
 */
export const PublishWorkflowRequestSchema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  changelog: z.string().optional(),
  tag: z.string().regex(/^v?\d+\.\d+\.\d+/).optional(),
});

/**
 * Publish workflow response
 */
export interface PublishWorkflowResponse {
  /** Workflow ID (UUID) */
  id: string;
  /** New version number assigned */
  version: number;
  /** ISO 8601 timestamp when published */
  publishedAt: string;
}

/**
 * Zod schema for publish workflow response
 */
export const PublishWorkflowResponseSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  publishedAt: z.string().datetime(),
});

// ============================================================================
// Exported Types
// ============================================================================

export type WorkflowVersionType = z.infer<typeof WorkflowVersionSchema>;
export type PublishedWorkflowType = z.infer<typeof PublishedWorkflowSchema>;
export type PublishWorkflowRequestType = z.infer<typeof PublishWorkflowRequestSchema>;
export type PublishWorkflowResponseType = z.infer<typeof PublishWorkflowResponseSchema>;
