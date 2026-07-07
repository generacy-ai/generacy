/**
 * `formatManualAdvanceComment` — renders the structured issue comment posted
 * by `cockpit advance` per AD-1 / D-R5.
 *
 * Inputs are regex-validated before interpolation so a malformed `gate`,
 * `actor`, or `ts` cannot inject HTML/markdown into the marker body.
 *
 * `actor` is optional: when `undefined` or empty, the `actor=` attribute is
 * omitted from the HTML comment and the ` by **@<actor>**` clause is dropped
 * from the sentence (contract: FR-003, `contracts/manual-advance-marker.md`).
 */

const GATE_REGEX = /^[a-z][a-z0-9-]*$/;
const ACTOR_REGEX = /^[A-Za-z0-9-]+$/;

export interface ManualAdvanceMarker {
  gate: string;
  actor?: string;
  ts: string;
}

export function formatManualAdvanceComment(marker: ManualAdvanceMarker): string {
  validate(marker);
  const { gate, actor, ts } = marker;
  const hasActor = typeof actor === 'string' && actor.length > 0;
  const commentPrelude = hasActor
    ? `<!-- generacy-cockpit:manual-advance gate=${gate} actor=${actor} ts=${ts} -->`
    : `<!-- generacy-cockpit:manual-advance gate=${gate} ts=${ts} -->`;
  const sentence = hasActor
    ? `Manually advanced \`waiting-for:${gate}\` → \`completed:${gate}\` by **@${actor}**.`
    : `Manually advanced \`waiting-for:${gate}\` → \`completed:${gate}\`.`;
  return `${commentPrelude}\n\n${sentence}`;
}

function validate(marker: ManualAdvanceMarker): void {
  if (!GATE_REGEX.test(marker.gate)) {
    throw new Error(`formatManualAdvanceComment: invalid gate name "${marker.gate}"`);
  }
  if (typeof marker.actor === 'string' && marker.actor.length > 0) {
    if (!ACTOR_REGEX.test(marker.actor)) {
      throw new Error(`formatManualAdvanceComment: invalid actor login "${marker.actor}"`);
    }
  }
  if (typeof marker.ts !== 'string' || marker.ts === '') {
    throw new Error('formatManualAdvanceComment: ts must be a non-empty ISO-8601 string');
  }
  const parsed = new Date(marker.ts);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== marker.ts) {
    throw new Error(`formatManualAdvanceComment: ts "${marker.ts}" is not round-trip ISO-8601`);
  }
}
