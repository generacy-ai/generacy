/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Workspace management type definitions.
 */

import type { Workspace, WorkspaceOptions, WorkspaceStatus } from '../types.js';
import type { PollState } from '../polling/types.js';

/**
 * Internal workspace representation with mutable state.
 */
export interface InternalWorkspace {
  /** Public workspace data */
  workspace: Workspace;

  /** Polling state */
  pollState: PollState;

  /** Associated GitHub data */
  github: {
    issueId: number;
    linkedPRNumbers: number[];
  };

  /** Workspace options */
  options: WorkspaceOptions;
}

/**
 * Parameters for creating a workspace.
 */
export interface CreateWorkspaceParams {
  issueUrl: string;
  options?: WorkspaceOptions;
}

/**
 * Result of inferring status from GitHub.
 */
export interface StatusInference {
  /** Inferred status */
  status: WorkspaceStatus;
  /** Associated PR number if found */
  prNumber?: number;
  /** PR URL if found */
  prUrl?: string;
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Workspace storage interface.
 */
export interface WorkspaceStore {
  /** Get a workspace by ID */
  get(workspaceId: string): InternalWorkspace | undefined;
  /** Set a workspace */
  set(workspaceId: string, workspace: InternalWorkspace): void;
  /** Delete a workspace */
  delete(workspaceId: string): boolean;
  /** Check if workspace exists */
  has(workspaceId: string): boolean;
  /** Get all workspace IDs */
  keys(): Iterable<string>;
  /** Clear all workspaces */
  clear(): void;
}
