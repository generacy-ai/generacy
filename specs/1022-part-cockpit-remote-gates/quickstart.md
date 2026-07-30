# Quickstart: Cockpit MCP — `cockpit_gate_open` + `cockpit_gate_ack`

Feature: [#1022](https://github.com/generacy-ai/generacy/issues/1022)
Branch: `1022-part-cockpit-remote-gates`

Audiences:
- **Skill authors** wiring `/cockpit:auto` to open/ack remote gates (P4 work, `agency` repo).
- **Implementers** landing this branch.
- **Test authors** building parity/coverage for the two new tools.

---

## For skill authors (`/cockpit:auto` in the `agency` repo)

Once this branch lands and the sibling orchestrator route PR is deployed,
`/cockpit:auto` can dispatch a gate through the cloud inbox:

```ts
// Open a gate (POSTs to /cockpit/gates on the local orchestrator).
const open = await mcp.callTool('cockpit_gate_open', gateRecord);

if (open.status === 'ok') {
  const { gateId, status } = open.data;
  ledger.append({ event: 'gate-opened', gateId, status });
} else if (open.class === 'transport') {
  // Cloud path unavailable (orchestrator down, cluster not cloud-activated, timeout, 5xx).
  // Fall back to the local AskUserQuestion gate.
  return askUserQuestion(fallbackFor(gateRecord));
} else {
  // invalid-args | unknown-gate | internal — propagate as today.
  throw new SkillError(open.class, open.detail);
}
```

Later, when the operator resolves the inbox item (or `AskUserQuestion`
returns):

```ts
const ack = await mcp.callTool('cockpit_gate_ack', {
  gateId,
  outcome: 'approved',
  detail: 'batch 1 answers look correct',
});

if (ack.status === 'ok') {
  ledger.append({ event: 'gate-acked', gateId, outcome: 'approved' });
} else if (ack.class === 'transport') {
  // Retry policy is at the skill's discretion — see auto.md P4 change.
  scheduleRetry({ gateId, outcome, detail });
} else if (ack.class === 'unknown-gate') {
  // Gate was already garbage-collected or superseded — log and move on.
  ledger.append({ event: 'gate-ack-noop', gateId, reason: 'unknown-gate' });
}
```

**Feature-flag pattern** (recommended in `auto.md` P4 change):

```yaml
# frontmatter
args:
  - name: gates
    default: auto     # auto | local
```

- `--gates=auto` (default): use `cockpit_gate_open`, fall back to `AskUserQuestion` on `transport`.
- `--gates=local`: skip the MCP tools entirely, use `AskUserQuestion` unconditionally (preserves today's behavior for operators without cloud activation).

---

## For implementers

### Landing the change

1. **Add source files** per `plan.md` § "Project Structure" — the `gates/`
   sub-folder, two `tools/cockpit_gate_*.ts` handlers, three test files.
2. **Modify** `mcp/server.ts`:
   - Extend `BuildMcpServerDeps` with `orchestratorUrl?: string`,
     `orchestratorTimeoutMs?: number`, `fetchImpl?: typeof fetch`.
   - Register `cockpit_gate_open` and `cockpit_gate_ack` at the **end** of
     the tool list, with a header comment documenting the Q3 → A exception to
     design invariant #1.
3. **Modify** `mcp/schemas.ts` to export `CockpitGateOpenInputSchema` and
   `CockpitGateAckInputSchema` (both defined in `data-model.md`).
4. **No changes** to `mcp/errors.ts` — the four `ErrorClass` values used
   (`transport`, `invalid-args`, `unknown-gate`, `internal`) already exist.
5. **Add changeset** `.changeset/1022-cockpit-remote-gates-mcp.md`:

   ```markdown
   ---
   '@generacy-ai/generacy': minor
   ---

   feat(cockpit-mcp): add `cockpit_gate_open` and `cockpit_gate_ack` HTTP-client tools for the Cockpit Remote Gates epic (#1022).
   ```

6. **Run** locally:

   ```bash
   pnpm --filter @generacy-ai/generacy build
   pnpm --filter @generacy-ai/generacy test -- gate
   ```

### Verifying the injection seam

The two tools resolve orchestrator URL / timeout / `fetch` via
`resolveGateOptions(deps, env)` — parity tests should inject them like this:

```ts
import { buildMcpServer } from '../server.js';

const spy = vi.fn(async () => new Response(JSON.stringify({ gateId: 'g_1', status: 'open' })));
const server = buildMcpServer({
  orchestratorUrl: 'http://mock.local',
  orchestratorTimeoutMs: 100,
  fetchImpl: spy,
});

// ...invoke through MCP SDK in-process transport, matches parity-claim.test.ts pattern.
```

No `global.fetch` monkey-patch, no `nock`, no `msw`.

### Timeout test

```ts
const spy = vi.fn(async (_url: string, opts?: RequestInit) => {
  // Await the abort signal, then throw an AbortError.
  await new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  throw new Error('unreachable');
});

const result = await cockpitGateOpen({/*...*/}, {
  orchestratorUrl: 'http://mock.local',
  orchestratorTimeoutMs: 10,
  fetchImpl: spy,
});

expect(result.status).toBe('error');
expect(result).toMatchObject({ class: 'transport', detail: /timed out after 10ms/ });
```

---

## For operators (post-P4)

If your cluster is running the orchestrator gate routes and is cloud-activated,
`/cockpit:auto` will send its human gates to your generacy.ai operator inbox
by default. Nothing to configure.

To **force the local `AskUserQuestion` path**:

```bash
/cockpit:auto --gates=local generacy-ai/generacy#1022
```

To **override the orchestrator URL** (unusual — only if the orchestrator listens
on a non-default host/port):

```bash
export ORCHESTRATOR_URL=http://127.0.0.1:3900
```

---

## Troubleshooting

| Symptom                                                        | Likely cause                                        | Fix                                             |
|----------------------------------------------------------------|-----------------------------------------------------|-------------------------------------------------|
| Every gate falls back to `AskUserQuestion`                     | Orchestrator not running or wrong `ORCHESTRATOR_URL` | Check `curl http://127.0.0.1:3100/health`. Ensure `generacy up`. |
| Skill hangs 5s per gate then falls back                        | Cluster not cloud-activated                          | Expected until P1 (orchestrator routes) and cloud onboarding land. |
| `class: 'unknown-gate'` on every ack                           | Gate id from a prior process; orchestrator restarted | Skill should log and continue; not a fixable error. |
| `class: 'invalid-args'` on `cockpit_gate_ack` with valid input | Passed `gate_id` instead of `gateId` (strict mode)   | Fix the caller's key name.                       |
| Tests fail with real HTTP calls in CI                          | Missing `fetchImpl` in test deps                     | Pass `fetchImpl: spy` via `buildMcpServer(deps)`. |

---

## Available MCP commands (post-landing)

Registered on the `cockpit` MCP server (`packages/generacy` — `generacy cockpit mcp`):

| Tool name              | Purpose                                              |
|------------------------|------------------------------------------------------|
| `cockpit_gate_open`    | Open a remote gate on the orchestrator.              |
| `cockpit_gate_ack`     | Ack a previously-opened gate with an outcome.        |

Both tools are only registered when `mcp/index.ts` starts the server, which
refuses on worker containers (`GENERACY_CLUSTER_ROLE=worker`).

**Not exposed as CLI verbs** — see spec Q3 → A / plan D-1 for rationale.
