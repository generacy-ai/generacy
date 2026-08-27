# Research: Gateway-route validate warning + doctor llm-gateway check

Full rationale for the decisions summarized in `plan.md`. All code references at
branch `1200-context-gateway-shaped-model` (develop-based).

## D-1: `resolveRoute` — import contract, ownership, and the hard block

**Decision**: Both consumers import `resolveRoute` from
`@generacy-ai/generacy-plugin-claude-code`. Contract pinned from #1198's spec:
`resolveRoute(model?: string): 'subscription' | 'gateway'` — `'gateway'` iff the
model string contains `/`; `undefined` or no slash → `'subscription'`. If the
export does not exist at implement time, this issue **blocks/requeues** (Q1=A).

**Rationale**:
- generacy#1198 is the declared owner of the export and is queued in the same
  epic phase. Making #1200 a second definition site would be exactly the
  parallel-decomposition drift the epic's P1 integration issue (#1201) exists to
  catch.
- The #1200 spec's route names (`anthropic | gateway`) predate #1198's pinned
  contract (`'subscription' | 'gateway'`). The plan corrects to #1198's naming —
  the sibling that *owns* the helper wins the naming dispute; #1200's `anthropic`
  maps to `'subscription'`.
- Verify command at implement time:
  `grep -rn "export.*resolveRoute" packages/generacy-plugin-claude-code/src/`.
  Note the repo already has an unrelated `resolveRoute` in
  `packages/cluster-relay/src/dispatcher.ts` (path-prefix dispatcher) — the grep
  is scoped to the plugin package to avoid a false positive.

**Alternatives rejected**:
- *Define it here (Q1 option B)*: dual ownership across a single phase.
- *Local interim classifier (Q1 option C)*: ships a second implementation of the
  route rule that must be deleted later; a divergence between the interim and
  shared rule would be silent (warning fires/doesn't fire — no error surface).

**Consequence**: `packages/generacy/package.json` gains
`"@generacy-ai/generacy-plugin-claude-code": "workspace:*"` (verified absent
today — only `@generacy-ai/cockpit` and `@generacy-ai/config` are depended on).

## D-2: Warn only where `model` is explicitly set

**Decision**: `collectGatewayWarnings` emits a warning only for entries that
explicitly carry a `model` field resolving to the gateway route (early return
`if (!entry?.model) return;`, mirroring `collectEffortWarnings`'
`if (!entry?.effort) return;` at `loader.ts:381`).

**Rationale**:
- Mirrors the established effort-warning semantics: warn at the *config line the
  operator wrote*, not at every resolved leaf. A gateway model on
  `agents.default` would otherwise multiply into one warning per workflow per
  phase — noise that obscures the single fix site.
- FR-004 requires the warning name the exact config path; the set-site is the
  only unambiguous path.

**Alternative rejected**: warning at every resolved (inherited) entry — the
count scales with config size, and every warning names a path the operator did
NOT set, inviting "but I never configured that phase" confusion.

## D-3: Cockpit block — lenient passthrough + tolerant duck-walk

**Decision**: `GeneracyConfigSchema` gains `cockpit: z.unknown().optional()`.
`collectGatewayWarnings` duck-types into
`cockpit.auto.agents.{default,clarifier,reviewer,validator,fixer,diagnoser}`
with narrowing guards at each step; any missing/malformed level yields no
warnings and no crash.

**Rationale**:
- Today `GeneracyConfigSchema` is a plain `z.object` — Zod's default behavior
  *strips* unknown keys, so a `cockpit:` block in `.generacy/config.yaml` never
  reaches `collectGatewayWarnings` unless the schema is told to keep it.
  `z.unknown().optional()` keeps the bytes without asserting shape.
- The cockpit package parses the same block itself
  (`packages/cockpit/src/config/loader.ts`) with degrade-to-warnings semantics
  for auto-block failures. Importing cockpit's `.strict()` schemas here would
  make `generacy validate` hard-reject configs cockpit's own loader tolerates —
  a new error path FR-005 forbids.
- The spec's Assumption is explicit: "the walk must not crash when it is
  absent." Duck-typing with `typeof x === 'object' && x !== null` guards is the
  crash-proof shape.
- Role list matches `COCKPIT_AGENT_ROLES` in
  `packages/cockpit/src/config/schema.ts` (`clarifier`, `reviewer`, `validator`,
  `fixer`, `diagnoser`) plus `default`.

**Alternatives rejected**:
- *Import `@generacy-ai/cockpit` schemas*: strictness mismatch above, plus a new
  runtime coupling from the config loader to cockpit for a warnings-only walk.
- *Add a typed lenient cockpit sub-schema locally*: duplicates cockpit's shape
  and rots when cockpit adds roles; `z.unknown()` + duck-walk rots gracefully
  (new roles just don't get warnings until the list is extended).

## D-4: Doctor check dependencies — `['config']`, not `['env-file']`

**Decision**: `llmGatewayCheck` declares `dependencies: ['config']`. Env reads
use `context.envVars?.[K] ?? process.env[K]`.

**Rationale**:
- The runner (`doctor/runner.ts`) **skip-propagates** both `'fail'` and
  `'skip'` from dependencies (`findFailedDependency`). The `env-file` check
  **fails** when `.generacy/generacy.env` is missing or lacks
  `GITHUB_TOKEN`/`ANTHROPIC_API_KEY`. Compose-env clusters — the exact
  population Q2=C protects (gateway URL/token injected via compose, no env
  file) — would therefore have the llm-gateway check *skipped* under
  `dependencies: ['env-file']`. That inverts the feature's purpose.
- `config` is needed anyway: the FR-008 fallback probe requires a
  gateway-routed model from config.
- **Tier-concurrency caveat (documented, accepted)**: with
  `dependencies: ['config']`, the check shares a tier with `env-file`. The
  runner executes tiers with `Promise.all` and merges a check's `data` into
  context only after its promise resolves — a microtask *after* same-tier
  siblings have already read `context.envVars`. So in a full `generacy doctor`
  run, `context.envVars` is typically still `null` when this check reads it,
  and `process.env` dominates. This still implements Q2=C's letter
  (envVars-first with fallback), behaves correctly under
  `--check llm-gateway` (env-file excluded from the resolved set → envVars
  genuinely absent), and correctly serves compose-env clusters. The
  alternative that would make envVars deterministic (`['env-file']`) is
  explicitly rejected by the Q2=C rationale.

**Alternatives rejected**:
- `dependencies: ['env-file']` (Q2 option A alone): skip on compose-env
  clusters, per above.
- `dependencies: []`: loses `context.config` for the fallback-probe model and
  runs the check before config validity is established.

## D-5: Probe design — GET /v1/models, POST /v1/messages fallback, timeouts

**Decision**: Primary probe `GET <url>/v1/models` with
`Authorization: Bearer <token>`. On 404/405, fall back to
`POST <url>/v1/messages` with body
`{ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }`,
where `model` is the first gateway-routed model found in config (walk order:
`agents.default`, workflow defaults, phases, cockpit block). If no
gateway-routed model exists in config when the fallback is needed → return
`warn` (reachable but unverifiable), not `fail`. Each request uses
`AbortSignal.timeout(2_000)`.

**Rationale**:
- Q3=C: `/v1/models` is optional in the Claude Code gateway contract
  (discovery gated behind `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`);
  `POST /v1/messages` is the only guaranteed endpoint. GET-only would
  false-fail a healthy Bifrost; POST-only spends tokens on every run.
- 2 s per-request: the runner wraps `services`-category checks in a hard 5 s
  timeout (`withTimeout(5_000)` for `NETWORK_CATEGORIES`). Primary (2 s) +
  fallback (2 s) fits with ~1 s headroom. `anthropic-key` uses a single 5 s
  request; two sequential 5 s requests would let the runner's timeout kill the
  check mid-fallback and report a generic timeout instead of the FR-010
  mapping.
- `warn` on no-model-for-fallback: the gateway answered (404/405 means TCP +
  HTTP + auth path all work), and the missing piece is config-side, not
  gateway-side. Failing would tell the operator to fix the wrong thing.
- 404/405 from the *fallback* itself maps per FR-010 (fail with HTTP status) —
  the fallback trigger exception applies only to the primary.

## D-6: Check identity

`id: 'llm-gateway'`, `label: 'LLM Gateway'`, `category: 'services'`,
`priority: 'P1'`. Registered in `createDefaultRegistry()` after
`agencyMcpCheck` (keeps the Service-category grouping in `doctor.ts`).
`services` (not `credentials`) because the check verifies a service endpoint's
reachability first and auth second; both categories get the 5 s network
timeout, so the budget analysis is unchanged either way.

## D-7: Warning text format

**Decision**:
`` `${path}.model — set to '<model>' which resolves to the gateway route, but GENERACY_LLM_GATEWAY_URL is not set in this environment. The model will not route anywhere at spawn time.` ``

**Rationale**: byte-shape mirrors the effort warning
(`${path}.effort — set to '...' but ... The field will be dropped at spawn time.`)
so the validate output reads as one consistent warning family. Names the exact
config path (FR-004/SC-004) and the model string, states the consequence in
spawn-time terms.

## D-8: Changeset

`@generacy-ai/generacy` **minor** — a new doctor check plus a new validate
warning are user-visible capability additions (CLAUDE.md rule: new capability →
minor). Written at implement time as
`.changeset/1200-llm-gateway-doctor-validate.md`. The plan-phase commit itself
touches only `specs/` + `CLAUDE.md`, which are outside `packages/*/src/` — no
changeset needed for it.

## Env-var injection for warning tests

`collectGatewayWarnings(config, env = process.env)` takes an optional env
parameter. FR-003 reads "the process env", and the default preserves that; the
parameter exists so the SC-001 matrix tests don't mutate `process.env`
(mirrors how the doctor tests stub rather than mutate).

## Key sources

- `packages/generacy/src/config/loader.ts:346-411` — warnings channel + tier-walk pattern
- `packages/generacy/src/cli/commands/doctor/checks/anthropic-key.ts` — probe/error-mapping model
- `packages/generacy/src/cli/commands/doctor/checks/env-file.ts` — fail-on-missing behavior that drove D-4
- `packages/generacy/src/cli/commands/doctor/runner.ts` — tier execution, skip propagation, 5 s network timeout, data-merge timing
- `packages/generacy/src/cli/commands/doctor/registry.ts` — Kahn's + alphabetical ordering
- `packages/cockpit/src/config/{loader,schema}.ts` — cockpit block location + role vocabulary
- `packages/config/src/template-schema.ts:22-26` — `AgentEntrySchema` shape
- specs/1198 (sibling) — pinned `resolveRoute` contract
- `docs/llm-gateway-model-routing-plan.md` (tetrad-development) — epic design; condensed summary in generacy-ai/generacy#1197 body
