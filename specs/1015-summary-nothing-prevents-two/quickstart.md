# Quickstart: Active-driver claim per cockpit scope

**Feature**: #1015 | **Branch**: `1015-summary-nothing-prevents-two`

## For operators

Once this feature lands **and** the companion `agency` PR wiring `--takeover` into `/cockpit:auto` lands, the operator workflow is:

### First driver (unchanged)

```
/cockpit:auto generacy-ai/generacy#1015
```

The auto skill acquires the claim silently at arm time and refreshes on every wake tick. Nothing about the visible flow changes.

### Second conversation, same scope (new — refusal)

```
/cockpit:auto generacy-ai/generacy#1015
```

Refuses at arm time with a gate:

```
Scope generacy-ai/generacy#1015 is already claimed by session ab12cd34ef56789a.
Heartbeat: 2026-07-21T14:03:42Z (0m 12s ago)
Ledger: .generacy/cockpit/auto-runs/generacy-ai-generacy-1015-20260721-140142.ledger
Marker: https://github.com/generacy-ai/generacy/issues/1015#issuecomment-2099...

Options:
  1. Take over — supersede the other session and start driving now.
  2. Watch instead — exit and let the other session continue; suggest /cockpit:watch.
  3. Cancel — exit non-zero.
```

### Explicit takeover from CLI

```
/cockpit:auto generacy-ai/generacy#1015 --takeover
```

Skips the gate and takes over immediately. The superseded session detects the lost claim on its next wake and exits cleanly, logging:

```
claim · superseded · new-holder=<their-session-id>
```

### After a crashed session

```
/cockpit:auto generacy-ai/generacy#1015
```

If the previous session crashed within the last 10 minutes, the arm gate fires (with a stale heartbeat visible in the payload). After 10 minutes, the claim is treated as absent and the new arm acquires silently — no takeover ceremony needed.

### Terminal exit

At `epic-complete` (or `scope-drained` in tracking mode, or graceful ctrl-C), the auto skill calls `cockpit_release` — comment and label are removed, next session can arm cleanly with no takeover needed.

---

## For MCP callers (scripted)

### Acquire

```json
{
  "tool": "cockpit_claim",
  "arguments": {
    "scope": "generacy-ai/generacy#1015",
    "sessionId": "your-16-64-hex-id",
    "ledger": "path/to/your.ledger"
  }
}
```

Success → `{ status: "ok", data: { action: "acquired", claim, commentUrl } }`.
Conflict → `{ status: "error", class: "claim-conflict", holder, commentUrl, hint }`.

### Refresh (heartbeat)

Identical to acquire — call the same tool on every wake tick. If you already hold the claim, `action` will be `refreshed` and only the `heartbeatAt` field changes.

### Takeover

Same as acquire but with `takeover: true`:

```json
{
  "tool": "cockpit_claim",
  "arguments": {
    "scope": "generacy-ai/generacy#1015",
    "sessionId": "your-id",
    "ledger": "path/to/your.ledger",
    "takeover": true
  }
}
```

Success → `{ status: "ok", data: { action: "taken-over", claim, commentUrl, displaced } }`.
If nobody else held the claim → success with `action: "acquired"` (the flag is a no-op when unopposed).

### Detect lost claim (for supersede handling)

On every heartbeat call, inspect `data.claim.sessionId`. If it differs from your `sessionId`, you were taken over — stop dispatching and exit.

*Detection is automatic in the current tool shape: a lost claim manifests as `claim.sessionId === <other>`, not as an error.* (An alternative would be a dedicated `class: 'not-holder'` error, but callers already have to compare session ids for the refresh path.)

### Release

```json
{
  "tool": "cockpit_release",
  "arguments": {
    "scope": "generacy-ai/generacy#1015",
    "sessionId": "your-id"
  }
}
```

Always succeeds; `action` disambiguates (`released` / `not-holder` / `no-claim`).

---

## For implementers

### Add the tools to the MCP server

Both tools register in `packages/generacy/src/cli/commands/cockpit/mcp/server.ts` the same way existing tools do:

```ts
server.registerTool(
  'cockpit_claim',
  {
    description:
      'Acquire, refresh, or take over the active-driver claim on a scope issue. Idempotent.',
    inputSchema: CockpitClaimInputSchema,
  },
  async (args) => toCallToolResult(await cockpitClaim(args as never, deps)),
);

server.registerTool(
  'cockpit_release',
  {
    description:
      'Release a scope claim held by the given sessionId. Idempotent — no-op if not the holder.',
    inputSchema: CockpitReleaseInputSchema,
  },
  async (args) => toCallToolResult(await cockpitRelease(args as never, deps)),
);
```

### Extending `GhWrapper`

Two new methods on the interface + `GhCliWrapper` impl (see `data-model.md § GitHub API Contract Extensions`). Both use `gh api`:

```ts
async editIssueComment(repo: string, commentId: number, body: string): Promise<void> {
  const result = await this.runner('gh', [
    'api', '-X', 'PATCH',
    `repos/${repo}/issues/comments/${commentId}`,
    '-f', `body=${body}`,
  ]);
  failIfNonZero(result, 'issue comment (edit)');
}

async deleteIssueComment(repo: string, commentId: number): Promise<void> {
  const result = await this.runner('gh', [
    'api', '-X', 'DELETE',
    `repos/${repo}/issues/comments/${commentId}`,
  ]);
  // 404 is idempotent-success (already deleted); other failures propagate
  if (result.exitCode !== 0 && !/404|not found/i.test(result.stderr)) {
    failIfNonZero(result, 'issue comment (delete)');
  }
}
```

And update `fetchIssueComments` to include `databaseId`:

```ts
const result = await this.runner('gh', [
  'issue', 'view', String(issue),
  '--repo', repo,
  '--json', 'comments',
  '--jq', '{comments: [.comments[] | {id: .id, body, author, createdAt, url}]}',
]);
```

(Verify `gh issue view --json comments` exposes `id` — if not, fall back to `gh api repos/{repo}/issues/{n}/comments` for the id-carrying REST payload.)

### Running the tests

```bash
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/mcp/claim
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/mcp/__tests__/parity-claim.test.ts
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/mcp/__tests__/parity-release.test.ts
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts
```

### Adding the changeset

```bash
pnpm changeset
# Select @generacy-ai/generacy (minor) and @generacy-ai/cockpit (minor)
# Summary: "Add cockpit_claim + cockpit_release MCP tools for per-scope active-driver claim (#1015)."
```

The generated file lands under `.changeset/`. Rename to `1015-active-driver-claim.md` for readability.

---

## Troubleshooting

### `claim-conflict` even though I control both sessions

Verify both sessions have distinct `sessionId` values. If both share an `INSTANCE_NONCE` (e.g., because they share an MCP server process), the claim mechanism sees them as the same session and refreshes rather than conflicts. This is intentional.

### Stale claim isn't clearing after 10 minutes

Discovery uses **the server's local clock** vs. the marker's `heartbeatAt`. If the operator's clock is skewed significantly (>2 min), the effective threshold shifts. Ensure NTP is running on the host.

### `orphaned-label` messages in the ledger

A `cockpit:claimed` label with no matching marker comment is orphaned (usually from a crashed release). Arm-time discovery cleans it up automatically. If you see repeated orphaned-label messages on the same scope, the label removal is failing — check `gh` permissions (`repo` scope required for label writes).

### Both `cockpit_claim` calls succeed against the same scope

Cannot happen — discovery's oldest-wins tiebreaker + re-verify sequence guarantees exactly one live winner. If you observe this in practice, capture the raw responses and file a bug — this would be a correctness violation of SC-001.

### Skill-side wiring not landed yet

If `agency` repo hasn't shipped the auto.md `--takeover` wiring, `/cockpit:auto` will not use the claim tools automatically. You can still exercise the primitives via raw MCP calls (see "For MCP callers" above), and the SC-001..SC-006 tests here validate the primitives in isolation.
