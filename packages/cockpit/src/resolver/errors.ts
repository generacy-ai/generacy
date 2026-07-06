export type LoudResolverErrorCode =
  | 'INVALID_EPIC_REF'
  | 'GH_FETCH_FAILED'
  | 'NO_PHASE_HEADINGS'
  | 'NO_REFS'
  | 'AMBIGUOUS_PHASE_TOKEN'
  | 'PHASE_NOT_FOUND';

const EXPECTED_FORMAT_SENTENCE =
  "Expected format: '### <phase>' headings with '- [ ] owner/repo#N' task-list items.";

function messageForCode(code: LoudResolverErrorCode, details?: unknown): string {
  switch (code) {
    case 'INVALID_EPIC_REF':
      return `cockpit: --epic must be owner/repo#N. ${EXPECTED_FORMAT_SENTENCE}`;
    case 'GH_FETCH_FAILED': {
      const cause =
        typeof details === 'object' && details != null && 'cause' in details
          ? String((details as { cause: unknown }).cause)
          : 'unknown';
      return `cockpit: failed to fetch epic body from GitHub: ${cause}. ${EXPECTED_FORMAT_SENTENCE}`;
    }
    case 'NO_PHASE_HEADINGS':
      return `cockpit: epic body has no '### <phase>' headings. ${EXPECTED_FORMAT_SENTENCE}`;
    case 'NO_REFS':
      return `cockpit: epic body has no task-list refs under any '### <phase>' heading. ${EXPECTED_FORMAT_SENTENCE}`;
    case 'AMBIGUOUS_PHASE_TOKEN': {
      const list =
        typeof details === 'object' &&
        details != null &&
        'candidateHeadings' in details &&
        Array.isArray((details as { candidateHeadings: unknown }).candidateHeadings)
          ? ((details as { candidateHeadings: string[] }).candidateHeadings.join(', '))
          : '';
      return `cockpit: <phase> token matches multiple headings: [${list}]. ${EXPECTED_FORMAT_SENTENCE}`;
    }
    case 'PHASE_NOT_FOUND': {
      const list =
        typeof details === 'object' &&
        details != null &&
        'candidateHeadings' in details &&
        Array.isArray((details as { candidateHeadings: unknown }).candidateHeadings)
          ? ((details as { candidateHeadings: string[] }).candidateHeadings.join(', '))
          : '';
      return `cockpit: <phase> token matches no heading. Candidates: [${list}]. ${EXPECTED_FORMAT_SENTENCE}`;
    }
  }
}

export class LoudResolverError extends Error {
  readonly code: LoudResolverErrorCode;
  readonly details?: unknown;

  constructor(code: LoudResolverErrorCode, details?: unknown) {
    super(messageForCode(code, details));
    this.name = 'LoudResolverError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
