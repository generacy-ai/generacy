/**
 * Speckit action handler.
 * Deterministic operations (create_feature) run directly via shell.
 * AI operations (specify, plan, tasks, implement) delegate to Claude Code CLI.
 */
import { BaseAction } from './base-action';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
} from './types';
import { parseActionType } from './types';
import type { WorkflowStep } from '../types';
import { executeClaudeSession, executeShellCommand, checkCLI } from './cli-utils';
import type { ClaudeSessionResult } from './cli-utils';

/** Speckit operations */
const SPECKIT_OPERATIONS = [
  'create_feature',
  'specify',
  'clarify',
  'plan',
  'tasks',
  'implement',
  'get_paths',
  'check_prereqs',
  'copy_template',
] as const;

type SpeckitOperation = typeof SPECKIT_OPERATIONS[number];

/** Deterministic operations that don't need Claude CLI */
const DIRECT_OPERATIONS = new Set(['create_feature', 'get_paths', 'check_prereqs', 'copy_template']);

/** Stop words removed from branch slugs */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'by',
  'with', 'and', 'or', 'as', 'is', 'it', 'be', 'are', 'was',
  'were', 'been', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can',
  'this', 'that', 'these', 'those', 'i', 'we', 'you', 'add',
  'create', 'implement', 'build', 'update', 'fix',
]);

/**
 * Action handler for speckit workflow operations.
 */
export class SpecKitAction extends BaseAction {
  readonly type: ActionType = 'speckit';

  canHandle(step: WorkflowStep): boolean {
    return parseActionType(step) === 'speckit';
  }

  validate(step: WorkflowStep): ValidationResult {
    const errors = [];
    const warnings = [];

    const operation = this.extractOperation(step);
    if (!operation) {
      errors.push({
        field: 'uses',
        message: `Invalid speckit operation. Expected speckit.{operation} where operation is one of: ${SPECKIT_OPERATIONS.join(', ')}`,
        code: 'INVALID_SPECKIT_OPERATION',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  protected async executeInternal(
    step: WorkflowStep,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const operation = this.extractOperation(step);
    if (!operation) {
      return this.failureResult(`Invalid speckit operation in uses: ${step.uses}`);
    }

    const inputs = step.with || {};
    context.logger.info(`Speckit operation: ${operation}`);

    // Deterministic operations run directly
    if (DIRECT_OPERATIONS.has(operation)) {
      return this.executeDirect(operation, inputs, context);
    }

    // AI operations go through Claude CLI
    return this.executeViaClaude(operation, inputs, step, context);
  }

  /**
   * Execute deterministic operations directly (no Claude needed).
   */
  private async executeDirect(
    operation: SpeckitOperation,
    inputs: Record<string, unknown>,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    switch (operation) {
      case 'create_feature':
        return this.executeCreateFeature(inputs, context);
      default:
        return this.failureResult(`Direct execution not implemented for: ${operation}`);
    }
  }

  /**
   * Create a feature branch and spec directory directly.
   * Mirrors the speckit MCP tool logic without needing Claude.
   */
  private async executeCreateFeature(
    inputs: Record<string, unknown>,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const description = String(inputs['description'] || 'New feature');
    const shortName = inputs['short_name'] ? String(inputs['short_name']) : undefined;
    const cwd = context.workdir;

    try {
      // Find next feature number from specs/ directory
      const specsDir = `${cwd}/specs`;
      let nextNum = 1;

      try {
        const lsResult = await executeShellCommand(`ls -1 "${specsDir}" 2>/dev/null || echo ""`, { cwd });
        const entries = lsResult.stdout.trim().split('\n').filter(Boolean);
        for (const entry of entries) {
          const match = entry.match(/^(\d{3})-/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num >= nextNum) nextNum = num + 1;
          }
        }
      } catch {
        // specs dir doesn't exist yet, start at 1
      }

      const paddedNum = String(nextNum).padStart(3, '0');

      // Generate slug from description or use short_name
      const slug = shortName || this.generateSlug(description);
      const branchName = `${paddedNum}-${slug}`;
      const featureDir = `${specsDir}/${branchName}`;

      context.logger.info(`Creating feature branch: ${branchName}`);

      // Create directories
      await executeShellCommand(
        `mkdir -p "${featureDir}/checklists" "${featureDir}/contracts"`,
        { cwd }
      );

      // Create initial spec.md
      const title = description
        .split(/[.!?]/)[0]
        .trim()
        .replace(/^(add|create|implement|build)\s+/i, '')
        .replace(/^\w/, (c: string) => c.toUpperCase());

      const specContent = `# Feature Specification: ${title}

**Branch**: \`${branchName}\` | **Date**: ${new Date().toISOString().split('T')[0]} | **Status**: Draft

## Summary

${description}

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
`;

      // Write spec.md using shell (safe for extension context)
      await executeShellCommand(
        `cat > "${featureDir}/spec.md" << 'SPECEOF'\n${specContent}SPECEOF`,
        { cwd }
      );

      // Create git branch
      let gitBranchCreated = false;
      try {
        const branchCheck = await executeShellCommand(
          `git branch --list "${branchName}"`,
          { cwd }
        );

        if (!branchCheck.stdout.trim()) {
          await executeShellCommand(`git checkout -b "${branchName}"`, { cwd });
          gitBranchCreated = true;
          context.logger.info(`Created and checked out branch: ${branchName}`);
        } else {
          await executeShellCommand(`git checkout "${branchName}"`, { cwd });
          context.logger.info(`Checked out existing branch: ${branchName}`);
        }
      } catch (err) {
        context.logger.warn(`Git branch operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const output = {
        success: true,
        branch_name: branchName,
        feature_num: paddedNum,
        spec_file: `${featureDir}/spec.md`,
        feature_dir: featureDir,
        git_branch_created: gitBranchCreated,
      };

      context.logger.info(`Feature created: ${branchName} -> ${featureDir}`);

      return this.successResult(output, {
        stdout: JSON.stringify(output, null, 2),
      });
    } catch (error) {
      return this.failureResult(
        `create_feature failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Execute AI-dependent operations via Claude Code CLI.
   * Uses --dangerously-skip-permissions with skill as positional argument,
   * matching the autodev worker invocation pattern.
   */
  private async executeViaClaude(
    operation: SpeckitOperation,
    inputs: Record<string, unknown>,
    step: WorkflowStep,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const claudeStatus = await checkCLI('claude');
    if (!claudeStatus.available) {
      return this.failureResult(
        claudeStatus.error ||
          'Claude Code CLI is not available. Install it with: npm install -g @anthropic/claude-code'
      );
    }

    // Build the skill command as positional argument
    const skillCommand = this.buildSkillCommand(operation, inputs);
    context.logger.info(`Invoking Claude: claude --dangerously-skip-permissions ${skillCommand}`);

    try {
      // Timeouts: implement=1hr, others=10min
      const timeout = step.timeout || (operation === 'implement' ? 3600000 : 600000);

      // Use session resumption if available from previous step
      const sessionId = inputs['_session_id'] as string | undefined;

      const result: ClaudeSessionResult = await executeClaudeSession(skillCommand, {
        cwd: context.workdir,
        env: context.env,
        timeout,
        signal: context.signal,
        resumeSessionId: sessionId,
        phaseCallback: (phase) => {
          context.logger.info(`Phase detected: ${phase}`);
        },
        progressCallback: (text) => {
          // Log meaningful progress chunks (skip empty/whitespace)
          const trimmed = text.trim();
          if (trimmed.length > 0 && trimmed.length < 500) {
            context.logger.debug?.(`Claude: ${trimmed.substring(0, 200)}`);
          }
        },
      });

      if (result.exitCode !== 0) {
        return this.failureResult(
          `Speckit ${operation} failed (exit ${result.exitCode}): ${result.stderr || 'Unknown error'}`,
          {
            exitCode: result.exitCode,
            stdout: result.stdout.substring(0, 2000),
            stderr: result.stderr.substring(0, 2000),
            sessionId: result.sessionId,
            detectedPhases: result.detectedPhases,
          }
        );
      }

      context.logger.info(`Speckit ${operation} completed successfully`);

      // Return session ID in output for downstream steps to use with --resume
      const output: Record<string, unknown> = {
        success: true,
        operation,
        sessionId: result.sessionId,
        detectedPhases: result.detectedPhases,
      };

      return this.successResult(output, {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (error) {
      return this.failureResult(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Generate a URL-safe slug from a description.
   */
  private generateSlug(description: string): string {
    const words = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 0 && !STOP_WORDS.has(w))
      .slice(0, 4);

    const slug = words.join('-');
    if (!slug || slug.length < 2) return 'feature';
    return slug.length > 30 ? slug.substring(0, slug.lastIndexOf('-', 30) || 30) : slug;
  }

  /**
   * Extract the speckit operation from the step's uses field.
   */
  private extractOperation(step: WorkflowStep): SpeckitOperation | null {
    const uses = step.uses;
    if (!uses) return null;

    const match = uses.match(/^speckit[./](\w+)$/);
    if (!match) return null;

    const op = match[1] as SpeckitOperation;
    if (!SPECKIT_OPERATIONS.includes(op)) return null;

    return op;
  }

  /**
   * Build the skill command for Claude CLI positional argument.
   * Format: /speckit:{operation} [optional-url-or-context]
   */
  private buildSkillCommand(operation: SpeckitOperation, inputs: Record<string, unknown>): string {
    const base = `/speckit:${operation}`;

    // For specify, pass issue URL if available for context
    if (operation === 'specify' && inputs['issue_url']) {
      return `${base} ${inputs['issue_url']}`;
    }

    return base;
  }
}
