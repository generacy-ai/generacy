/**
 * Posts clarification questions to a GitHub issue when the
 * `waiting-for:clarification` gate is hit.
 *
 * Acts as a safety net — the clarify operation already attempts posting,
 * but can fail silently. This module reads `clarifications.md`, extracts
 * pending questions, and posts them as a comment with a dedup marker.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerContext, Logger } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the spec directory for a given issue number.
 *
 * Spec directories are named `{number}-{slug}` where the number may be
 * zero-padded (e.g., `008-fix-something`). This function parses the numeric
 * prefix from each directory and compares as integers to handle both padded
 * and unpadded naming conventions.
 */
function findSpecDir(specsDir: string, issueNumber: number): string | undefined {
  let dirs: string[];
  try {
    dirs = readdirSync(specsDir);
  } catch {
    return undefined;
  }
  return dirs.find((d) => {
    const match = d.match(/^(\d+)-/);
    return match !== null && parseInt(match[1]!, 10) === issueNumber;
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClarificationOption {
  /** Option label (A, B, C, etc.) */
  label: string;
  /** Option description */
  description: string;
}

export interface ClarificationQuestion {
  /** Question number (1-based) */
  number: number;
  /** Short topic/title */
  topic: string;
  /** Context explaining why the question matters */
  context: string;
  /** The actual question text */
  question: string;
  /** Optional multiple-choice options */
  options?: ClarificationOption[];
  /** Whether the question has been answered */
  answered: boolean;
  /** The answer text, if answered */
  answer?: string;
}

export interface ClarificationPostResult {
  /** Whether a comment was posted */
  posted: boolean;
  /** Number of pending questions found */
  pendingCount: number;
  /** Reason if not posted */
  reason?: 'no-pending-questions' | 'already-posted' | 'file-not-found' | 'post-failed';
}

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

const MARKER_PREFIX = '<!-- generacy-clarifications:';

export function clarificationMarker(issueNumber: number): string {
  return `${MARKER_PREFIX}${issueNumber} -->`;
}

// ---------------------------------------------------------------------------
// isQuestionComment
// ---------------------------------------------------------------------------

/**
 * Detect whether a comment body is a clarification *questions* comment
 * (posted by the bot) rather than a human *answers* comment.
 *
 * The bot posts questions in two ways:
 * 1. Via `postClarifications()` — includes `<!-- generacy-clarifications:N -->` marker
 * 2. Via the clarify CLI operation — includes a "Clarification Questions" heading
 * 3. Via the CLI marker — includes `<!-- generacy-clarification:` prefix
 * 4. Via the stage comment — includes `<!-- generacy-stage:` prefix
 *
 * Human answers typically look like `Q1: B` or `Q1: answer text` without
 * these markers.
 */
export function isQuestionComment(body: string): boolean {
  // Orchestrator-posted clarification comment
  if (body.includes(MARKER_PREFIX)) return true;
  // CLI-posted clarification comment
  if (body.includes('<!-- generacy-clarification:')) return true;
  // Stage tracking comment
  if (body.includes('<!-- generacy-stage:')) return true;
  // Clarify operation's direct posting (with or without emoji).
  // Negative lookahead excludes answer headings like
  // "## Answers to Clarification Questions".
  if (/##\s+(?!Answers\b).*Clarification Questions/.test(body)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// parseClarifications
// ---------------------------------------------------------------------------

/**
 * Parse a `clarifications.md` file content into structured questions.
 *
 * Expected markdown format:
 * ```
 * ### Q1: Topic
 * **Context**: ...
 * **Question**: ...
 * **Options**: (optional)
 * - A) ...
 * **Answer**: *Pending*
 * ```
 */
export function parseClarifications(content: string): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];

  // Split by question headers (### Q{n}: ...)
  const questionPattern = /^### Q(\d+):\s*(.+)$/gm;
  const matches = [...content.matchAll(questionPattern)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const number = parseInt(match[1]!, 10);
    const topic = match[2]!.trim();
    const startIdx = match.index! + match[0].length;
    const endIdx = i + 1 < matches.length ? matches[i + 1]!.index! : content.length;
    const section = content.slice(startIdx, endIdx);

    // Extract context
    const contextMatch = section.match(/\*\*Context\*\*:\s*(.+?)(?=\n\*\*|\n###|$)/s);
    const context = contextMatch ? contextMatch[1]!.trim() : '';

    // Extract question
    const questionMatch = section.match(/\*\*Question\*\*:\s*(.+?)(?=\n\*\*|\n###|$)/s);
    const question = questionMatch ? questionMatch[1]!.trim() : '';

    // Extract options
    const optionsMatch = section.match(/\*\*Options\*\*:\s*\n((?:- .+\n?)+)/);
    let options: ClarificationOption[] | undefined;
    if (optionsMatch) {
      options = [];
      const optionLines = optionsMatch[1]!.trim().split('\n');
      for (const line of optionLines) {
        const optMatch = line.match(/^- ([A-Z])[):]\s*(.+)$/);
        if (optMatch) {
          options.push({ label: optMatch[1]!, description: optMatch[2]!.trim() });
        }
      }
      if (options.length === 0) options = undefined;
    }

    // Check answer status
    const answerMatch = section.match(/\*\*Answer\*\*:\s*(.+)/);
    const answerText = answerMatch ? answerMatch[1]!.trim() : '';
    const answered = !!answerText && answerText !== '*Pending*';

    const q: ClarificationQuestion = {
      number,
      topic,
      context,
      question,
      answered,
    };
    if (options) q.options = options;
    if (answered && answerText) q.answer = answerText;
    questions.push(q);
  }

  return questions;
}

// ---------------------------------------------------------------------------
// formatComment
// ---------------------------------------------------------------------------

/**
 * Format pending questions as a GitHub comment with HTML dedup marker.
 */
export function formatComment(questions: ClarificationQuestion[], issueNumber: number): string {
  const pending = questions.filter((q) => !q.answered);
  if (pending.length === 0) return '';

  const marker = clarificationMarker(issueNumber);
  const lines: string[] = [
    marker,
    '## Clarification Questions',
    '',
    'The following areas need clarification before proceeding:',
    '',
  ];

  for (const q of pending) {
    lines.push(`### Q${q.number}: ${q.topic}`);
    if (q.context) {
      lines.push(`**Context**: ${q.context}`);
      lines.push('');
    }
    lines.push(`**Question**: ${q.question}`);
    if (q.options && q.options.length > 0) {
      lines.push('');
      lines.push('**Options**:');
      for (const opt of q.options) {
        lines.push(`- ${opt.label}) ${opt.description}`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('**How to answer**: Reply to this issue with your answers in the format:');
  lines.push('```');
  for (const q of pending) {
    lines.push(`Q${q.number}: your answer here`);
  }
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// hasPendingClarifications
// ---------------------------------------------------------------------------

/**
 * Check whether the clarify phase produced pending questions.
 *
 * Returns `true` if `clarifications.md` exists in the spec directory and
 * contains at least one unanswered question. Used by the phase loop to
 * evaluate the `on-questions` gate condition.
 */
export function hasPendingClarifications(
  checkoutPath: string,
  issueNumber: number,
): boolean {
  const specsDir = join(checkoutPath, 'specs');
  const specDir = findSpecDir(specsDir, issueNumber);
  if (!specDir) return false;

  const clarificationsPath = join(specsDir, specDir, 'clarifications.md');

  let content: string;
  try {
    content = readFileSync(clarificationsPath, 'utf-8');
  } catch {
    return false;
  }

  const questions = parseClarifications(content);
  return questions.some((q) => !q.answered);
}

// ---------------------------------------------------------------------------
// integrateClarificationAnswers
// ---------------------------------------------------------------------------

/**
 * Extract the actual answer from a multi-line captured section.
 *
 * When Q is inside a heading (`### Q1: Topic`), the text after `Q1:` starts
 * with the topic name, not the answer. This helper looks for an embedded
 * `**Answer: value**` or `**Answer**: value` line and returns the answer
 * portion. Returns `undefined` if no embedded answer is found.
 */
function extractEmbeddedAnswer(text: string): string | undefined {
  // Format: **Answer: value** with optional trailing text
  const m1 = text.match(/\*\*Answer:\s*(.+?)\*\*(.*)$/m);
  if (m1) {
    return (m1[1]! + m1[2]!).trim();
  }

  // Format: **Answer**: value
  const m2 = text.match(/\*\*Answer\*\*:\s*(.+)$/m);
  if (m2) {
    return m2[1]!.trim();
  }

  return undefined;
}

/**
 * Parse answers from GitHub issue comments.
 *
 * Scans comment bodies for patterns like `Q1: answer text` and extracts
 * answers keyed by question number. Later answers for the same question
 * override earlier ones (last wins).
 *
 * Supports two answer formats:
 * - Simple:  `Q1: answer text`
 * - Heading: `### Q1: Topic\n**Answer: B** — explanation`
 *
 * For heading format, the actual answer is extracted from the embedded
 * `**Answer**` line rather than the topic name after `Q1:`.
 */
function parseAnswersFromComments(
  comments: Array<{ body: string }>,
  questionNumbers: number[],
): Map<number, string> {
  const answers = new Map<number, string>();

  for (const comment of comments) {
    // Match Q patterns with optional heading markers (### Q1:) and bold (**Q1**:).
    // The lookahead also handles heading-prefixed Q patterns so that sections
    // like `### Q1: ...` and `### Q2: ...` are properly delimited instead of
    // Q1 consuming everything up to $ when headings are used.
    const regex =
      /(?:#{1,6}\s+)?(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*?)(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)/gs;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(comment.body)) !== null) {
      const numStr = match[1];
      const answerStr = match[2];
      if (!numStr || answerStr === undefined) continue;
      const questionNumber = parseInt(numStr, 10);
      let answer = answerStr.trim();

      // When Q is in a heading (### Q1: Topic), the captured text starts with
      // the topic name, not the answer. Look for an embedded **Answer** line.
      if (answer.includes('\n')) {
        const embedded = extractEmbeddedAnswer(answer);
        if (embedded) {
          answer = embedded;
        }
      }

      // Skip placeholder text that is not a real answer
      if (answer && answer !== '*Pending*' && questionNumbers.includes(questionNumber)) {
        answers.set(questionNumber, answer);
      }
    }
  }

  return answers;
}

export interface IntegrationResult {
  /** Number of answers integrated into the file */
  integrated: number;
  /** Reason if nothing was integrated */
  reason?: 'no-spec-dir' | 'no-file' | 'no-pending' | 'no-answers' | 'no-changes';
}

/**
 * Integrate clarification answers from GitHub issue comments into the local
 * clarifications.md file.
 *
 * This is a defensive measure: the Claude CLI clarify command is supposed to
 * call `manage_clarifications update_answer` to persist answers, but if it
 * fails to do so, this function ensures the answers are integrated before
 * the gate checker evaluates `hasPendingClarifications`.
 */
export async function integrateClarificationAnswers(
  context: WorkerContext,
  logger: Logger,
): Promise<IntegrationResult> {
  const { github, item, checkoutPath } = context;
  const { owner, repo, issueNumber } = item;

  // 1. Find clarifications.md
  const specsDir = join(checkoutPath, 'specs');
  const specDir = findSpecDir(specsDir, issueNumber);
  if (!specDir) {
    return { integrated: 0, reason: 'no-spec-dir' };
  }

  const clarificationsPath = join(specsDir, specDir, 'clarifications.md');

  let content: string;
  try {
    content = readFileSync(clarificationsPath, 'utf-8');
  } catch {
    return { integrated: 0, reason: 'no-file' };
  }

  // 2. Parse questions to find pending ones
  const questions = parseClarifications(content);
  const pendingQuestions = questions.filter((q) => !q.answered);
  if (pendingQuestions.length === 0) {
    return { integrated: 0, reason: 'no-pending' };
  }

  const pendingNumbers = pendingQuestions.map((q) => q.number);

  // 3. Fetch GitHub issue comments and parse answers
  let comments: Array<{ body: string }>;
  try {
    comments = await github.getIssueComments(owner, repo, issueNumber);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to fetch issue comments for answer integration',
    );
    return { integrated: 0, reason: 'no-answers' };
  }

  // Filter out comments that contain the clarification questions themselves.
  // Without this, parseAnswersFromComments matches Q patterns from the bot's
  // own questions comment (e.g., "### Q1: Topic") and treats the topic text
  // as an answer, causing the gate to incorrectly see all questions as answered.
  const answerComments = comments.filter((c) => !isQuestionComment(c.body));

  const answers = parseAnswersFromComments(answerComments, pendingNumbers);
  if (answers.size === 0) {
    return { integrated: 0, reason: 'no-answers' };
  }

  // 4. Update the file content — replace *Pending* with actual answers
  //    for each matched question
  let updatedContent = content;
  for (const [questionNum, answer] of answers) {
    // Match the answer line within the correct question section.
    // The pattern finds ### Q{N}: ... **Answer**: *Pending* and replaces
    // the *Pending* part with the actual answer text.
    const pattern = new RegExp(
      `(### Q${questionNum}:[\\s\\S]*?\\*\\*Answer\\*\\*:\\s*)\\*Pending\\*`,
    );
    updatedContent = updatedContent.replace(pattern, `$1${answer}`);
  }

  if (updatedContent === content) {
    return { integrated: 0, reason: 'no-changes' };
  }

  writeFileSync(clarificationsPath, updatedContent);
  logger.info(
    { count: answers.size, issueNumber },
    'Integrated GitHub answers into clarifications.md',
  );

  return { integrated: answers.size };
}

// ---------------------------------------------------------------------------
// postClarifications
// ---------------------------------------------------------------------------

/**
 * Orchestrate reading clarifications.md, parsing, dedup-checking, and posting.
 */
export async function postClarifications(
  context: WorkerContext,
  logger: Logger,
): Promise<ClarificationPostResult> {
  const { github, item, checkoutPath } = context;
  const { owner, repo, issueNumber } = item;

  // 1. Find clarifications.md in the specs directory
  const specsDir = join(checkoutPath, 'specs');
  const specDir = findSpecDir(specsDir, issueNumber);

  const clarificationsPath = specDir
    ? join(specsDir, specDir, 'clarifications.md')
    : undefined;

  if (!clarificationsPath) {
    logger.warn({ issueNumber }, 'No spec directory found for issue — skipping clarification posting');
    return { posted: false, pendingCount: 0, reason: 'file-not-found' };
  }

  // 2. Read the file
  let content: string;
  try {
    content = readFileSync(clarificationsPath, 'utf-8');
  } catch {
    logger.warn({ path: clarificationsPath }, 'clarifications.md not found — skipping');
    return { posted: false, pendingCount: 0, reason: 'file-not-found' };
  }

  // 3. Parse questions
  const questions = parseClarifications(content);
  const pending = questions.filter((q) => !q.answered);

  if (pending.length === 0) {
    logger.info('No pending clarification questions — skipping posting');
    return { posted: false, pendingCount: 0, reason: 'no-pending-questions' };
  }

  // 4. Check for existing clarification comment (dedup)
  // Check both our own marker and the Claude CLI clarify phase marker
  const marker = clarificationMarker(issueNumber);
  const cliMarkerPrefix = '<!-- generacy-clarification:';
  const comments = await github.getIssueComments(owner, repo, issueNumber);
  const existing = comments.find(
    (c) => c.body.includes(marker) || c.body.includes(cliMarkerPrefix),
  );

  if (existing) {
    logger.info({ commentId: existing.id }, 'Clarification comment already posted — skipping');
    return { posted: false, pendingCount: pending.length, reason: 'already-posted' };
  }

  // 5. Format and post
  const body = formatComment(questions, issueNumber);
  try {
    await github.addIssueComment(owner, repo, issueNumber, body);
    logger.info({ pendingCount: pending.length }, 'Posted clarification questions to issue');
    return { posted: true, pendingCount: pending.length };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to post clarification comment',
    );
    return { posted: false, pendingCount: pending.length, reason: 'post-failed' };
  }
}
