# Quickstart: Verifying the doorbell full-event wake line (#985)

## Prereqs

- Local checkout of `generacy-ai/generacy` on branch `985-summary-cockpit-auto-exhausts`.
- Node ≥22 (`node --version`).
- `pnpm install` already run.

## Files touched

- `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` — `checks` field added to `CockpitEventSchema`.
- `packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts` — `lineForEvent` rewritten to `JSON.stringify(event) + '\n'`.
- `packages/generacy/src/cli/commands/cockpit/doorbell/webhook-to-event.ts` — `buildEvent` calls `classifyIssue(labels)` and sets `to`.
- `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` — read-through `checks` stamp from `this.prev` in `processEventBlock`.
- `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/webhook-to-event.test.ts` — extend for `to` invariant.
- `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source.integration.test.ts` — extend for `checks` stamp + no-gh invariant.
- `.changeset/985-doorbell-full-event-line.md` — `minor` bump for `@generacy-ai/generacy`.

## Local verification (dev loop)

### 1. Type-check + lint

```bash
pnpm --filter @generacy-ai/generacy typecheck
pnpm --filter @generacy-ai/generacy lint
```

### 2. Run the doorbell test suite

```bash
pnpm --filter @generacy-ai/generacy test -- doorbell
```

Expected new/updated tests to pass:

- `webhook-to-event.test.ts` — `buildEvent` populates `to` via `classifyIssue`; `from` stays `null`.
- `smee-source.integration.test.ts` — `checks` stamped correctly per Q1=A matrix; zero `gh` invocations in the smee event path.
- `subscribe.test.ts` (if present) — `lineForEvent` returns parseable NDJSON.

### 3. End-to-end sanity check (optional, local)

Drive the doorbell against a synthetic smee stream and observe stdout:

```bash
pnpm --filter @generacy-ai/generacy build
node packages/generacy/dist/cli/index.js cockpit doorbell generacy-ai/generacy#985 \
  --exit-on-epic-complete \
  2>/tmp/doorbell.err | tee /tmp/doorbell.out
```

Expected stdout (first three lines):

```
armed
{"type":"issue-transition","ts":"…","repo":"generacy-ai/generacy","kind":"issue","number":985,"from":null,"to":"…","sourceLabel":"…","url":"…","event":"label-change","labels":[…]}
```

- Every non-`armed` line MUST parse as JSON.
- `to` MUST equal `classify(labels).state`.
- `checks` present only on `pr-checks` / `completed:validate` lines when the cached rollup is decisively green/red.

### 4. Consumer degradation check

An old skill (bare-type consumer) reads only the first token per line. Verify with:

```bash
tail -f /tmp/doorbell.out | awk -F'"type":"' '{ print $2 }' | awk -F'"' '{ print $1 }'
```

Expected output stream:

```
issue-transition
phase-complete
epic-complete
…
```

Non-empty output confirms that a defensive bare-type parser can still extract the discriminator (SC-004).

## Success criteria checklist

- [ ] Every emitted line (both smee and poll paths) parses to `CockpitStreamEventSchema` (FR-001, FR-008a).
- [ ] Smee-path `to` is populated by `classifyIssue(labels)`, with zero added `gh` calls (FR-003, FR-005).
- [ ] `checks` field appears on `pr-checks` / `completed:validate` events only when the cached rollup maps to `green` / `red` (FR-004, FR-008d).
- [ ] `armed\n` sentinel emitted before any event line; `--exit-on-epic-complete` still exits 0 on `epic-complete` (FR-006, FR-007).
- [ ] Doorbell test suite passes (FR-008a–d).
- [ ] `.changeset/985-doorbell-full-event-line.md` present in the diff (FR-009).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Old test fails asserting `line === "issue-transition\n"` | Test predates NDJSON wire format. | Update to `JSON.parse(line).type === "issue-transition"`. |
| `checks` never appears on the wire | `SmeeDoorbellSource.prev` is empty at emit time (aggregate refresh hasn't populated it). | Expected on the first webhook after startup. Skill treats absent === pending and re-queries. |
| `to` is `null` on smee events | `buildEvent` still returns `to: null`. | Confirm `classifyIssue(labels)` was wired at `webhook-to-event.ts:109-132`. |
| Doorbell emits a line without trailing `\n` | Direct `stdout.write` of `JSON.stringify(event)` without newline. | `lineForEvent` MUST return `JSON.stringify(event) + '\n'`. |
| `changeset-bot` CI gate fails | Missing `.changeset/*.md`. | Run `pnpm changeset` or hand-write `.changeset/985-doorbell-full-event-line.md`. |
| Live rate-limit measurement unchanged | Skill (agency #437) not yet landed. | Expected. Q5=B — measurement is a follow-up validation task; #985 unblocks on reasoned inference. |

## Follow-up (not in this PR)

- **agency #437** — skill-side consumer parses NDJSON and drops the per-event `cockpit_status` re-check. Ship as a lockstep companion PR.
- **Live measurement** — after both PRs land, run a 15-ref epic through `/cockpit:auto` and delta `gh api rate_limit` for one hour. Target ≤ ~500 pts/hr (SC-001).
- **MCP-server `gh` wrapper hardening** — wire `{ cache, rateLimitScheduler }` into the MCP server's bare `new GhCliWrapper(runner)`. Lower priority once #985 + #437 remove the per-event re-query.
