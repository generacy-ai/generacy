# Clarifications

<!-- Batch 1 · 2026-07-09 -->

### Q1: Primary acting-identity resolution strategy
**Context**: FR-001 lists two sources — (a) derived from the orchestrator's App credential flow (bot login = `<app-slug>[bot]`) and (b) explicit env var `CLUSTER_ACTING_LOGIN` from scaffolder / cloud-deploy — with (a) marked "preferred, strongest first" and Assumption 1 hedging that if (a) isn't feasible "FR-001's derived source falls back to the explicit env var and FR-003/FR-004 carry the full weight." Today the App slug is not surfaced anywhere in the orchestrator: the `github-app` credential JSON only carries `installationId` / `token` / `accountLogin` / `gitIdentityLogin` (`packages/control-plane/src/services/wizard-env-writer.ts`), and installation tokens can't call `GET /app` to discover the slug at runtime. This choice determines the whole implementation shape — whether the primary path is a runtime read, a credential-schema extension, or a new provisioned env var.
**Question**: Which source is the primary path for acting-identity resolution in this PR?
**Options**:
- A: Env var only — ship `CLUSTER_ACTING_LOGIN` (or agreed name from Q3) as the sole source. Scaffolder writes it; cloud-deploy mirrors. No derivation code, no credential-schema change. Simplest; matches FR-003/FR-004 as written; leaves derivation as a follow-up if it ever proves valuable.
- B: Derive-from-credential — extend the `github-app` credential JSON to carry an `appSlug` field, plumb it through `wizard-env-writer.ts` into env or a config file the orchestrator reads at startup. No env var API added. Requires cloud-side wizard change to populate the field (blocking upstream); scaffolder path also needs to write it.
- C: Both — derive-from-credential when the field is present, fall back to the env var when it isn't. Two code paths, two configuration surfaces, but no ordering dependency on cloud-side changes.
- D: Runtime-derive via a new App-JWT credential — introduce App-JWT-scoped credentials so `gh api /app` works at startup. Fixes the underlying "installation tokens can't identify their app" problem but is materially larger than #874's scope.

**Answer**: *Pending*

### Q2: Env var name for the explicit provisioning source
**Context**: FR-001 and FR-003 reference the env var as `CLUSTER_ACTING_LOGIN` but flag "name TBD." The final name is what the scaffolder writes into `.env` and `docker-compose.yml`, what the cloud-deploy path must mirror (FR-004), what SC-005's grep-diff audit compares against, and what the FR-006 error log names as a tried chain link. It also sets the precedent for the sibling of the `#830` `CLUSTER_GITHUB_USERNAME` env var. Depends on Q1 (only load-bearing if the answer includes an env var; skip if Q1=B or Q1=D).
**Question**: What is the env var name?
**Options**:
- A: `CLUSTER_ACTING_LOGIN` — matches the spec's placeholder; symmetric with `CLUSTER_GITHUB_USERNAME` (both `CLUSTER_*`, both `_LOGIN`/`_USERNAME`); the noun "acting login" appears throughout the spec.
- B: `CLUSTER_BOT_LOGIN` — foregrounds that this is the bot identity, not a human account; reads clearly at call sites; less symmetric with the assignee var.
- C: `GENERACY_ACTING_LOGIN` — namespaced like `GENERACY_API_URL` / `GENERACY_RELAY_URL` (v1.5 canonical prefix, see CLAUDE.md #549); consistent with post-v1.5 env-var conventions.
- D: `CLUSTER_APP_SLUG` — stores the raw app slug (without `[bot]`), leaves normalization concerns entirely inside FR-002; more accurate to what's stored but less accurate to what the trust predicate compares against.

**Answer**: *Pending*

### Q3: Scope of bot-login normalization (FR-002)
**Context**: FR-002 says "strip the `[bot]` suffix from both sides before equality." GitHub login rules make case irrelevant for identity purposes (logins are case-insensitive at the identity layer, though the API preserves display case), and REST vs GraphQL differ not only on the `[bot]` suffix but sometimes on display case for legacy accounts. If the normalization only strips `[bot]`, a provisioned value of `Generacy-AI` vs an observed author `generacy-ai[bot]` still fails the equality check. Conversely, aggressive normalization (lowercase + trim + strip) creates a defense-in-depth surface where subtle differences (e.g., an operator-typed value with trailing whitespace in `docker-compose.yml`) still trust; but it also makes fixtures for SC-002 less clearly aligned with production values.
**Question**: What is the normalization pipeline the predicate applies to both sides of the comparison?
**Options**:
- A: `[bot]` suffix strip only — match the spec's FR-002 text literally; case-sensitive equality after strip. SC-002's four fixture pairs cover the suffix combinations; no case-mismatch coverage. Simplest; also matches how the existing `botLogin === comment.author` check in `comment-trust.ts:87` compares today.
- B: `[bot]` suffix strip + lowercase — case-insensitive equality after strip. Catches display-case drift between REST/GraphQL for legacy accounts and typo-in-env-var. Extends SC-002 to eight fixture pairs (four × case).
- C: `[bot]` suffix strip + lowercase + trim whitespace — full defense-in-depth. Also catches trailing-space-in-`.env` classes of misprovision. Extends SC-002 to sixteen pairs; harder to audit "what exactly was matched."
- D: Delegate — normalize input at provisioning time (scaffolder / cloud-deploy lowercase-and-strip before writing); predicate does simple suffix strip only. Moves the surface out of the trust module.

**Answer**: *Pending*

### Q4: FR-006 error log trigger and lifetime semantics
**Context**: FR-006 requires "exactly one `error`-level log line" at process startup "when acting-identity resolution returns nothing" naming each chain link tried and its outcome. Three ambiguities: (i) When does resolution "start" — synchronously at boot (blocking `server.listen()`), lazily at first monitor poll, or on demand at first trust-predicate call? (ii) If resolution succeeds via any chain link, is the error line ever emitted for the failing links (e.g., derivation succeeded but env var was empty)? (iii) On a resolution that transiently fails at startup (e.g., cloud-side derivation not yet responding) but would succeed later, does the error line fire once at boot and stick, or does the process re-attempt and rescind? These interact directly with US2's "diagnosable from a single log window" acceptance criteria.
**Question**: When is the FR-006 error line emitted and re-evaluated?
**Options**:
- A: Synchronous at startup, only on total failure — attempt every chain link once during boot; emit the error line iff all links returned nothing; never re-evaluate. Downstream `clusterIdentity` value cached for the process lifetime. Matches the spec's "process startup" wording literally; simplest; a transient failure at boot means degraded mode until restart.
- B: Synchronous at startup, always if any link failed — emit the error line describing every failed link even if some other link succeeded (partial-failure visibility). Downstream cached value populated. Louder; produces error lines on healthy clusters where a fallback link happens to be empty.
- C: Lazy on first predicate call, only on total failure — defer resolution until the first monitor poll needs `clusterIdentity`; emit the error line iff total failure at first call. Startup logs are quieter; the error line still lands in every window that contains any `untrustedCommentSkips` warn (US2's diagnosability criterion).
- D: Synchronous at startup with retry — attempt at boot, cache success/failure, re-attempt every N minutes on failure; emit the error line once per transition into failed state (not per attempt). More resilient to transient boot-time failures; more code; harder to reason about "one error per process."

**Answer**: *Pending*

### Q5: Cloud-deploy provisioning scope for this PR (FR-004)
**Context**: FR-004 requires "the cloud-deploy path" to provision the same acting-login source as FR-003, with "whichever lands first, an issue is opened in the other codebase to close the gap; the two are diffed before both close." Cloud-deploy lives in `generacy-cloud` (a separate repo); this repo owns the local scaffolder (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`) and the orchestrator. SC-005 acknowledges the cross-repo constraint ("If cloud-deploy lands in a separate repo, this SC is deferred to a cross-repo verification issue"). Two ordering choices affect scope: does this PR ship without the cloud-side change (relying on the follow-up issue), or is it blocked on the generacy-cloud PR landing first so both go out together? A third path stays in scope: whether this PR should also cover the current live-cloud-cluster case (where `generacy-cloud` hasn't shipped yet) by threading a temporary compensating source.
**Question**: What is the scope boundary between this PR and the generacy-cloud companion?
**Options**:
- A: Ship this PR standalone — local scaffolder writes the acting-login source; orchestrator + trust predicate work correctly for freshly-scaffolded local clusters immediately. Open a tracking issue in `generacy-cloud` for the cloud-side provisioning; live cloud clusters remain in degraded mode (FR-005 + FR-006 make it observable) until that issue lands. Cross-repo diff verification (SC-005) deferred to the follow-up.
- B: Block on generacy-cloud first — pause this repo's PR until the cloud-side companion is merged and includes the acting-login provisioning. Land both simultaneously so SC-005's grep-diff audit can run at merge time. Slower; more coordination; guarantees no cluster shape ships without provisioning.
- C: Ship this PR standalone + add a runtime compensating source in the orchestrator specifically for cloud clusters until generacy-cloud lands (e.g., read `accountLogin` from the `github-app` credential JSON as a temporary derivation source, with a log line noting the compensation). Removes the operational gap for live cloud clusters but violates FR-007 (no fallback to assignee/account chain) and adds transitional code.
- D: Ship this PR standalone with FR-004 explicitly downscoped to local scaffolder only — mark the cloud-deploy requirement in this spec as owner-changed-to-generacy-cloud, close this repo's spec once the local half is verified. No cross-repo issue tracked from here.

**Answer**: *Pending*
