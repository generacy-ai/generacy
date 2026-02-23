/**
 * Clarify operation handler.
 * Uses agent.invoke to identify underspecified areas and generate clarification questions.
 */
import { join } from 'node:path';
import type { ActionContext } from '../../../../types/index.js';
import type { ClarifyInput, ClarifyOutput, ClarificationQuestion } from '../types.js';
import { executeCommand, extractJSON } from '../../../cli-utils.js';
import { exists, readFile, writeFile } from '../lib/fs.js';
import { StreamBatcher } from '../lib/stream-batcher.js';

/**
 * Build the prompt for initial clarification question generation
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
 * Build the prompt for resuming after developer answers.
 * Instructs the agent to fetch answers from the issue, consolidate,
 * and determine if follow-up questions are needed.
 */
function buildResumePrompt(
  featureDir: string,
  specContent: string,
  existingClarifications: string,
  issueNumber: number,
): string {
  return `You are resuming a clarification round for a feature specification.
Previously, clarification questions were posted to GitHub issue #${issueNumber}.
The developer has answered the questions and signaled that answers are ready.

Feature directory: ${featureDir}
Clarifications file: ${join(featureDir, 'clarifications.md')}

Current spec content:
${specContent}

Previous clarification questions:
${existingClarifications}

Instructions:
1. Run \`gh issue view ${issueNumber} --comments\` to read the developer's answers from the issue comments
2. Read the existing clarifications.md file
3. For each question, find the developer's answer in the issue comments and fill in the **Answer** field
4. Update the clarifications.md file with the consolidated answers
5. Evaluate whether the answers are sufficient or if follow-up questions are needed
6. If all questions are adequately answered:
   - Update ## Status to "Resolved"
   - Do NOT add any new questions
   - Return 0 for the count of NEW questions
7. If follow-up questions are needed (answers are ambiguous, incomplete, or raise new concerns):
   - Keep the answered questions with their answers
   - Add NEW follow-up questions at the end using the same format (### Q{N+1}: [Topic] etc.)
   - Update ## Status to "Follow-up Required"
   - Return ONLY the count of NEW follow-up questions (not the total)

IMPORTANT: Only generate follow-up questions if genuinely necessary. If the developer's answers
are clear and sufficient, resolve the clarifications and return 0 new questions so the workflow
can proceed.

Write updates to the clarifications file directly.
Return the count of NEW questions generated (0 if all resolved).`;
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

  // Detect resume: if clarifications.md already exists, this is a follow-up round
  const isResume = await exists(clarificationsFile);
  context.logger.info(
    isResume
      ? `Resuming clarification (answers received) for: ${input.feature_dir}`
      : `Generating clarification questions for: ${input.feature_dir}`
  );

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

  // Build prompt — use resume prompt if clarifications already exist and we have an issue number
  let prompt: string;
  if (isResume && input.issue_number) {
    let existingClarifications = '';
    try {
      existingClarifications = await readFile(clarificationsFile);
    } catch { /* will proceed with empty */ }
    prompt = buildResumePrompt(input.feature_dir, specContent, existingClarifications, input.issue_number);
  } else {
    prompt = buildClarifyPrompt(input.feature_dir, specContent);
  }

  // Track how many questions exist before the agent runs (for resume: detect new follow-ups)
  let previousQuestionCount = 0;
  if (isResume && (await exists(clarificationsFile))) {
    try {
      const existing = await readFile(clarificationsFile);
      previousQuestionCount = parseQuestions(existing).length;
    } catch { /* use 0 */ }
  }

  try {
    // Invoke Claude agent (--dangerously-skip-permissions for automated workflows)
    const args: string[] = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];
    const timeout = (input.timeout ?? 300) * 1000;

    // Set up streaming batchers for real-time log output
    const stdoutBatcher = new StreamBatcher((content) => {
      context.emitEvent?.({
        type: 'log:append',
        data: { stream: 'stdout', stepName: 'clarify', content },
      });
    });
    const stderrBatcher = new StreamBatcher((content) => {
      context.emitEvent?.({
        type: 'log:append',
        data: { stream: 'stderr', stepName: 'clarify', content },
      });
    });

    const result = await executeCommand('claude', args, {
      cwd: input.feature_dir,
      timeout,
      signal: context.signal,
      onStdout: (chunk) => stdoutBatcher.append(chunk),
      onStderr: (chunk) => stderrBatcher.append(chunk),
    });

    // Flush remaining batched content
    stdoutBatcher.flush();
    stderrBatcher.flush();

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

    // On resume: only count NEW questions (beyond what existed before the agent ran).
    // On initial run: all questions are new.
    const newQuestions = isResume
      ? questions.slice(previousQuestionCount)
      : questions;

    // Post NEW questions to GitHub issue
    let postedToIssue = false;
    if (input.issue_number && newQuestions.length > 0) {
      try {
        const header = isResume
          ? '## Follow-up Clarification Questions\n\nAfter reviewing your answers, the following additional questions need clarification:\n\n'
          : '## Clarification Questions\n\nThe following areas need clarification before proceeding:\n\n';

        let comment = header;
        for (let i = 0; i < newQuestions.length; i++) {
          const q = newQuestions[i];
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
        context.logger.info(`Posted ${newQuestions.length} ${isResume ? 'follow-up ' : ''}questions to issue #${input.issue_number}`);
      } catch (error) {
        context.logger.warn(`Failed to post to issue: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (isResume) {
      context.logger.info(
        newQuestions.length > 0
          ? `Generated ${newQuestions.length} follow-up questions`
          : `All clarifications resolved, proceeding`
      );
    } else {
      context.logger.info(`Generated ${questions.length} clarification questions`);
    }

    return {
      success: true,
      questions_count: newQuestions.length,
      questions: newQuestions,
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
