/**
 * Specify operation handler.
 * Uses agent.invoke to generate feature specification from description.
 */
import { join } from 'node:path';
import type { ActionContext } from '../../../../types/index.js';
import type { SpecifyInput, SpecifyOutput } from '../types.js';
import { executeCommand, extractJSON } from '../../../cli-utils.js';
import { exists, readFile } from '../lib/fs.js';

/**
 * Build the prompt for spec generation
 */
function buildSpecifyPrompt(featureDir: string, existingSpec?: string, issueContext?: string): string {
  let prompt = `Generate a comprehensive feature specification.

Feature directory: ${featureDir}
Spec file: ${join(featureDir, 'spec.md')}

`;

  if (issueContext) {
    prompt += `Issue context:
${issueContext}

`;
  }

  if (existingSpec) {
    prompt += `Existing spec (update and improve):
${existingSpec}

`;
  }

  prompt += `Instructions:
1. Analyze the feature description and any existing spec
2. Generate clear user stories with acceptance criteria
3. Define functional requirements in a table format
4. Document assumptions and out-of-scope items
5. Include success criteria with measurable targets
6. Write the specification to spec.md in the feature directory

The spec should follow this structure:
- Summary: Brief description of the feature
- User Stories: With acceptance criteria
- Functional Requirements: Prioritized table
- Success Criteria: Measurable targets
- Assumptions: What we assume to be true
- Out of Scope: What this feature does NOT include

Write the specification directly to the file.`;

  return prompt;
}

/**
 * Count user stories in spec content
 */
function countUserStories(content: string): number {
  const matches = content.match(/###\s*US\d+/g);
  return matches ? matches.length : 0;
}

/**
 * Count functional requirements in spec content
 */
function countFunctionalRequirements(content: string): number {
  const matches = content.match(/FR-\d+/g);
  return matches ? matches.length : 0;
}

/**
 * Execute the specify operation using agent.invoke delegation
 */
export async function executeSpecify(
  input: SpecifyInput,
  context: ActionContext
): Promise<SpecifyOutput> {
  const specFile = join(input.feature_dir, 'spec.md');

  context.logger.info(`Generating specification for: ${input.feature_dir}`);

  // Check for existing spec
  let existingSpec: string | undefined;
  if (await exists(specFile)) {
    try {
      existingSpec = await readFile(specFile);
      context.logger.info('Found existing spec, will update and improve');
    } catch {
      // Ignore read errors
    }
  }

  // Get issue context if URL provided
  let issueContext: string | undefined;
  if (input.issue_url) {
    try {
      // Use gh CLI to fetch issue details
      const result = await executeCommand('gh', ['issue', 'view', input.issue_url, '--json', 'title,body'], {
        cwd: context.workdir,
        timeout: 30000,
      });
      if (result.exitCode === 0) {
        const issueData = extractJSON(result.stdout) as { title?: string; body?: string } | null;
        if (issueData) {
          issueContext = `Title: ${issueData.title || 'Unknown'}\n\n${issueData.body || ''}`;
        }
      }
    } catch {
      context.logger.warn('Could not fetch issue context');
    }
  }

  // Build prompt
  const prompt = buildSpecifyPrompt(input.feature_dir, existingSpec, issueContext);

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
        spec_file: specFile,
        summary: 'Agent execution failed',
        user_stories_count: 0,
        functional_requirements_count: 0,
      };
    }

    // Read the generated spec to extract metrics
    let userStoriesCount = 0;
    let functionalRequirementsCount = 0;
    let summary = 'Specification generated';

    if (await exists(specFile)) {
      try {
        const specContent = await readFile(specFile);
        userStoriesCount = countUserStories(specContent);
        functionalRequirementsCount = countFunctionalRequirements(specContent);

        // Extract summary from first paragraph after "## Summary"
        const summaryMatch = specContent.match(/##\s*Summary\s*\n\s*(.+)/);
        if (summaryMatch?.[1]) {
          summary = summaryMatch[1].trim().substring(0, 200);
        }
      } catch {
        // Ignore read errors
      }
    }

    context.logger.info(`Specification generated: ${userStoriesCount} user stories, ${functionalRequirementsCount} requirements`);

    return {
      success: true,
      spec_file: specFile,
      summary,
      user_stories_count: userStoriesCount,
      functional_requirements_count: functionalRequirementsCount,
    };
  } catch (error) {
    context.logger.error(`Specify operation failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      spec_file: specFile,
      summary: error instanceof Error ? error.message : String(error),
      user_stories_count: 0,
      functional_requirements_count: 0,
    };
  }
}
