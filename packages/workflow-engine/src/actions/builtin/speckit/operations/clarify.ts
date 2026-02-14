/**
 * Clarify operation handler.
 * Uses agent.invoke to identify underspecified areas and generate clarification questions.
 */
import { join } from 'node:path';
import type { ActionContext } from '../../../../types/index.js';
import type { ClarifyInput, ClarifyOutput, ClarificationQuestion } from '../types.js';
import { executeCommand, extractJSON } from '../../../cli-utils.js';
import { exists, readFile, writeFile } from '../lib/fs.js';

/**
 * Build the prompt for clarification question generation
 */
function buildClarifyPrompt(featureDir: string, specContent: string): string {
  return `Analyze the feature specification and identify underspecified areas that need clarification.

Feature directory: ${featureDir}
Clarifications file: ${join(featureDir, 'clarifications.md')}

Current spec content:
${specContent}

Instructions:
1. Read and analyze the specification carefully
2. Identify ambiguous or incomplete requirements
3. Consider technical implementation decisions that need input
4. Look for user experience decisions that need stakeholder input
5. Check for missing edge cases or error handling requirements

For each area needing clarification, generate a question with:
- Topic: Short identifier (e.g., "Authentication Method", "Error Handling")
- Context: Why this question matters (1-2 sentences)
- Question: The specific question to ask
- Options (if applicable): 2-4 concrete choices with descriptions

Format the clarifications file as markdown with this structure:
# Clarification Questions

## Status: Pending

## Questions

### Q1: [Topic]
**Context**: [Why this matters]
**Question**: [The specific question]
**Options**:
- A) [Option label]: [Description]
- B) [Option label]: [Description]
**Answer**: [Leave empty for now]

Write the clarifications to the file directly.
Return the count of questions generated.`;
}

/**
 * Parse questions from clarifications file content
 */
function parseQuestions(content: string): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const questionBlocks = content.split(/###\s*Q\d+:/);

  for (const block of questionBlocks.slice(1)) {
    const topicMatch = block.match(/^\s*([^\n]+)/);
    const contextMatch = block.match(/\*\*Context\*\*:\s*([^\n]+)/);
    const questionMatch = block.match(/\*\*Question\*\*:\s*([^\n]+)/);

    if (topicMatch?.[1] && questionMatch?.[1]) {
      const question: ClarificationQuestion = {
        topic: topicMatch[1].trim(),
        context: contextMatch?.[1]?.trim() ?? '',
        question: questionMatch[1].trim(),
      };

      // Parse options if present
      const optionsMatch = block.match(/\*\*Options\*\*:\s*\n([\s\S]*?)(?=\*\*Answer|$)/);
      if (optionsMatch?.[1]) {
        const optionsText = optionsMatch[1];
        const optionMatches = optionsText.matchAll(/-\s*([A-Z])\)\s*([^:]+):\s*([^\n]+)/g);
        const options: Array<{ label: string; description: string }> = [];
        for (const match of optionMatches) {
          if (match[1] && match[2] && match[3]) {
            options.push({
              label: match[1],
              description: `${match[2].trim()}: ${match[3].trim()}`,
            });
          }
        }
        if (options.length > 0) {
          question.options = options;
        }
      }

      questions.push(question);
    }
  }

  return questions;
}

/**
 * Execute the clarify operation using agent.invoke delegation
 */
export async function executeClarify(
  input: ClarifyInput,
  context: ActionContext
): Promise<ClarifyOutput> {
  const specFile = join(input.feature_dir, 'spec.md');
  const clarificationsFile = join(input.feature_dir, 'clarifications.md');

  context.logger.info(`Generating clarification questions for: ${input.feature_dir}`);

  // Read the spec file
  if (!(await exists(specFile))) {
    return {
      success: false,
      questions_count: 0,
      questions: [],
      clarifications_file: clarificationsFile,
    };
  }

  let specContent: string;
  try {
    specContent = await readFile(specFile);
  } catch (error) {
    context.logger.error(`Failed to read spec file: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      questions_count: 0,
      questions: [],
      clarifications_file: clarificationsFile,
    };
  }

  // Build prompt
  const prompt = buildClarifyPrompt(input.feature_dir, specContent);

  try {
    // Invoke Claude agent (--dangerously-skip-permissions for automated workflows)
    const args: string[] = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];
    const timeout = (input.timeout ?? 300) * 1000;

    const result = await executeCommand('claude', args, {
      cwd: input.feature_dir,
      timeout,
      signal: context.signal,
    });

    if (result.exitCode !== 0) {
      return {
        success: false,
        questions_count: 0,
        questions: [],
        clarifications_file: clarificationsFile,
      };
    }

    // Parse the generated clarifications
    let questions: ClarificationQuestion[] = [];
    if (await exists(clarificationsFile)) {
      try {
        const clarificationsContent = await readFile(clarificationsFile);
        questions = parseQuestions(clarificationsContent);
      } catch {
        // Ignore read errors
      }
    }

    // Post to GitHub issue if requested
    let postedToIssue = false;
    if (input.issue_number && questions.length > 0) {
      try {
        // Format questions for GitHub comment
        let comment = '## Clarification Questions\n\n';
        comment += 'The following areas need clarification before proceeding:\n\n';
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          if (q) {
            comment += `### Q${i + 1}: ${q.topic}\n`;
            comment += `**Context**: ${q.context}\n\n`;
            comment += `**Question**: ${q.question}\n`;
            if (q.options) {
              comment += '\n**Options**:\n';
              for (const opt of q.options) {
                comment += `- ${opt.label}) ${opt.description}\n`;
              }
            }
            comment += '\n---\n\n';
          }
        }

        await executeCommand('gh', [
          'issue', 'comment', String(input.issue_number),
          '--body', comment,
        ], {
          cwd: context.workdir,
          timeout: 30000,
        });
        postedToIssue = true;
        context.logger.info(`Posted ${questions.length} questions to issue #${input.issue_number}`);
      } catch (error) {
        context.logger.warn(`Failed to post to issue: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    context.logger.info(`Generated ${questions.length} clarification questions`);

    return {
      success: true,
      questions_count: questions.length,
      questions,
      posted_to_issue: postedToIssue,
      clarifications_file: clarificationsFile,
    };
  } catch (error) {
    context.logger.error(`Clarify operation failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      questions_count: 0,
      questions: [],
      clarifications_file: clarificationsFile,
    };
  }
}
