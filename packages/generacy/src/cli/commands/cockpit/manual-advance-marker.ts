/**
 * `formatManualAdvanceComment` — renders the structured issue comment posted
 * by `cockpit advance` per AD-1 / D-R5.
 *
 * Inputs are regex-validated before interpolation so a malformed `gate`,
 * `actor`, or `ts` cannot inject HTML/markdown into the marker body.
 */

const GATE_REGEX = /^[a-z][a-z0-9-]*$/;
const ACTOR_REGEX = /^[A-Za-z0-9-]+$/;

export interface ManualAdvanceMarker {
  gate: string;
  actor: string;
  ts: string;
}

export function formatManualAdvanceComment(marker: ManualAdvanceMarker): string {
  validate(marker);
  const { gate, actor, ts } = marker;
  return (
    `<!-- generacy-cockpit:manual-advance gate=${gate} actor=${actor} ts=${ts} -->\n\n` +
    `Manually advanced \`waiting-for:${gate}\` → \`completed:${gate}\` by **@${actor}**.`
  );
}

function validate(marker: ManualAdvanceMarker): void {
  if (!GATE_REGEX.test(marker.gate)) {
    throw new Error(`formatManualAdvanceComment: invalid gate name "${marker.gate}"`);
  }
  if (!ACTOR_REGEX.test(marker.actor)) {
    throw new Error(`formatManualAdvanceComment: invalid actor login "${marker.actor}"`);
  }
  if (typeof marker.ts !== 'string' || marker.ts === '') {
    throw new Error('formatManualAdvanceComment: ts must be a non-empty ISO-8601 string');
  }
  const parsed = new Date(marker.ts);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== marker.ts) {
    throw new Error(`formatManualAdvanceComment: ts "${marker.ts}" is not round-trip ISO-8601`);
  }
}
