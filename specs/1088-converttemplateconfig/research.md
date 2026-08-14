# Research: 1088-converttemplateconfig

Decisions with rationale and rejected alternatives. All clarifications (Q1–Q5) were answered on the issue before planning; this document records the *implementation-level* decisions layered on top.

## D1 — Represent "no branch preference" as `undefined`, not a sentinel string

**Decision**: `WorkspaceConfigSchema.branch` becomes `z.string().min(1).optional()` (no default); `WorkspaceConfig.branch` infers to `string | undefined`. `convertTemplateConfig` passes `template.branch` straight through. The CLI's local `WorkspaceConfig.branch` becomes `string | undefined`.

**Rationale**: FR-001 requires downstream code to distinguish "explicitly configured" from "no preference". `undefined` is the native TypeScript representation, is what the existing `??` resolution chain in `workspace.ts:107-112` already keys on, and is free at every call site once the type widens. The repo's tsconfig does **not** enable `exactOptionalPropertyTypes`, so `{ branch: template.branch }` with a possibly-undefined value assigns cleanly to the optional property.

**Alternatives rejected**:
- *Sentinel string* (e.g. `branch: 'HEAD'` or `'__default__'`): every consumer must know the magic value; grep-based SC-004 gate gets murkier; Zod `.min(1)` validation would accept the sentinel from user YAML.
- *Discriminated object* (`{ kind: 'explicit', name } | { kind: 'default' }`): over-engineered for one field with exactly one runtime reader.

## D2 — No default-branch lookup; inherit git-native behavior (confirmed Q2=A)

**Decision**: Never resolve the *name* of the remote default branch. New repos: `git clone <url>` without `--branch` (git checks out the remote HEAD). Existing repos: stay on whatever branch they're on.

**Rationale**: Confirmed at clarify. Avoids a network/auth dependency inside `setup workspace` (which runs pre-credential in some paths), avoids `gh api` coupling, and the outcome is identical: the repo ends up on its default branch. The tool logs the *decision mode* (`repo default / current branch`) instead of a resolved name — sufficient per Q4=A.

**Alternatives rejected**:
- *GitHub API `GET /repos/:owner/:repo`*: auth requirement, network dependency, new failure mode.
- *`git ls-remote --symref origin HEAD`*: works unauthenticated for public repos but adds a network round-trip per repo and still needs credentials for private repos before `ensureGitCredentials()` has necessarily run.

## D3 — Non-standard checkout detection via local refs only (Q5=A mechanics)

**Decision**: In the no-preference update path, after `git fetch origin`:
1. `git branch --show-current` → empty stdout ⇒ **detached HEAD** ⇒ fetch-only, `warn`, success.
2. `git rev-parse --verify --quiet refs/remotes/origin/<current>` → non-zero exit ⇒ **no matching remote branch** ⇒ fetch-only, `warn`, success.
3. Otherwise `git pull origin <current>` (best-effort; pull failure is not repo failure, matching today's behavior where `execSafe`'s pull result is unchecked).

**Rationale**: Both probes are pure local-ref reads against just-fetched state — zero extra network. `git branch --show-current` is already the branch-detection mechanism at `workspace.ts:201`. The `refs/remotes/origin/` prefix (not bare `origin/<b>`) avoids ambiguity with a local branch literally named `origin/<b>`.

**Alternatives rejected**:
- *Attempt the pull and swallow the error* (clarify option B): same non-mutating outcome but noisier logs and an expected-failure pattern; explicitly rejected at clarify.
- *`git ls-remote --exit-code --heads origin <b>`*: network call; D2 forbids adding those.

## D4 — No-preference clone skips the `--branch` attempt entirely

**Decision**: When `config.branch` is `undefined`, `cloneOrUpdateRepo` goes straight to `git clone <url> <target>` — it does not attempt `--branch undefined` nor reuse the two-step try/fallback.

**Rationale**: FR-004 says the existing fallback path "becomes the primary path". Interpolating `undefined` into the command is a bug; running the two-step dance with a placeholder wastes a clone attempt. The existing fallback code at `workspace.ts:236` is reused as the direct path; the explicit-branch two-step (`--branch` then fallback) is preserved verbatim for the explicit case (US3).

## D5 — FR-006 logging: value + source on the existing "Configuration" line

**Decision**: `resolveWorkspaceConfig` returns a `branchSource: 'CLI flag' | 'REPO_BRANCH env' | 'DEFAULT_BRANCH env' | 'config file' | 'none'` alongside `branch`. The existing `Configuration` log line gains `branchSource` and renders `branch: '(repo default / current branch)'` when undefined. The per-repo clone line renders `branch: '(repo default)'` when undefined.

**Rationale**: The finetooth incident was diagnosed from exactly this line (`branch: "develop"` with no indication *why*). Adding the source makes the next incident a one-line diagnosis. Reusing the existing line (not a new one) per FR-006 wording and Q4=A (no extra notice).

**Alternatives rejected**:
- *One-time deprecation `warn` when the old code would have picked `'develop'`* (clarify Q4 option B): rejected at clarify.

## D6 — Changeset shape

**Decision**: Single `.changeset/1088-branch-no-preference.md` bumping `@generacy-ai/config` **minor** and `@generacy-ai/generacy` **patch**.

**Rationale** (per CLAUDE.md changeset rules):
- `@generacy-ai/config`: the top-level `branch:` template key is a **new capability** (user-facing config surface) → minor. The `WorkspaceConfig.branch` optionality is also a public type change re-exported from the package's `index.ts`.
- `@generacy-ai/generacy`: behavior fix in `setup workspace` (defect class) with no new public exports → patch.
- Both packages' non-test `src/` change, so both must be listed — the CI gate only checks that *a* changeset exists, but a missing package silently ships unreleased.

## Key sources

- `packages/config/src/convert-template.ts:26` — root-cause literal.
- `packages/config/src/workspace-schema.ts:12` — Zod default (second path, Q1=A).
- `packages/generacy/src/cli/commands/setup/workspace.ts:107-112` (resolution chain), `:181-244` (`cloneOrUpdateRepo`), `:297` (Configuration log).
- Consumer audit: `packages/config/src/repos.ts`, `packages/orchestrator/src/worker/claude-cli-worker.ts`, `packages/cockpit/src/config/loader.ts`, `packages/generacy/src/config/schema.ts` — zero runtime readers of `.branch` outside `workspace.ts` (full table in plan.md § Design 1).
- Incident: finetooth cluster log excerpt in spec § Observed; unrelated-histories condition tracked as generacy-ai/generacy-cloud#909 (out of scope).
