/**
 * Neutral shared primitive (#1235): build the dashboard inbox deep-link for a
 * gate. Both the write-path tool (`cockpit_gate_open`) and the read-path tools
 * (`cockpit_gate_status`, `cockpit_gate_list`) import this, so — like
 * `options.ts` — it MUST stay import-disjoint from the gate write path
 * (`gates/client.js`, the write/ack tool handlers, any `retain*` module). The
 * observer-independence import-scan depends on this.
 *
 * Shape (contracts/inbox-url.md): `${origin}/dashboard/inbox?gate=<gateId>`.
 * Built via `new URL('/dashboard/inbox', appUrl)` so a trailing slash on
 * `appUrl` cannot produce `//dashboard`. Byte-identical to generacy-cloud's
 * own `gate-browser-notifier.ts` for the same gate.
 */
export function buildInboxUrl(appUrl: string, gateId: string): string {
  const url = new URL('/dashboard/inbox', appUrl);
  url.searchParams.set('gate', gateId);
  return url.toString();
}
