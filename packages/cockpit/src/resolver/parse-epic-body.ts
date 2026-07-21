import { firstToken } from './heading-match.js';
import { parseRef } from './ref-shapes.js';
import type {
  IssueRef,
  ParsedEpicBody,
  ParsedPhase,
  ParseEpicBodyOptions,
} from './types.js';

const HEADING_L3_RE = /^###\s+(.+?)\s*$/;
const HEADING_L4_PLUS_RE = /^####+\s+/;
const HEADING_L2_RE = /^##\s+/;
// #1006 (Q1=C, word-boundaried): trimmed L4+ heading text is "phase-shaped"
// iff it matches `P\d+\b` OR contains a word-boundaried `phase`. See
// contracts/parser-behavior.md for matches / non-matches. Load-bearing:
// `\bphase\b` (not `phase`) so `#### Rephrase …` does not fire the detector.
const PHASE_SHAPED_H4_RE = /^\s*(?:P\d+\b|.*\bphase\b)/i;
// Case-insensitive first-token match: closes current phase (parses like L4+),
// and marks subsequent refs as adhoc rather than dropped.
const AD_HOC_HEADING_RE = /^##\s+ad-hoc\s*$/i;
const TASK_LIST_RE = /^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/;
const REF_SHAPED_RE =
  /(?:^|[\s(])(?:#\d+|\[#?\d+\]|\[[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+\]|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+|https:\/\/github\.com\/[A-Za-z0-9._\-\/]+)/;

// #826 (FR-005): rejection-family taxonomy carried in warnings[]. Each returned
// string contains exactly one documented marker substring so tests can assert
// via toContain() without pinning full wording. Do not remove or rename these
// three markers without updating parse-epic-body.test.ts and
// contracts/parser-behavior.md §Warnings:
//   - "bare '#N'"
//   - "titled but not ref-shaped"
//   - "URL path not /(issues|pull)/N"
const BARE_HASH_N_RE = /^#\d+$/;
const URL_LIKE_RE = /^https?:\/\//;
// #1014: validates ParseEpicBodyOptions.defaultRepo. Mirrors the OWNER_REPO
// char class in ref-shapes.ts:3. Malformed → warn + treat as absent (never throws).
const DEFAULT_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
function classifyRejection(token: string): string {
  if (BARE_HASH_N_RE.test(token)) {
    return "unrecognised shape — bare '#N' shorthand is not accepted";
  }
  if (URL_LIKE_RE.test(token)) {
    return 'unrecognised shape — URL path not /(issues|pull)/N';
  }
  return 'unrecognised shape — titled but not ref-shaped';
}

function sortRefs(refs: Iterable<IssueRef>): IssueRef[] {
  return [...refs].sort((a, b) => {
    if (a.repo < b.repo) return -1;
    if (a.repo > b.repo) return 1;
    return a.number - b.number;
  });
}

function dedupKey(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

/**
 * Line-oriented walk over an epic issue body.
 *
 * Grammar (see contracts/resolver.md):
 *   - Heading (level 3): `^### (.+)$` — opens a phase.
 *   - Heading (level 4+, phase-shaped): `^####+ (P\d+…|…phase…)` — opens a phase
 *     (flat sibling to any surrounding `###` phase; #1014 FR-001).
 *   - Heading (level 4+, non-phase-shaped): `^####+ …` — transparent, does NOT
 *     close the current phase (#1014 FR-002).
 *   - Heading (level 2): `^## …$` — ignored.
 *   - Task-list item: `^\s*- \[[ xX]\] (ref-shape)` — appends a ref to the current phase.
 *
 * Rejected but ref-shaped lines (e.g. bare `#N`) produce a `warnings[]` entry.
 * When `options.defaultRepo` is set, bare `#N` inside checkbox items is
 * resolved to `<defaultRepo>#N` instead (#1014 FR-004).
 *
 * Pure function — no throws, no I/O.
 */
export function parseEpicBody(
  body: string,
  options?: ParseEpicBodyOptions,
): ParsedEpicBody {
  const phases: ParsedPhase[] = [];
  const warnings: string[] = [];
  const globalRefs = new Map<string, IssueRef>();
  const adhocRefs: IssueRef[] = [];
  const adhocSeen = new Set<string>();

  // #1014 (FR-003): validate defaultRepo up front. On mismatch, emit one
  // warning with marker substring `invalid defaultRepo` and behave as if
  // the option were absent. Never throws.
  let effectiveDefaultRepo: string | undefined;
  if (options?.defaultRepo !== undefined) {
    if (DEFAULT_REPO_RE.test(options.defaultRepo)) {
      effectiveDefaultRepo = options.defaultRepo;
    } else {
      warnings.push(
        `cockpit: parseEpicBody: invalid defaultRepo '${options.defaultRepo}' (invalid defaultRepo)`,
      );
    }
  }

  let current: ParsedPhase | null = null;
  let currentSeen = new Set<string>();
  let sawPhaseShapedH4 = false;
  let sawH3Phase = false;
  let sawMixedHeadingLevels = false;

  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    if (HEADING_L4_PLUS_RE.test(line)) {
      const text = line.replace(/^####+\s+/, '').trim();
      if (PHASE_SHAPED_H4_RE.test(text)) {
        // #1014 (FR-001): phase-shaped H4 opens a new phase, mirroring the
        // H3 branch's semantics. Flat sibling to any surrounding H3 phase.
        sawPhaseShapedH4 = true;
        const heading = text;
        const token = firstToken(heading);
        current = { heading, token, refs: [] };
        currentSeen = new Set();
        phases.push(current);
        if (sawH3Phase) sawMixedHeadingLevels = true;
      }
      // #1014 (FR-002): non-phase-shaped H4+ is transparent — do NOT close
      // the current phase, do NOT reset currentSeen. Enables `#### Notes`
      // sub-sections whose child refs continue to attribute to the current phase.
      continue;
    }

    // Adhoc heading must be checked before generic L2 (which would skip).
    if (AD_HOC_HEADING_RE.test(line)) {
      current = null;
      currentSeen = new Set();
      continue;
    }

    if (HEADING_L2_RE.test(line)) {
      continue;
    }

    const h3 = HEADING_L3_RE.exec(line);
    if (h3 != null) {
      const heading = h3[1]!.trim();
      const token = firstToken(heading);
      current = { heading, token, refs: [] };
      currentSeen = new Set();
      phases.push(current);
      sawH3Phase = true;
      if (sawPhaseShapedH4) sawMixedHeadingLevels = true;
      continue;
    }

    const task = TASK_LIST_RE.exec(line);
    if (task == null) continue;
    const refText = task[1]!.trim();
    // #826: the ref is only the first whitespace-delimited token; everything after
    // is a free-form title consumed unparsed. All four accepted shapes in
    // ref-shapes.ts are whitespace-free tokens, so first-token extraction is
    // sufficient and passing the full refText to parseRef would fail every
    // ^…$-anchored shape.
    const refToken = refText.split(/\s+/)[0]!;

    let ref = parseRef(refToken);
    // #1014 (FR-004): under an effectiveDefaultRepo, a bare `#N` inside a
    // TASK_LIST_RE line synthesizes { repo: effectiveDefaultRepo, number }.
    // Applies only inside checkbox items (FR-013); non-checkbox lines never
    // reach here.
    if (
      ref == null &&
      effectiveDefaultRepo !== undefined &&
      BARE_HASH_N_RE.test(refToken)
    ) {
      const n = Number.parseInt(refToken.slice(1), 10);
      if (Number.isFinite(n) && n > 0) {
        ref = { repo: effectiveDefaultRepo, number: n };
      }
    }
    if (ref == null) {
      // First-token silence rule (FR-007): if the first token is not ref-shaped,
      // stay silent regardless of what appears later on the line — prose
      // checkboxes that mention a ref mid-sentence never warn.
      if (REF_SHAPED_RE.test(refToken)) {
        const reason = classifyRejection(refToken);
        warnings.push(
          `cockpit: ignored ref-shaped task-list line ${lineNumber}: '${refText}' (${reason})`,
        );
      }
      continue;
    }

    const key = dedupKey(ref);

    if (current == null) {
      // Adhoc collection: refs outside any phase (preamble, `## Ad-hoc`,
      // or post-`####+` terminator). Dedup within adhoc AND against globalRefs
      // to avoid duplicate emission if the same ref later appears in a phase.
      if (!adhocSeen.has(key)) {
        adhocSeen.add(key);
        adhocRefs.push(ref);
      }
      if (!globalRefs.has(key)) {
        globalRefs.set(key, ref);
      }
      continue;
    }

    if (!currentSeen.has(key)) {
      currentSeen.add(key);
      current.refs.push(ref);
    }
    if (!globalRefs.has(key)) {
      globalRefs.set(key, ref);
    }
  }

  const allRefs = sortRefs(globalRefs.values());

  // #1006 (FR-009): loud signal for LLM-authored epics whose phase headers
  // dropped an H-level. All four conditions required — see
  // contracts/parser-behavior.md §Loud-signal gating rule. The marker
  // substring in the pushed string below is contractual (grep-audited per
  // SC-006); the surrounding sentence is free to evolve.
  if (
    phases.length > 0 &&
    phases.every((p) => p.refs.length === 0) &&
    adhocRefs.length > 0 &&
    sawPhaseShapedH4
  ) {
    const n = adhocRefs.length;
    warnings.push(
      `cockpit: ${n} task ref${n === 1 ? '' : 's'} fell to ad-hoc; phase headers must be '###', found '####'`,
    );
  }

  // #1014 (FR-012): body mixes H3 and phase-shaped H4 phase headings. Every
  // phase-shaped heading opens a top-level phase (flat siblings). Exactly one
  // warning per call regardless of count. Marker substring `mixed phase heading levels`.
  if (sawMixedHeadingLevels) {
    warnings.push(
      "cockpit: body mixes '###' and '####' phase headings; every phase-shaped heading opens a top-level phase (mixed phase heading levels)",
    );
  }

  return { phases, adhocRefs, allRefs, warnings };
}
