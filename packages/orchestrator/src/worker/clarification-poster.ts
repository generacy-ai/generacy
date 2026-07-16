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
import {
  isTrustedCommentAuthor,
  tryLoadCommentTrustConfig,
  type CommentTrustContext,
  PENDING_ANSWER_LITERAL,
  isPendingAnswerValue,
} from '@generacy-ai/workflow-engine';
import type { Comment as TrustComment } from '@generacy-ai/workflow-engine';
import {
  commentCarriesQuestionMarker,
  matchClarificationQuestionMarker,
  commentCarriesAnswerMarker,
} from './clarification-markers.js';
import type { WorkerContext, Logger } from './types.js';

/**
 * #958 FR-005 / FR-006 — pre-parse pass over a comment body that drops every
 * line whose first non-EOL character is `>` (the column-0 quote rule already
 * codified for markers in `clarification-markers.ts`).
 *
 * Returns `stripped` — the body with all quoted lines filtered out — plus a
 * `headBeforeFirstQuote` slice preserved for FR-006 diagnostics. The parser
 * runs against `stripped` so:
 *   - a quoted `> ### Q2: …` cannot bleed into Q1's capture (FR-005), AND
 *   - a valid trailing `Q2: …` sitting after a quoted block still integrates
 *     (a naive "cut at first quote" would discard it — spec §Observed B row 2).
 *
 * The `> `-prefix predicate is the same one `clarification-markers.ts` uses
 * for column-0 marker matching — a leading tab / space disqualifies. Blank
 * lines (`>` followed by nothing) also drop.
 */
export function stripQuotedLines(body: string): {
  stripped: string;
  headBeforeFirstQuote: string;
} {
  const lines = body.split('\n');
  const nonQuoted = lines.filter((line) => !line.startsWith('>'));
  const firstQuotedIdx = lines.findIndex((line) => line.startsWith('>'));
  const headBeforeFirstQuote =
    firstQuotedIdx === -1 ? body : lines.slice(0, firstQuotedIdx).join('\n');
  return {
    stripped: nonQuoted.join('\n'),
    headBeforeFirstQuote,
  };
}

/**
 * Regex escape helper for building the write-back pattern with a shared
 * literal — `PENDING_ANSWER_LITERAL` contains `*` metacharacters.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve cluster bot login from env vars (identity.ts chain). The
 * `gh api /user` fallback is intentionally skipped here — it fails on
 * App-token clusters and env vars are the load-bearing tier in-cluster.
 */
function resolveBotLoginFromEnv(): string | undefined {
  return process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME'] ?? undefined;
}

/**
 * Adapter: pino-style logger (WorkerContext.Logger) → workflow-engine Logger.
 * The workflow-engine helper calls `logger.warn(message, obj)` (message first);
 * pino-style loggers accept `warn(obj, message)`. Bridge the arg order.
 */
function toEngineLogger(logger: Logger): CommentTrustContext['logger'] {
  return {
    info: (msg: string, meta?: unknown) => {
      if (meta && typeof meta === 'object') logger.info(meta as Record<string, unknown>, msg);
      else logger.info(msg);
    },
    warn: (msg: string, meta?: unknown) => {
      if (meta && typeof meta === 'object') logger.warn(meta as Record<string, unknown>, msg);
      else logger.warn(msg);
    },
    error: (msg: string, meta?: unknown) => {
      if (meta && typeof meta === 'object') logger.error(meta as Record<string, unknown>, msg);
      else logger.error(msg);
    },
    debug: (msg: string, meta?: unknown) => {
      if (meta && typeof meta === 'object') logger.debug(meta as Record<string, unknown>, msg);
      else logger.debug(msg);
    },
  };
}

/**
 * Emit a structured skip-log for FR-010. Body is deliberately absent
 * (SC-003).
 */
function logCommentSkipped(
  logger: Logger,
  surface: 'answer-scanner' | 'clarify-resume' | 'pr-feedback',
  comment: TrustComment,
  reason: string,
): void {
  logger.info(
    {
      event: 'comment-skipped',
      surface,
      commentId: comment.id,
      author: comment.author,
      authorAssociation: comment.authorAssociation,
      reason,
    },
    'Skipped comment from untrusted author',
  );
}

/**
 * Marker for the bot's untrusted-answer explainer comment. Used to
 * dedupe repeat postings for the same skipped comment (FR-013 idempotence).
 */
const UNTRUSTED_ANSWER_MARKER_PREFIX = '<!-- generacy-untrusted-answer:';

function untrustedAnswerMarker(commentId: number): string {
  return `${UNTRUSTED_ANSWER_MARKER_PREFIX}${commentId} -->`;
}

/**
 * Shared opener fragment for a `Q<n>` clarification-answer block (#949).
 *
 * Composes into three sites, all in this file:
 *   1. The outer regex opener in `parseAnswersFromComments`.
 *   2. The outer regex terminator lookahead in `parseAnswersFromComments`
 *      (via `QN_TERMINATOR_LOOKAHEAD`) — MUST stay in lockstep with (1)
 *      or multi-question cockpit bodies open exactly one block (Q1's lazy
 *      `(.*?)` swallows Q2..Qn to EOF).
 *   3. `commentMatchesAnswerPattern` (via `QN_OPENER_PATTERN_NONCAPTURING`)
 *      — used by the FR-013 untrusted-author explainer gate.
 *
 * DELIBERATELY NOT USED by `sourceHadQuestionHeadings` — that discriminator
 * requires a colon after `Q<n>` because it separates engine-authored
 * question comments from cockpit answer delimiters (see comment at that
 * site).
 *
 * Grammar accepted (line-anchored via `(?:^|\n)`):
 *   [heading] [**]Q<n>[**]              (colon-less — heading REQUIRED)
 *   [heading] [**]Q<n>[**]:              (colon — heading optional; bare Q<n>: OK)
 *
 * Trailing captures use `[^\n]*` (not `.*`) so the opener does not devour
 * body content across newlines under the outer regex's `s` flag.
 *
 * Two arms of the disjunction produce four capture groups:
 *   [1] Q number (colon-less arm)
 *   [2] topic/trailing (colon-less arm)
 *   [3] Q number (colon-bearing arm)
 *   [4] answer/trailing (colon-bearing arm)
 * Consumers use `pickQnMatch()` to resolve to a single `{ qn, trailing }`.
 */
const QN_OPENER_PATTERN =
  '(?:^|\\n)(?:(?:#{1,6}\\s+(?:\\*\\*)?Q(\\d+)(?:\\*\\*)?(?::\\s*([^\\n]*))?)|(?:(?:\\*\\*)?Q(\\d+)(?:\\*\\*)?:\\s*([^\\n]*)))';

/**
 * Non-capturing variant of `QN_OPENER_PATTERN` for boolean predicates.
 * Every `(\d+)` numeric-capture replaced with `(?:\d+)` and every
 * `([^\n]*)` trailing capture replaced with `(?:[^\n]*)`.
 */
const QN_OPENER_PATTERN_NONCAPTURING =
  '(?:^|\\n)(?:(?:#{1,6}\\s+(?:\\*\\*)?Q(?:\\d+)(?:\\*\\*)?(?::\\s*(?:[^\\n]*))?)|(?:(?:\\*\\*)?Q(?:\\d+)(?:\\*\\*)?:\\s*(?:[^\\n]*)))';

/**
 * Block terminator lookahead used by the outer regex in
 * `parseAnswersFromComments`. Requires a leading `\n` (no `^` alternation)
 * so it cannot re-anchor mid-line inside a captured body.
 *
 * Coupling invariant: MUST accept the same set of next-opener shapes that
 * `QN_OPENER_PATTERN` accepts as openers. Widen this in exact lockstep
 * with the opener or multi-question bodies silently open one block.
 */
const QN_TERMINATOR_LOOKAHEAD =
  '(?=(?:\\n(?:(?:#{1,6}\\s+(?:\\*\\*)?Q\\d+(?:\\*\\*)?(?::[^\\n]*)?)|(?:(?:\\*\\*)?Q\\d+(?:\\*\\*)?:[^\\n]*)))|$)';

/**
 * Resolve `{ qn, trailing }` from the two disjunction arms of
 * `QN_OPENER_PATTERN`. Exactly one arm matches per opener occurrence.
 */
function pickQnMatch(m: RegExpExecArray): { qn: number; trailing: string } {
  const num = m[1] ?? m[3];
  const trail = m[2] ?? m[4] ?? '';
  return { qn: parseInt(num!, 10), trailing: trail };
}

/**
 * Detect whether a comment body matches the `Q<N>:` answer pattern that
 * `parseAnswersFromComments` would attempt to consume. Used to decide
 * whether an untrusted-comment skip warrants an explainer bot comment
 * (matched) or log-only treatment (unmatched, generic drive-by).
 */
export function commentMatchesAnswerPattern(body: string): boolean {
  return new RegExp(QN_OPENER_PATTERN_NONCAPTURING).test(body);
}

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
 * Split a comment body into sections keyed by `### Q<n>:` headings.
 * Each section spans from a heading to the next `### ` heading (or EOF).
 * Returns an empty array if no `### Q<n>:` heading is present.
 */
function splitByQuestionHeading(body: string): string[] {
  const headingPattern = /^### Q\d+:.*$/gm;
  const headings = [...body.matchAll(headingPattern)];
  if (headings.length === 0) return [];

  const sections: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i]!.index!;
    const headingLen = headings[i]![0].length;
    const nextTopLevelHeading = body.slice(start + headingLen).search(/^### /m);
    const end =
      nextTopLevelHeading === -1
        ? body.length
        : start + headingLen + nextTopLevelHeading;
    sections.push(body.slice(start, end));
  }
  return sections;
}

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
  // FR-101 / FR-108 / FR-109 — engine-authored questions markers.
  // Delegated to the single-source predicate in clarification-markers.ts;
  // adding a new dialect only touches that file.
  if (commentCarriesQuestionMarker(body)) return true;
  // Clarify operation's direct posting (with or without emoji).
  // Negative lookahead excludes answer headings like
  // "## Answers to Clarification Questions".
  if (/##\s+(?!Answers\b).*Clarification Questions/.test(body)) return true;
  // FR-001: variant question-comment shape — any `### Q<n>:` heading section
  // containing question-side markup that never appears in human answers.
  for (const section of splitByQuestionHeading(body)) {
    if (
      section.includes('**Question**:') ||
      section.includes('**Context**:') ||
      section.includes('**Options**:')
    ) {
      return true;
    }
  }
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
 * **Answer**: PENDING_ANSWER_LITERAL
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

    // Extract options. The block runs to the next `**Field**:` line, `###`
    // heading, or EOF — the same delimiters Context and Question use above.
    // An option's description may hard-wrap or carry indented sub-bullets;
    // such continuation lines belong to the option above them. Matching only
    // consecutive `- ` lines would end the block at the first continuation,
    // truncating that option mid-sentence and dropping every option after it.
    const optionsMatch = section.match(/\*\*Options\*\*:\s*\n([\s\S]+?)(?=\n\*\*|\n###|$)/);
    let options: ClarificationOption[] | undefined;
    if (optionsMatch) {
      options = [];
      for (const line of optionsMatch[1]!.trim().split('\n')) {
        const optMatch = line.match(/^- ([A-Z])[):]\s*(.*)$/);
        if (optMatch) {
          options.push({ label: optMatch[1]!, description: optMatch[2]! });
        } else if (options.length > 0) {
          options[options.length - 1]!.description += `\n${line}`;
        }
      }
      for (const opt of options) opt.description = opt.description.trim();
      options = options.filter((opt) => opt.description !== '');
      if (options.length === 0) options = undefined;
    }

    // Check answer status. Empty / whitespace-only / any `[…]`-bracketed
    // placeholder / literal PENDING_ANSWER_LITERAL all read as "not
    // answered" (FR-012).
    const answerMatch = section.match(/\*\*Answer\*\*:\s*(.+)/);
    const answerText = answerMatch ? answerMatch[1]!.trim() : '';
    const answered = !!answerText && !isPendingAnswerValue(answerText);

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
 * #958 FR-007 — Check whether the clarify phase produced pending questions.
 *
 * Fail-closed contract: unknown states pause on a human gate. The three
 * unknown branches all return `true`:
 *  - missing spec directory
 *  - `readFileSync` throws (unreadable / permission / I/O)
 *  - non-empty file content with zero parsed questions (parse failure)
 *
 * Legit empty file (`content.trim() === ''`) is the ONE branch that returns
 * `false`: a `clarifications.md` file with no questions at all is a valid
 * post-clarify state.
 *
 * Returns `true` when at least one parsed question is unanswered.
 */
export function hasPendingClarifications(
  checkoutPath: string,
  issueNumber: number,
): boolean {
  const specsDir = join(checkoutPath, 'specs');
  const specDir = findSpecDir(specsDir, issueNumber);
  if (!specDir) return true;

  const clarificationsPath = join(specsDir, specDir, 'clarifications.md');

  let content: string;
  try {
    content = readFileSync(clarificationsPath, 'utf-8');
  } catch {
    return true;
  }

  // Legit empty file — no questions is a valid resolved state.
  if (content.trim() === '') return false;

  const questions = parseClarifications(content);
  // Non-empty content that parsed to zero questions ⇒ parse failure; pause.
  if (questions.length === 0) return true;
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
export function extractEmbeddedAnswer(text: string): string | undefined {
  // Format: **Answer:** value (#949 — cockpit dialect; colon INSIDE bold).
  // Placed BEFORE m1/m2 because `**Answer:**` is strictly more specific
  // than `**Answer: ...**` — the `\*\*` right after the colon disambiguates.
  const m0 = text.match(/\*\*Answer:\*\*\s*(.+?)$/m);
  if (m0) {
    let answer = m0[1]!.trim();
    // Q1→B: if a `**Rationale:** …` line follows inside the same captured
    // block, join it onto the answer so clarifications.md preserves the *why*.
    const r = text.match(/\n\*\*Rationale:\*\*\s*(.+?)$/m);
    if (r) answer = `${answer}\nRationale: ${r[1]!.trim()}`;
    return answer;
  }

  // Format: **Answer: value** with optional trailing text (engine dialect)
  const m1 = text.match(/\*\*Answer:\s*(.+?)\*\*(.*)$/m);
  if (m1) {
    return (m1[1]! + m1[2]!).trim();
  }

  // Format: **Answer**: value (engine dialect — colon OUTSIDE bold)
  const m2 = text.match(/\*\*Answer\*\*:\s*(.+)$/m);
  if (m2) {
    return m2[1]!.trim();
  }

  return undefined;
}

interface ParsedAnswer {
  /** The extracted answer text, post-trim + post-extractEmbeddedAnswer. */
  answer: string;
  /** The GitHub numeric id of the comment this answer was captured from. */
  sourceCommentId: number;
  /** true if the source comment body contains at least one `### Q<n>:` heading. */
  sourceHadQuestionHeadings: boolean;
  /**
   * #958 — carries the source comment's `viewerDidAuthor` state into the
   * caller so FR-004 can pick the asymmetric blast-radius branch (skip vs
   * abort) at integration time.
   */
  sourceViewerDidAuthor: boolean | undefined;
}

/**
 * #958 — Parse answers from GitHub issue comments.
 *
 * Two properties this function guarantees over the pre-#958 version:
 *  1. **FR-005 quote-stripping**: each comment body is split at the first
 *     `>`-prefixed line via `stripQuotedLines()`. Only the head (before the
 *     first quoted line) is parsed for `Q<n>:` answers. A quoted
 *     `> ### Q2: …` cannot bleed into Q1's capture, and a trailing quoted
 *     `> **Question**: …` cannot discard a valid leading answer (FR-006).
 *  2. **Bounding on quoted headers**: the regex terminator also matches a
 *     `> `-quoted `Q<n>:` line so any residual quoted question in the head
 *     acts as a boundary (belt-and-suspenders after quote-stripping).
 *
 * Note: the L488 `.includes('**Question**:')` sniff is deleted. Authorship
 * is decided by `viewerDidAuthor` in the caller (FR-001).
 *
 * Supports two answer formats:
 *  - Simple:  `Q1: answer text`
 *  - Heading: `### Q1: Topic\n**Answer: B** — explanation`
 */
export function parseAnswersFromComments(
  comments: Array<{
    id: number;
    body: string;
    created_at?: string;
    viewerDidAuthor?: boolean;
  }>,
  questionNumbers: number[],
  _logger: Logger,
): Map<number, ParsedAnswer> {
  const answers = new Map<number, ParsedAnswer>();

  for (const comment of comments) {
    // FR-005/FR-006 (#958): drop every `> `-quoted line, then parse the
    // surviving body. Quoted `> ### Q<n>:` cannot bleed into a prior capture;
    // a valid `Q<n>:` sitting after a quoted block still integrates.
    const { stripped } = stripQuotedLines(comment.body);
    const body = stripped;

    // FR-004 discriminator (#949 Q5→C): the colon here is DELIBERATE and
    // load-bearing. It separates engine-authored question comments (which
    // use `### Q1: Topic` shape, per `formatComment` above) from cockpit
    // answer-block delimiters (which use `### Q1` — NO colon). Removing the
    // colon or folding this pattern into `QN_OPENER_PATTERN` would cause the
    // `TRANSITION_WITH_QUESTION_HEADINGS` warn (in the caller) to fire on
    // every legitimate cockpit integration — a 100%-rate false positive.
    // Keep colon-required. Computed on the quote-stripped body so a quoted
    // `> ### Q1:` heading does not read as a live transition signal.
    const sourceHadQuestionHeadings = /(?:^|\n)###\s+Q\d+:/.test(body);

    // FR-005: opener is line-anchored via `(?:^|\n)` inside QN_OPENER_PATTERN
    // so mid-prose references like "as per Q1: yes" do not capture as
    // answers. Colon-less opener additionally requires a markdown heading
    // (per #949 Q2→A) so a bare `Q1\n…` cannot open a block; this is what
    // lets cockpit's `### Q1` answer blocks integrate.
    //
    // Capture-group layout (from QN_OPENER_PATTERN's two disjunction arms
    // plus the outer body `(.*?)`):
    //   [1] Q number (colon-less arm)
    //   [2] topic/trailing (colon-less arm)
    //   [3] Q number (colon-bearing arm)
    //   [4] answer/trailing (colon-bearing arm)
    //   [5] block body between opener and terminator
    const regex = new RegExp(
      `${QN_OPENER_PATTERN}(.*?)${QN_TERMINATOR_LOOKAHEAD}`,
      'gs',
    );

    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
      const { qn, trailing } = pickQnMatch(match);
      if (Number.isNaN(qn)) continue;
      const bodyText = match[5] ?? '';

      // Combine the opener's trailing (topic/answer on the opener line) with
      // the body (subsequent lines up to the terminator). This mirrors the
      // old single `.*?` capture semantics for downstream extraction.
      const combined = trailing + bodyText;

      // #958 FR-001: the `**Question**:`/`**Context**:` content-sniff is
      // deliberately NOT applied here. Authorship (viewerDidAuthor) is the
      // gate, decided in the caller — not the content of the comment.

      // Prefer an embedded `**Answer**` extraction (cockpit or engine
      // dialect) over the raw trimmed block. For a bare `Q1: X` shape,
      // extraction returns undefined and we fall through to `combined.trim()`.
      const embedded = extractEmbeddedAnswer(combined);
      const answer = embedded ?? combined.trim();

      // FR-012 (#958): broadened pending tolerance — empty, whitespace-only,
      // the canonical PENDING_ANSWER_LITERAL, and any `[…]`-bracketed
      // placeholder are all treated as not-an-answer.
      if (!isPendingAnswerValue(answer) && questionNumbers.includes(qn)) {
        answers.set(qn, {
          answer,
          sourceCommentId: comment.id,
          sourceHadQuestionHeadings,
          sourceViewerDidAuthor: comment.viewerDidAuthor,
        });
      }
    }
  }

  return answers;
}

export interface IntegrationResult {
  /** Number of answers integrated into the file */
  integrated: number;
  /** Reason if nothing was integrated */
  reason?:
    | 'no-spec-dir'
    | 'no-file'
    | 'no-pending'
    | 'no-answers'
    | 'no-changes'
    | 'aborted-cluster-self-detector';
  /**
   * #958 FR-010 — questions still pending (or reason-flagged) after this
   * integration pass. Callers (phase-loop) render an issue comment + relay
   * event when non-empty.
   */
  parseFailures?: Array<{
    questionNumber: number;
    reason:
      | 'no-source-comment'
      | 'transition-with-question-headings'
      | 'pending-value';
  }>;
  /** #958 FR-010 — number of questions still pending after this pass. */
  pendingAfter?: number;
}

/**
 * Post explainer bot comments for skipped untrusted `Q<N>:` answers
 * (FR-013 / D7). Metadata only — never comment body (SC-007). Idempotent
 * via `<!-- generacy-untrusted-answer:<commentId> -->` markers.
 */
async function postUntrustedAnswerExplainers(opts: {
  github: WorkerContext['github'];
  owner: string;
  repo: string;
  issueNumber: number;
  existingComments: TrustComment[];
  skipped: TrustComment[];
  logger: Logger;
}): Promise<void> {
  const { github, owner, repo, issueNumber, existingComments, skipped, logger } = opts;
  if (skipped.length === 0) return;

  for (const c of skipped) {
    const marker = untrustedAnswerMarker(c.id);
    const alreadyPosted = existingComments.some((existing) => existing.body.includes(marker));
    if (alreadyPosted) {
      logger.debug(
        { commentId: c.id, issueNumber },
        'Untrusted-answer explainer already posted — skipping (idempotence)',
      );
      continue;
    }

    const tier = c.authorAssociation ?? 'unknown';
    const body = `${marker}
> Answers from @${c.author} were not applied (association tier: \`${tier}\`). A trusted member (OWNER/MEMBER/COLLABORATOR) must re-post the answers themselves in the \`Q1: <answer>\` format for the batch to integrate.`;

    try {
      await github.addIssueComment(owner, repo, issueNumber, body);
      logger.info(
        { commentId: c.id, author: c.author, tier, issueNumber },
        'Posted untrusted-answer explainer comment',
      );
    } catch (error) {
      logger.warn(
        { commentId: c.id, error: error instanceof Error ? error.message : String(error) },
        'Failed to post untrusted-answer explainer comment',
      );
    }
  }
}

/**
 * Fetch issue comments via GraphQL, retrying once on transient failure and
 * failing closed on the second failure (FR-010, #910). No REST fallback —
 * falling back would silently reproduce the pre-fix defect where
 * App-identity clusters cannot self-recognize their own answers.
 */
async function getIssueCommentsWithRetry(
  github: WorkerContext['github'],
  owner: string,
  repo: string,
  issueNumber: number,
  logger: Logger,
): Promise<TrustComment[]> {
  try {
    return await github.getIssueCommentsWithViewerAuth(owner, repo, issueNumber);
  } catch (firstErr) {
    logger.warn(
      { error: firstErr instanceof Error ? firstErr.message : String(firstErr) },
      'getIssueCommentsWithViewerAuth failed; retrying once',
    );
    try {
      return await github.getIssueCommentsWithViewerAuth(owner, repo, issueNumber);
    } catch (secondErr) {
      logger.warn(
        { error: secondErr instanceof Error ? secondErr.message : String(secondErr) },
        'getIssueCommentsWithViewerAuth failed twice; failing closed (no REST fallback)',
      );
      throw secondErr;
    }
  }
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

  // 3. Fetch GitHub issue comments and parse answers.
  // #910: switched from REST getIssueComments() to GraphQL
  // getIssueCommentsWithViewerAuth() so App-identity clusters can
  // self-recognize their own answer posts via `viewerDidAuthor`. Retry
  // once on transient failure; fail closed on second failure (no REST
  // fallback — FR-010).
  let comments: TrustComment[];
  try {
    comments = await getIssueCommentsWithRetry(github, owner, repo, issueNumber, logger);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to fetch issue comments for answer integration',
    );
    return { integrated: 0, reason: 'no-answers' };
  }

  // FR-102 / FR-103: filter engine-authored questions BEFORE the trust check.
  // The trust filter must never receive an engine questions comment as input —
  // under #910 the cluster's own identity is trusted, and the trust check
  // would wave those through to the parser.
  const scanCandidates: TrustComment[] = [];
  for (const c of comments) {
    const markerPrefix = matchClarificationQuestionMarker(c.body);
    if (markerPrefix !== undefined) {
      logger.debug(
        {
          event: 'clarification-answer-scanner-marker-excluded',
          commentId: c.id,
          author: c.author,
          markerPrefix,
          issueNumber,
        },
        'Excluded from answer-scanner via question marker',
      );
      continue;
    }
    scanCandidates.push(c);
  }

  // 3a. Author-trust gating (#842). Every marker-cleared comment goes through
  // the shared helper before we treat it as an answer source. Answer-scanner
  // surface ignores widen-config (FR-008).
  const botLogin = resolveBotLoginFromEnv();
  const trustConfig = tryLoadCommentTrustConfig(checkoutPath, toEngineLogger(logger));
  const trustCtx: CommentTrustContext = {
    logger: toEngineLogger(logger),
    ...(botLogin ? { botLogin } : {}),
    ...(trustConfig ? { config: trustConfig } : {}),
  };

  const trustedComments: TrustComment[] = [];
  const skippedForExplainer: TrustComment[] = [];
  for (const c of scanCandidates) {
    const decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx);
    if (decision.trusted) {
      trustedComments.push(c);
    } else {
      logCommentSkipped(logger, 'answer-scanner', c, decision.reason);
      // Only comments that would have been consumed as answers get an
      // explainer bot comment (FR-013 / D7). Generic drive-bys are log-only.
      if (commentMatchesAnswerPattern(c.body)) {
        skippedForExplainer.push(c);
      }
    }
  }

  // Post explainer comments for untrusted Q<N>: answers, before parsing.
  // Fire-and-forget: failures are non-fatal.
  await postUntrustedAnswerExplainers({
    github,
    owner,
    repo,
    issueNumber,
    existingComments: comments,
    skipped: skippedForExplainer,
    logger,
  });

  // #958 FR-001 / FR-003 — Authorship gate. `viewerDidAuthor === true`
  // (cluster-self) requires the engine-written answer marker; anything else
  // is parsed permissively. The L488 `.includes('**Question**:')` content
  // sniff has been retired as an authorship signal — content is not
  // authorship.
  const answerComments: TrustComment[] = [];
  for (const c of trustedComments) {
    if (c.viewerDidAuthor === true) {
      if (commentCarriesAnswerMarker(c.body)) {
        answerComments.push(c);
      } else {
        logger.debug(
          {
            event: 'clarification-answer-scanner-self-unmarked',
            commentId: c.id,
            author: c.author,
            issueNumber,
          },
          'Skipped cluster-self comment lacking engine-written answer marker (FR-003)',
        );
      }
    } else {
      // Human / undefined viewerDidAuthor — parse permissively (FR-002).
      answerComments.push(c);
    }
  }

  const answers = parseAnswersFromComments(answerComments, pendingNumbers, logger);
  if (answers.size === 0) {
    return { integrated: 0, reason: 'no-answers' };
  }

  // 4. Update the file content — replace `PENDING_ANSWER_LITERAL` with actual
  //    answers for each matched question. FR-004 asymmetric fail-close: if a
  //    cluster-self answer trips `TRANSITION_WITH_QUESTION_HEADINGS`, abort
  //    the entire poll's integration; if a human comment trips it, skip only
  //    the offending question.
  let updatedContent = content;
  const integratedNumbers = new Set<number>();
  const parseFailures: NonNullable<IntegrationResult['parseFailures']> = [];
  for (const [questionNum, parsed] of answers) {
    // Detect FR-004 case: source comment carried `### Q<n>:` headings.
    if (parsed.sourceHadQuestionHeadings) {
      if (parsed.sourceViewerDidAuthor === true) {
        // Cluster-self AND question-headings — unknown-extent malfunction.
        // Abort the entire poll's integration; leave the gate armed.
        logger.warn(
          {
            code: 'TRANSITION_WITH_QUESTION_HEADINGS',
            commentId: parsed.sourceCommentId,
            issueNumber,
            questionNumber: questionNum,
            excerpt: parsed.answer.slice(0, 120),
          },
          'Cluster-self answer contains question headings — aborting integration (FR-004 fail-closed)',
        );
        return {
          integrated: 0,
          reason: 'aborted-cluster-self-detector',
          pendingAfter: pendingQuestions.length,
        };
      }
      // Human comment tripped it — skip only this question, keep others.
      logger.warn(
        {
          code: 'TRANSITION_WITH_QUESTION_HEADINGS',
          commentId: parsed.sourceCommentId,
          issueNumber,
          questionNumber: questionNum,
          excerpt: parsed.answer.slice(0, 120),
        },
        'Human answer contains question headings — skipping only this question (FR-004)',
      );
      parseFailures.push({
        questionNumber: questionNum,
        reason: 'transition-with-question-headings',
      });
      continue;
    }

    // Match the answer line within the correct question section. The pattern
    // finds `### Q{N}: ... **Answer**: <PENDING_ANSWER_LITERAL>` and replaces
    // the literal with the actual answer text. Escaped because
    // `PENDING_ANSWER_LITERAL` contains regex metacharacters.
    const pattern = new RegExp(
      `(### Q${questionNum}:[\\s\\S]*?\\*\\*Answer\\*\\*:\\s*)${escapeRegExp(PENDING_ANSWER_LITERAL)}`,
    );
    const previousContent = updatedContent;
    updatedContent = updatedContent.replace(pattern, `$1${parsed.answer}`);
    if (updatedContent !== previousContent) {
      integratedNumbers.add(questionNum);
    } else {
      parseFailures.push({
        questionNumber: questionNum,
        reason: 'no-source-comment',
      });
    }
  }

  // Any pending question with no attempted answer at all → parse-failure entry
  // so FR-010 reporting can surface it.
  for (const p of pendingQuestions) {
    if (!answers.has(p.number)) {
      parseFailures.push({ questionNumber: p.number, reason: 'no-source-comment' });
    }
  }

  if (updatedContent === content) {
    const result: IntegrationResult = {
      integrated: 0,
      reason: 'no-changes',
      pendingAfter: pendingQuestions.length,
    };
    if (parseFailures.length > 0) result.parseFailures = parseFailures;
    return result;
  }

  writeFileSync(clarificationsPath, updatedContent);
  logger.info(
    { count: integratedNumbers.size, issueNumber },
    'Integrated GitHub answers into clarifications.md',
  );

  const pendingAfter = pendingQuestions.length - integratedNumbers.size;
  const result: IntegrationResult = {
    integrated: integratedNumbers.size,
    pendingAfter,
  };
  if (parseFailures.length > 0) result.parseFailures = parseFailures;
  return result;
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
  // #842 audit: whitelist — reads only for own-marker dedup; body content is
  // not surfaced to an agent.
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
