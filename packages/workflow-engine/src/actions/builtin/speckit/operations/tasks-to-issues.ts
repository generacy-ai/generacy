/**
 * Tasks-to-issues operation handler.
 * Parses structured tasks.md with optional YAML frontmatter and creates child GitHub issues.
 */
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ParsedTask,
  TasksToIssuesInput,
  TasksToIssuesOutput,
  CreatedIssue,
  SkippedIssue,
  FailedTask,
  ActionContext,
} from '../../../../types/index.js';
import { executeCommand, parseJSONSafe } from '../../../cli-utils.js';
import { readFile, exists } from '../lib/fs.js';

/**
 * Parse structured tasks.md content into an array of ParsedTask objects.
 *
 * Supports two formats:
 *
 * 1. Structured format with YAML frontmatter:
 *    ## Task 1
 *    ---
 *    title: Implement user authentication
 *    type: feature
 *    labels: [auth, security]
 *    ---
 *    Description of the task...
 *
 * 2. Fallback format (no frontmatter):
 *    ## Task 1 Implement user authentication
 *    Description text becomes the description.
 *    ### T001 Implement user authentication
 *    Description text becomes the description.
 *
 * Parsing rules:
 * - Task sections start with `## Task N` or `### TXXX` headings
 * - YAML frontmatter between `---` delimiters provides metadata
 * - `title` is required in frontmatter; `type` and `labels` are optional
 * - Body text after second `---` until next heading = description
 * - Fallback: if no frontmatter, heading text = title, section body = description
 */
export function parseTasksFile(content: string): ParsedTask[] {
  if (!content || !content.trim()) {
    return [];
  }

  const tasks: ParsedTask[] = [];
  const sections = splitIntoTaskSections(content);

  for (const section of sections) {
    const parsed = parseTaskSection(section);
    if (parsed) {
      tasks.push(parsed);
    }
  }

  return tasks;
}

/**
 * A raw task section extracted from the markdown.
 */
interface RawTaskSection {
  /** The heading line (e.g., "## Task 1" or "### T007 Implement parser") */
  heading: string;
  /** The body lines after the heading, until the next task heading */
  body: string;
}

/**
 * Split markdown content into task sections based on headings.
 * Each task starts with `## Task N` or `### TXXX` heading.
 */
function splitIntoTaskSections(content: string): RawTaskSection[] {
  const sections: RawTaskSection[] = [];
  const lines = content.split('\n');

  // Pattern: ## Task N or ### TXXX (with optional trailing text)
  const taskHeadingPattern = /^(?:#{2,3})\s+(?:Task\s+\d+|T\d{3,})\b/;

  let currentHeading: string | null = null;
  let currentBodyLines: string[] = [];

  for (const line of lines) {
    if (taskHeadingPattern.test(line)) {
      // Flush previous section
      if (currentHeading !== null) {
        sections.push({
          heading: currentHeading,
          body: currentBodyLines.join('\n'),
        });
      }
      currentHeading = line;
      currentBodyLines = [];
    } else if (currentHeading !== null) {
      currentBodyLines.push(line);
    }
  }

  // Flush final section
  if (currentHeading !== null) {
    sections.push({
      heading: currentHeading,
      body: currentBodyLines.join('\n'),
    });
  }

  return sections;
}

/**
 * Extract a task ID from a heading line.
 * Matches patterns like "## Task 1", "### T007", "### T001 Description".
 */
function extractTaskId(heading: string): string {
  // Try explicit TXXX pattern first
  const explicitMatch = heading.match(/\b(T\d{3,})\b/);
  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }

  // Fall back to "Task N" → "T00N" format
  const taskNMatch = heading.match(/Task\s+(\d+)/);
  if (taskNMatch?.[1]) {
    const num = parseInt(taskNMatch[1], 10);
    return `T${String(num).padStart(3, '0')}`;
  }

  return '';
}

/**
 * Extract heading text after the task identifier.
 * E.g., "### T007 [DONE] Implement task parser" → "Implement task parser"
 */
function extractHeadingText(heading: string): string {
  // Remove markdown heading prefix
  let text = heading.replace(/^#{2,3}\s+/, '');
  // Remove Task N or TXXX prefix
  text = text.replace(/^(?:Task\s+\d+|T\d{3,})\s*/, '');
  // Remove markers like [DONE], [P]
  text = text.replace(/\[(?:DONE|P)\]\s*/g, '');
  return text.trim();
}

/**
 * Parse YAML frontmatter from a section body.
 * Frontmatter is delimited by lines that are exactly `---`.
 * Returns the parsed YAML object and remaining body, or null if no frontmatter found.
 */
function extractFrontmatter(body: string): { frontmatter: Record<string, unknown>; remainder: string } | null {
  const lines = body.split('\n');

  // Find the first `---` delimiter (skip leading blank lines)
  let firstDelimiter = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '') continue;
    if (trimmed === '---') {
      firstDelimiter = i;
      break;
    }
    // Non-empty, non-delimiter line before first `---` means no frontmatter
    return null;
  }

  if (firstDelimiter === -1) return null;

  // Find the closing `---` delimiter
  let secondDelimiter = -1;
  for (let i = firstDelimiter + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      secondDelimiter = i;
      break;
    }
  }

  if (secondDelimiter === -1) return null;

  const yamlContent = lines.slice(firstDelimiter + 1, secondDelimiter).join('\n');
  const remainder = lines.slice(secondDelimiter + 1).join('\n');

  try {
    const parsed = parseYaml(yamlContent);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, remainder };
    }
    return null;
  } catch {
    // Malformed YAML — fall back to no-frontmatter parsing
    return null;
  }
}

/**
 * Parse a single task section into a ParsedTask.
 */
function parseTaskSection(section: RawTaskSection): ParsedTask | null {
  const taskId = extractTaskId(section.heading);
  if (!taskId) return null;

  const frontmatterResult = extractFrontmatter(section.body);

  if (frontmatterResult) {
    const { frontmatter, remainder } = frontmatterResult;
    const title = typeof frontmatter.title === 'string' ? frontmatter.title : '';

    if (!title) {
      // title is required in frontmatter — fall back to heading text
      return buildFallbackTask(taskId, section);
    }

    const task: ParsedTask = {
      task_id: taskId,
      title,
      description: remainder.trim(),
    };

    if (typeof frontmatter.type === 'string' && frontmatter.type) {
      task.type = frontmatter.type;
    }

    if (Array.isArray(frontmatter.labels)) {
      const labels = frontmatter.labels
        .filter((l): l is string => typeof l === 'string' && l.length > 0);
      if (labels.length > 0) {
        task.labels = labels;
      }
    }

    return task;
  }

  // No frontmatter — use fallback parsing
  return buildFallbackTask(taskId, section);
}

/**
 * Build a ParsedTask using fallback parsing (no frontmatter).
 * Heading text becomes the title, section body becomes the description.
 */
function buildFallbackTask(taskId: string, section: RawTaskSection): ParsedTask {
  const headingText = extractHeadingText(section.heading);
  const description = section.body.trim();

  return {
    task_id: taskId,
    title: headingText || `Task ${taskId}`,
    description,
  };
}

// =============================================================================
// Issue Creation with Idempotency
// =============================================================================

/**
 * Default trigger label applied to child issues if none specified.
 */
const DEFAULT_TRIGGER_LABEL = 'process:speckit-feature';

/**
 * Build the issue body for a child issue created from an epic task.
 * Includes structured markers for idempotency detection and parent tracking.
 */
function buildIssueBody(
  task: ParsedTask,
  epicIssueNumber: number,
  epicBranch: string,
): string {
  const lines: string[] = [];

  if (task.description) {
    lines.push(task.description);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`epic-parent: #${epicIssueNumber}`);
  lines.push(`task: ${task.task_id}`);
  lines.push(`epic-branch: ${epicBranch}`);

  return lines.join('\n');
}

/**
 * Build the labels array for a child issue.
 */
function buildLabels(task: ParsedTask, triggerLabel: string): string[] {
  const labels = ['epic-child', triggerLabel];

  if (task.type) {
    labels.push(`type:${task.type}`);
  }

  if (task.labels) {
    for (const label of task.labels) {
      if (!labels.includes(label)) {
        labels.push(label);
      }
    }
  }

  return labels;
}

/**
 * Search for an existing child issue by epic-parent and task ID markers in the body.
 * Returns the issue number if found, or null if no match.
 */
async function findExistingChildIssue(
  epicIssueNumber: number,
  taskId: string,
  cwd: string,
): Promise<{ number: number; title: string } | null> {
  const searchQuery = `"epic-parent: #${epicIssueNumber}" "task: ${taskId}" in:body`;

  const result = await executeCommand('gh', [
    'issue', 'list',
    '--search', searchQuery,
    '--json', 'number,title',
    '--limit', '10',
    '--state', 'all',
  ], { cwd, timeout: 30000 });

  if (result.exitCode !== 0) {
    return null;
  }

  const issues = parseJSONSafe(result.stdout) as Array<{ number: number; title: string }> | null;
  if (!issues || issues.length === 0) {
    return null;
  }

  return { number: issues[0]!.number, title: issues[0]!.title };
}

/**
 * Create a single child issue on GitHub.
 * Returns the created issue number.
 */
async function createChildIssue(
  task: ParsedTask,
  body: string,
  labels: string[],
  cwd: string,
): Promise<number> {
  const args = [
    'issue', 'create',
    '--title', task.title,
    '--body', body,
  ];

  for (const label of labels) {
    args.push('--label', label);
  }

  const result = await executeCommand('gh', args, { cwd, timeout: 30000 });

  if (result.exitCode !== 0) {
    throw new Error(`gh issue create failed: ${result.stderr}`);
  }

  // gh issue create outputs the issue URL, extract the number from it
  const urlMatch = result.stdout.match(/\/issues\/(\d+)/);
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10);
  }

  // Try JSON output format as fallback
  const parsed = parseJSONSafe(result.stdout) as { number?: number } | null;
  if (parsed?.number) {
    return parsed.number;
  }

  throw new Error(`Could not extract issue number from output: ${result.stdout}`);
}

/**
 * Execute the tasks-to-issues operation.
 *
 * Reads tasks.md from the feature directory, parses it, and creates child GitHub issues
 * for each task. Idempotent — if an issue already exists for a given epic-parent + task ID
 * combination, it is skipped rather than duplicated.
 *
 * @param input - Operation input containing feature directory, epic info, and optional trigger label
 * @param context - Action execution context providing workdir and logger
 * @returns Summary of created, skipped, and failed issues
 */
export async function executeTasksToIssues(
  input: TasksToIssuesInput,
  context: ActionContext,
): Promise<TasksToIssuesOutput> {
  const { feature_dir, epic_issue_number, epic_branch } = input;
  const triggerLabel = input.trigger_label ?? DEFAULT_TRIGGER_LABEL;

  // Read tasks.md
  const tasksFile = join(feature_dir, 'tasks.md');
  if (!(await exists(tasksFile))) {
    context.logger.warn(`tasks.md not found at ${tasksFile}`);
    return {
      created_issues: [],
      skipped_issues: [],
      failed_tasks: [],
      total_tasks: 0,
    };
  }

  const content = await readFile(tasksFile);
  const tasks = parseTasksFile(content);

  if (tasks.length === 0) {
    context.logger.info('No tasks found in tasks.md');
    return {
      created_issues: [],
      skipped_issues: [],
      failed_tasks: [],
      total_tasks: 0,
    };
  }

  context.logger.info(`Parsed ${tasks.length} tasks from tasks.md`);

  const created_issues: CreatedIssue[] = [];
  const skipped_issues: SkippedIssue[] = [];
  const failed_tasks: FailedTask[] = [];

  for (const task of tasks) {
    try {
      // Check for existing child issue (idempotency)
      const existing = await findExistingChildIssue(
        epic_issue_number,
        task.task_id,
        context.workdir,
      );

      if (existing) {
        context.logger.info(
          `Skipping ${task.task_id} — already exists as #${existing.number}`,
        );
        skipped_issues.push({
          issue_number: existing.number,
          title: existing.title,
          task_id: task.task_id,
        });
        continue;
      }

      // Build issue content
      const body = buildIssueBody(task, epic_issue_number, epic_branch);
      const labels = buildLabels(task, triggerLabel);

      // Create the issue
      const issueNumber = await createChildIssue(
        task,
        body,
        labels,
        context.workdir,
      );

      context.logger.info(
        `Created issue #${issueNumber} for ${task.task_id}: ${task.title}`,
      );
      created_issues.push({
        issue_number: issueNumber,
        title: task.title,
        task_id: task.task_id,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      context.logger.error(
        `Failed to create issue for ${task.task_id}: ${reason}`,
      );
      failed_tasks.push({
        task_id: task.task_id,
        title: task.title,
        reason,
      });
    }
  }

  context.logger.info(
    `Tasks-to-issues complete: ${created_issues.length} created, ${skipped_issues.length} skipped, ${failed_tasks.length} failed`,
  );

  return {
    created_issues,
    skipped_issues,
    failed_tasks,
    total_tasks: tasks.length,
  };
}
