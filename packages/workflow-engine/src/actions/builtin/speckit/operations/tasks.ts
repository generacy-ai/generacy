/**
 * Tasks operation handler.
 * Uses agent.invoke to generate task list from specification and plan.
 */
import { join } from 'node:path';
import type { ActionContext } from '../../../../types/index.js';
import type { TasksInput, TasksOutput } from '../types.js';
import { executeCommand } from '../../../cli-utils.js';
import { exists, readFile } from '../lib/fs.js';

/**
 * Build the prompt for task list generation
 */
function buildTasksPrompt(featureDir: string, specContent: string, planContent: string): string {
  return `Generate a detailed task list for implementing this feature.

Feature directory: ${featureDir}
Tasks file: ${join(featureDir, 'tasks.md')}

Specification:
${specContent}

Implementation Plan:
${planContent}

Instructions:
1. Analyze the specification and plan
2. Break down the implementation into discrete tasks
3. Organize tasks by implementation phase
4. Mark parallel tasks that can be done concurrently
5. Include setup, testing, and documentation tasks

Generate a task list with this format:
# Tasks: [Feature Name]

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: \`[ID] [P?] [Story] Description\`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: [Phase Name]

### T001 [Task description]
**File**: \`path/to/file.ts\`
- Sub-task 1
- Sub-task 2

### T002 [P] [Task description]
**Files**:
- \`path/to/file1.ts\`
- \`path/to/file2.ts\`
- Sub-task 1

---

## Phase N: Testing

### TXXX Write unit tests
**Files**:
- \`tests/*.test.ts\`
- Test coverage requirements

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2
- Testing depends on implementation

**Parallel opportunities within phases**:
- Tasks marked [P] can run in parallel

**Critical path**:
T001 → T002 → ... → Final task

Write the task list directly to the tasks.md file.`;
}

/**
 * Count tasks in tasks content
 */
function countTasks(content: string): number {
  const taskMatches = content.match(/###\s*T\d+/g);
  return taskMatches ? taskMatches.length : 0;
}

/**
 * Extract phase names from tasks content
 */
function extractPhases(content: string): string[] {
  const phases: string[] = [];
  const phaseMatches = content.matchAll(/##\s*Phase\s*\d+:?\s*([^\n]+)/gi);
  for (const match of phaseMatches) {
    if (match[1]) {
      phases.push(match[1].trim());
    }
  }
  return phases;
}

/**
 * Estimate complexity based on task count and phases
 */
function estimateComplexity(taskCount: number, phaseCount: number): 'simple' | 'moderate' | 'complex' {
  if (taskCount <= 5 && phaseCount <= 2) {
    return 'simple';
  } else if (taskCount <= 15 && phaseCount <= 4) {
    return 'moderate';
  }
  return 'complex';
}

/**
 * Execute the tasks operation using agent.invoke delegation
 */
export async function executeTasks(
  input: TasksInput,
  context: ActionContext
): Promise<TasksOutput> {
  const specFile = join(input.feature_dir, 'spec.md');
  const planFile = join(input.feature_dir, 'plan.md');
  const tasksFile = join(input.feature_dir, 'tasks.md');

  context.logger.info(`Generating task list for: ${input.feature_dir}`);

  // Read the spec file
  if (!(await exists(specFile))) {
    context.logger.error('Spec file not found');
    return {
      success: false,
      tasks_file: tasksFile,
      task_count: 0,
      phases: [],
      estimated_complexity: 'simple',
    };
  }

  // Read the plan file
  if (!(await exists(planFile))) {
    context.logger.error('Plan file not found');
    return {
      success: false,
      tasks_file: tasksFile,
      task_count: 0,
      phases: [],
      estimated_complexity: 'simple',
    };
  }

  let specContent: string;
  let planContent: string;
  try {
    specContent = await readFile(specFile);
    planContent = await readFile(planFile);
  } catch (error) {
    context.logger.error(`Failed to read files: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      tasks_file: tasksFile,
      task_count: 0,
      phases: [],
      estimated_complexity: 'simple',
    };
  }

  // Build prompt
  const prompt = buildTasksPrompt(input.feature_dir, specContent, planContent);

  try {
    // Invoke Claude agent
    const args: string[] = ['-p', prompt, '--output-format', 'json'];
    const timeout = (input.timeout ?? 300) * 1000;

    const result = await executeCommand('claude', args, {
      cwd: input.feature_dir,
      timeout,
      signal: context.signal,
    });

    if (result.exitCode !== 0) {
      return {
        success: false,
        tasks_file: tasksFile,
        task_count: 0,
        phases: [],
        estimated_complexity: 'simple',
      };
    }

    // Read the generated tasks to extract metrics
    let taskCount = 0;
    let phases: string[] = [];
    let complexity: 'simple' | 'moderate' | 'complex' = 'simple';

    if (await exists(tasksFile)) {
      try {
        const tasksContent = await readFile(tasksFile);
        taskCount = countTasks(tasksContent);
        phases = extractPhases(tasksContent);
        complexity = estimateComplexity(taskCount, phases.length);
      } catch {
        // Ignore read errors
      }
    }

    context.logger.info(`Task list generated: ${taskCount} tasks in ${phases.length} phases`);
    context.logger.info(`Estimated complexity: ${complexity}`);

    return {
      success: true,
      tasks_file: tasksFile,
      task_count: taskCount,
      phases,
      estimated_complexity: complexity,
    };
  } catch (error) {
    context.logger.error(`Tasks operation failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      tasks_file: tasksFile,
      task_count: 0,
      phases: [],
      estimated_complexity: 'simple',
    };
  }
}
