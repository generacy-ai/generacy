/**
 * Implement operation handler.
 * Uses agent.invoke to execute tasks from the task list.
 */
import { join } from 'node:path';
import type { ActionContext } from '../../../../types/index.js';
import type { ImplementInput, ImplementOutput } from '../types.js';
import { executeCommand } from '../../../cli-utils.js';
import { exists, readFile, writeFile } from '../lib/fs.js';
import { StreamBatcher } from '../lib/stream-batcher.js';

/**
 * Task parsed from tasks.md
 */
interface ParsedTask {
  id: string;
  description: string;
  files: string[];
  subtasks: string[];
  isParallel: boolean;
  isComplete: boolean;
}

/**
 * Parse tasks from tasks.md content
 */
function parseTasks(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const lines = content.split('\n');

  let currentTask: ParsedTask | null = null;
  let inFiles = false;

  for (const line of lines) {
    // Match task header: ### T001 [P] Description or - [ ] T001 Description
    // Also detects [DONE] marker for heading-format completion tracking
    const taskMatch = line.match(/(?:###\s*|[-*]\s*\[([ xX])\]\s*)(T\d+)\s*(\[DONE\]\s*)?(\[P\])?\s*(.*)/);
    if (taskMatch && taskMatch[2]) {
      if (currentTask) {
        tasks.push(currentTask);
      }
      currentTask = {
        id: taskMatch[2],
        description: (taskMatch[5] ?? '').trim(),
        files: [],
        subtasks: [],
        isParallel: !!taskMatch[4],
        isComplete: taskMatch[1] ? taskMatch[1].toLowerCase() === 'x' : !!taskMatch[3],
      };
      inFiles = false;
      continue;
    }

    if (currentTask) {
      // Match file paths
      const fileMatch = line.match(/\*\*Files?\*\*:\s*`([^`]+)`/);
      if (fileMatch?.[1]) {
        currentTask.files.push(fileMatch[1]);
        inFiles = true;
        continue;
      }

      // Match file list items
      if (inFiles && line.match(/^[-*]\s*`([^`]+)`/)) {
        const pathMatch = line.match(/`([^`]+)`/);
        if (pathMatch?.[1]) {
          currentTask.files.push(pathMatch[1]);
        }
        continue;
      }

      // Match subtasks (lines starting with - or * that aren't files)
      const subtaskMatch = line.match(/^[-*]\s+(?![`[])(.+)/);
      if (subtaskMatch?.[1] && !inFiles) {
        currentTask.subtasks.push(subtaskMatch[1].trim());
      }

      // Reset inFiles if we hit a blank line or another section
      if (line.trim() === '' || line.startsWith('##')) {
        inFiles = false;
      }
    }
  }

  if (currentTask) {
    tasks.push(currentTask);
  }

  return tasks;
}

/**
 * Mark a task as complete in tasks.md content
 */
function markTaskComplete(content: string, taskId: string): string {
  // Replace checkbox format: - [ ] Txxx -> - [X] Txxx
  content = content.replace(
    new RegExp(`([-*]\\s*)\\[\\s*\\](\\s*${taskId})`, 'g'),
    '$1[X]$2'
  );
  // Replace heading format: ### Txxx -> ### Txxx [DONE] (only if not already marked)
  content = content.replace(
    new RegExp(`(###\\s*${taskId})(?!\\s*\\[DONE\\])`, 'g'),
    '$1 [DONE]'
  );
  return content;
}

/**
 * Build the prompt for implementing a single task
 */
function buildTaskPrompt(task: ParsedTask, featureDir: string, specContent: string, planContent: string): string {
  let prompt = `Implement task ${task.id}: ${task.description}

Feature directory: ${featureDir}

`;

  if (task.files.length > 0) {
    prompt += `Files to modify/create:
${task.files.map(f => `- ${f}`).join('\n')}

`;
  }

  if (task.subtasks.length > 0) {
    prompt += `Subtasks:
${task.subtasks.map(s => `- ${s}`).join('\n')}

`;
  }

  prompt += `Context from spec.md (summary):
${specContent.substring(0, 2000)}

Context from plan.md (summary):
${planContent.substring(0, 2000)}

Instructions:
1. Implement the task according to the specification
2. Follow the architectural patterns from the plan
3. Write clean, well-documented code
4. Include appropriate error handling
5. Ensure type safety (for TypeScript)

Complete this task by writing the necessary code.`;

  return prompt;
}

/**
 * Execute the implement operation using agent.invoke delegation
 */
export async function executeImplement(
  input: ImplementInput,
  context: ActionContext
): Promise<ImplementOutput> {
  const specFile = join(input.feature_dir, 'spec.md');
  const planFile = join(input.feature_dir, 'plan.md');
  const tasksFile = join(input.feature_dir, 'tasks.md');

  context.logger.info(`Implementing tasks for: ${input.feature_dir}`);

  // Read required files
  if (!(await exists(tasksFile))) {
    context.logger.error('Tasks file not found');
    return {
      success: false,
      tasks_completed: 0,
      tasks_total: 0,
      tasks_skipped: 0,
      files_modified: [],
      errors: ['Tasks file not found'],
    };
  }

  let tasksContent: string;
  let specContent: string;
  let planContent: string;

  try {
    tasksContent = await readFile(tasksFile);
    specContent = await exists(specFile) ? await readFile(specFile) : '';
    planContent = await exists(planFile) ? await readFile(planFile) : '';
  } catch (error) {
    context.logger.error(`Failed to read files: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      tasks_completed: 0,
      tasks_total: 0,
      tasks_skipped: 0,
      files_modified: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  // Parse tasks
  let tasks = parseTasks(tasksContent);

  // Apply filter if specified
  if (input.task_filter) {
    const filterPattern = new RegExp(input.task_filter, 'i');
    tasks = tasks.filter(t =>
      filterPattern.test(t.id) || filterPattern.test(t.description)
    );
    context.logger.info(`Filtered to ${tasks.length} tasks matching: ${input.task_filter}`);
  }

  // Filter out completed tasks
  const pendingTasks = tasks.filter(t => !t.isComplete);
  const skippedTasks = tasks.filter(t => t.isComplete);

  context.logger.info(`Tasks: ${pendingTasks.length} pending, ${skippedTasks.length} already complete`);

  if (pendingTasks.length === 0) {
    context.logger.info('All tasks already complete');
    return {
      success: true,
      tasks_completed: 0,
      tasks_total: tasks.length,
      tasks_skipped: skippedTasks.length,
      files_modified: [],
    };
  }

  const completedTasks: string[] = [];
  const filesModified: Set<string> = new Set();
  const errors: string[] = [];
  const timeout = (input.timeout ?? 600) * 1000;

  // Resolve repo root once for all git operations (feature_dir is the spec dir, not the repo root)
  const { stdout: repoRootRaw } = await executeCommand(
    'git', ['rev-parse', '--show-toplevel'],
    { cwd: input.feature_dir, timeout: 10000 }
  );
  const rootDir = repoRootRaw.trim();
  let completedCount = 0;

  // Execute tasks
  for (const task of pendingTasks) {
    context.logger.info(`Executing task ${task.id}: ${task.description.substring(0, 50)}...`);

    // Check for cancellation
    if (context.signal.aborted) {
      context.logger.warn('Implementation cancelled');
      break;
    }

    const prompt = buildTaskPrompt(task, input.feature_dir, specContent, planContent);

    try {
      // Set up streaming batchers for real-time log output (per-task)
      const stdoutBatcher = new StreamBatcher((content) => {
        context.emitEvent?.({
          type: 'log:append',
          data: { stream: 'stdout', stepName: `implement:${task.id}`, content },
        });
      });
      const stderrBatcher = new StreamBatcher((content) => {
        context.emitEvent?.({
          type: 'log:append',
          data: { stream: 'stderr', stepName: `implement:${task.id}`, content },
        });
      });

      const result = await executeCommand('claude', ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'], {
        cwd: input.feature_dir,
        timeout,
        signal: context.signal,
        onStdout: (chunk) => stdoutBatcher.append(chunk),
        onStderr: (chunk) => stderrBatcher.append(chunk),
      });

      // Flush remaining batched content
      stdoutBatcher.flush();
      stderrBatcher.flush();

      if (result.exitCode === 0) {
        completedTasks.push(task.id);
        // Track files that were supposed to be modified
        for (const file of task.files) {
          filesModified.add(file);
        }
        context.logger.info(`Task ${task.id} completed`);

        // Update tasks.md to mark task complete
        tasksContent = markTaskComplete(tasksContent, task.id);
        await writeFile(tasksFile, tasksContent);

        // Commit each completed task and push periodically
        completedCount++;
        await executeCommand('git', ['add', '-A'], { cwd: rootDir, timeout: 30000 });
        await executeCommand('git', ['commit', '-m', `feat: complete ${task.id}`], { cwd: rootDir, timeout: 30000 });

        const isLastTask = completedTasks.length === pendingTasks.length;
        if (completedCount % 3 === 0 || isLastTask) {
          await executeCommand('git', ['push'], { cwd: rootDir, timeout: 60000 })
            .catch((err: unknown) => {
              context.logger.warn(`Push after ${task.id} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
            });
        }
      } else {
        errors.push(`Task ${task.id} failed: Agent returned non-zero exit code`);
        context.logger.error(`Task ${task.id} failed`);
        await executeCommand('git', ['checkout', '--', '.'], { cwd: rootDir, timeout: 30000 }).catch(() => {});
        await executeCommand('git', ['clean', '-fd'], { cwd: rootDir, timeout: 30000 }).catch(() => {});
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Task ${task.id} failed: ${errorMsg}`);
      context.logger.error(`Task ${task.id} failed: ${errorMsg}`);
      await executeCommand('git', ['checkout', '--', '.'], { cwd: rootDir, timeout: 30000 }).catch(() => {});
      await executeCommand('git', ['clean', '-fd'], { cwd: rootDir, timeout: 30000 }).catch(() => {});
    }
  }

  const success = errors.length === 0;
  context.logger.info(`Implementation complete: ${completedTasks.length}/${pendingTasks.length} tasks completed`);

  return {
    success,
    tasks_completed: completedTasks.length,
    tasks_total: tasks.length,
    tasks_skipped: skippedTasks.length,
    files_modified: [...filesModified],
    errors: errors.length > 0 ? errors : undefined,
  };
}
