/**
 * Filesystem-based workflow state persistence.
 * Stores workflow state in .generacy/workflow-state.json files.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  WorkflowState,
  WorkflowStore,
  StateValidationResult,
} from '../types/store.js';

/** Default state file location */
const DEFAULT_STATE_DIR = '.generacy';
const STATE_FILE_PREFIX = 'workflow-state-';
const STATE_FILE_EXT = '.json';

/**
 * Validate workflow state schema
 */
export function validateWorkflowState(data: unknown): StateValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['State must be an object'] };
  }

  const state = data as Record<string, unknown>;

  // Version check
  if (state.version !== '1.0') {
    errors.push(`Invalid version: expected '1.0', got '${state.version}'`);
  }

  // Required string fields
  const requiredStrings = ['workflowId', 'workflowFile', 'currentPhase', 'currentStep', 'startedAt', 'updatedAt'];
  for (const field of requiredStrings) {
    if (typeof state[field] !== 'string' || (state[field] as string).length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  // Validate inputs is an object
  if (typeof state.inputs !== 'object' || state.inputs === null) {
    errors.push('inputs must be an object');
  }

  // Validate stepOutputs is an object
  if (typeof state.stepOutputs !== 'object' || state.stepOutputs === null) {
    errors.push('stepOutputs must be an object');
  } else {
    // Validate each step output
    const stepOutputs = state.stepOutputs as Record<string, unknown>;
    for (const [stepId, output] of Object.entries(stepOutputs)) {
      if (typeof output !== 'object' || output === null) {
        errors.push(`stepOutputs.${stepId} must be an object`);
        continue;
      }
      const stepOutput = output as Record<string, unknown>;
      if (typeof stepOutput.raw !== 'string') {
        errors.push(`stepOutputs.${stepId}.raw must be a string`);
      }
      if (typeof stepOutput.exitCode !== 'number') {
        errors.push(`stepOutputs.${stepId}.exitCode must be a number`);
      }
      if (typeof stepOutput.completedAt !== 'string') {
        errors.push(`stepOutputs.${stepId}.completedAt must be a string`);
      }
    }
  }

  // Validate pendingReview if present
  if (state.pendingReview !== undefined) {
    if (typeof state.pendingReview !== 'object' || state.pendingReview === null) {
      errors.push('pendingReview must be an object');
    } else {
      const review = state.pendingReview as Record<string, unknown>;
      if (typeof review.reviewId !== 'string') {
        errors.push('pendingReview.reviewId must be a string');
      }
      if (typeof review.artifact !== 'string') {
        errors.push('pendingReview.artifact must be a string');
      }
      if (typeof review.requestedAt !== 'string') {
        errors.push('pendingReview.requestedAt must be a string');
      }
    }
  }

  // Validate ISO timestamps
  const timestamps = ['startedAt', 'updatedAt'];
  for (const field of timestamps) {
    if (typeof state[field] === 'string') {
      const date = new Date(state[field] as string);
      if (isNaN(date.getTime())) {
        errors.push(`${field} must be a valid ISO timestamp`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Filesystem-based workflow store implementation.
 * Persists workflow state to local filesystem for pause/resume support.
 */
export class FilesystemWorkflowStore implements WorkflowStore {
  private stateDir: string;
  private workdir: string;

  /**
   * Create a new filesystem store
   * @param workdir Working directory (defaults to process.cwd())
   * @param stateDir State directory name (defaults to .generacy)
   */
  constructor(workdir?: string, stateDir?: string) {
    this.workdir = workdir ?? process.cwd();
    this.stateDir = stateDir ?? DEFAULT_STATE_DIR;
  }

  /**
   * Get the full path to the state directory
   */
  private getStateDirectoryPath(): string {
    return path.join(this.workdir, this.stateDir);
  }

  /**
   * Get the full path to a state file
   */
  private getStateFilePath(workflowId: string): string {
    // Sanitize workflow ID for use in filename
    const safeId = workflowId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.getStateDirectoryPath(), `${STATE_FILE_PREFIX}${safeId}${STATE_FILE_EXT}`);
  }

  /**
   * Ensure state directory exists
   */
  private async ensureStateDirectory(): Promise<void> {
    const dirPath = this.getStateDirectoryPath();
    await fs.mkdir(dirPath, { recursive: true });
  }

  /**
   * Save workflow state to filesystem
   */
  async save(state: WorkflowState): Promise<void> {
    // Validate state before saving
    const validation = validateWorkflowState(state);
    if (!validation.valid) {
      throw new Error(`Invalid workflow state: ${validation.errors.join(', ')}`);
    }

    // Update timestamp
    const stateToSave: WorkflowState = {
      ...state,
      updatedAt: new Date().toISOString(),
    };

    await this.ensureStateDirectory();

    const filePath = this.getStateFilePath(state.workflowId);

    // Write to temp file first, then rename for atomic operation
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(stateToSave, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  }

  /**
   * Load workflow state from filesystem
   */
  async load(workflowId: string): Promise<WorkflowState | null> {
    const filePath = this.getStateFilePath(workflowId);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Validate loaded state
      const validation = validateWorkflowState(data);
      if (!validation.valid) {
        console.error(`Invalid workflow state in ${filePath}: ${validation.errors.join(', ')}`);
        return null;
      }

      return data as WorkflowState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Delete workflow state from filesystem
   */
  async delete(workflowId: string): Promise<void> {
    const filePath = this.getStateFilePath(workflowId);

    try {
      await fs.unlink(filePath);
    } catch (error) {
      // Ignore if file doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * List all pending workflow states
   */
  async listPending(): Promise<WorkflowState[]> {
    const dirPath = this.getStateDirectoryPath();
    const pending: WorkflowState[] = [];

    try {
      const files = await fs.readdir(dirPath);

      for (const file of files) {
        if (file.startsWith(STATE_FILE_PREFIX) && file.endsWith(STATE_FILE_EXT)) {
          const filePath = path.join(dirPath, file);
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);

            const validation = validateWorkflowState(data);
            if (validation.valid) {
              pending.push(data as WorkflowState);
            }
          } catch {
            // Skip invalid files
            console.warn(`Skipping invalid state file: ${file}`);
          }
        }
      }
    } catch (error) {
      // Return empty if directory doesn't exist
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    // Sort by updatedAt descending (most recent first)
    pending.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return pending;
  }

  /**
   * Check if a pending state exists for a workflow
   */
  async hasPendingState(workflowId: string): Promise<boolean> {
    const state = await this.load(workflowId);
    return state !== null && state.pendingReview !== undefined;
  }
}
