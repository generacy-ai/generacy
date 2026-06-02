# Implementation Plan: Fix `scaffoldDockerCompose` `volume`-mode Claude config mount

**Feature**: Repair `claudeConfigMode: 'volume'` in `scaffoldDockerCompose` so deploy-scaffolded clusters can actually start.
**Branch**: `737-summary-scaffolddockercompose`
**Status**: Complete
**Spec**: [spec.md](./spec.md) · **Clarifications**: [clarifications.md](./clarifications.md)
**Input**: Feature specification from `/specs/737-summary-scaffolddockercompose/spec.md`

## Summary

`scaffoldDockerCompose` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` has a latent bug in its `volume` Claude-config mode: it tries to mount the Docker named volume `claude-config` onto the **file** path `/home/node/.claude.json`. Docker named volumes are directories, so on first `docker compose up` the daemon refuses with `source ... /home/node/.claude.json is not directory` and the orchestrator never starts.

The default (`bind`) path works, so `generacy launch` never trips this — but `generacy deploy` (and any other caller passing `claudeConfigMode: 'volume'`) gets a cluster that refuses to boot. generacy-cloud's cloud-deploy template hit this in production and shipped a fix in [generacy-ai/generacy-cloud#782](https://github.com/generacy-ai/generacy-cloud/pull/782). This issue lands the in-tree mirror.

**Approach** (settled in [clarifications.md](./clarifications.md) Q1–Q5):

1. In `volume` mode, replace the broken `claude-config:/home/node/.claude.json` mount with a **compose-relative file bind**: `./claude.json:/home/node/.claude.json`, on both `orchestrator` and `worker` services.
2. The scaffolder writes a blank `{}\n` file at `<scaffoldDir>/claude.json` (created only if missing — `claude /login` output is never clobbered).
3. The scaffolder best-effort `chown 1000:1000` on the new file; on `EPERM`/`EACCES` it logs a warning and continues.
4. The top-level `volumes:` map no longer declares `claude-config:` in `volume` mode (it was a dead reference).
5. `remote-compose.ts` runs an idempotent ownership-fix SSH command (`test -f ... || install -o 1000 -g 1000 -m 0600 ...; chown 1000:1000 ... 2>/dev/null || true`) before `docker compose pull`, so the file lands on the VM owned correctly when the SSH user has the privilege and degrades silently otherwise.

`bind` mode emits byte-identical YAML to today's output.

## Technical Context

**Language/Version**: TypeScript, Node.js ≥ 22 (CLI package gate).
**Primary Dependencies**: `node:fs`, `node:path`, `yaml`, project logger (`../../utils/logger.js`).
**Storage**: Local filesystem (`<scaffoldDir>/claude.json`) for `launch`; SCP'd bundle dir on remote VM for `deploy`.
**Testing**: `vitest` unit tests in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` (existing — extended, not replaced). Manual repro for SC-001/SC-003/SC-005 against a fresh cluster scaffold + `docker compose up`.
**Target Platform**: macOS/Linux developer hosts (`launch`), any SSH-reachable Linux VM (`deploy`); container runtime is Linux uid 1000.
**Project Type**: CLI package inside an npm/pnpm workspace monorepo. Implementation surface is intentionally small (one function in `scaffolder.ts`, one SSH command in `remote-compose.ts`).
**Performance Goals**: Not applicable — the scaffolder runs once per cluster boot; the extra `writeFile` + `chown` are <1 ms each. No hot path.
**Constraints**:
- MUST NOT change `bind`-mode output (SC-002 byte-equality).
- MUST NOT throw on non-root hosts; degrade with a warning (FR-004, FR-008).
- MUST preserve existing `claude.json` on re-scaffold (FR-003, idempotency Q4).
- MUST stay self-contained — no new package deps (use `node:fs.chownSync`).
**Scale/Scope**: Two source files modified, one extended test file, one new `claude.json` artifact per scaffolded cluster.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo, so there is no formal gate to clear. The implementation follows the codebase's standing conventions (mirrored from neighbouring scaffolder code and the spec's "do not change `bind` behavior" rule):

- **Boundary-only validation**: no defensive checks on internal callers — `claudeConfigMode` is already typed as `'bind' | 'volume'`.
- **No backwards-compat shims**: the broken `volume` mode never produced working clusters, so existing on-disk compose files are simply re-scaffolded; no migration code.
- **No new error-handling layers**: `chown` failure → `logger.warn(...)`, continue. `writeFile` failure on the scaffold dir is already fatal (the directory is being scaffolded; if it's not writable, nothing works).
- **No new dependencies**.
- **Comment discipline**: a single comment-line on the chown call explaining the "why" (uid 1000 = container's `node` user; chown fails silently on non-root hosts).

## Project Structure

### Documentation (this feature)

```text
specs/737-summary-scaffolddockercompose/
├── spec.md                 # Feature spec (read-only)
├── clarifications.md       # Q1–Q5 settled
├── plan.md                 # This file
├── research.md             # Phase 0: decision log (mostly references clarifications.md)
├── data-model.md           # Phase 1: type / file-format contracts
├── quickstart.md           # Phase 1: how to verify the fix locally
├── contracts/
│   ├── scaffolder-volume-mode.md   # scaffoldDockerCompose volume-mode contract
│   └── remote-compose-ownership.md # remote-compose.ts ownership-fix contract
└── tasks.md                # NOT created here — produced by /speckit:tasks
```

### Source Code (repository root)

```text
packages/generacy/
├── src/cli/commands/
│   ├── cluster/
│   │   ├── scaffolder.ts                 # MODIFIED — volume-mode fix (FR-001..FR-006, FR-008)
│   │   └── __tests__/scaffolder.test.ts  # MODIFIED — extend volume-mode tests; lock bind byte-equality
│   ├── launch/scaffolder.ts              # UNCHANGED — already passes claudeConfigMode: 'bind'
│   └── deploy/
│       ├── scaffolder.ts                 # UNCHANGED — already passes claudeConfigMode: 'volume'
│       └── remote-compose.ts             # MODIFIED — add idempotent ownership-fix sshExec (FR-007)
└── src/cli/utils/logger.ts               # UNCHANGED — used for chown warnings
```

**Structure Decision**: This is a targeted fix inside an existing CLI package. No new packages, no new modules. All edits are concentrated in two files plus their tests; the shared scaffolder is the single source of truth for both `launch` and `deploy`, so fixing it there is enough.

### Behavior Matrix (After Fix)

| Caller             | `claudeConfigMode` | Compose mount                                      | Top-level `claude-config:` volume | `claude.json` file written | SSH `chown` fix |
|--------------------|--------------------|----------------------------------------------------|-----------------------------------|----------------------------|-----------------|
| `generacy launch`  | `bind` (default)   | `~/.claude.json:/home/node/.claude.json`           | NO (unchanged)                    | NO                         | N/A (local)     |
| `generacy deploy`  | `volume`           | `./claude.json:/home/node/.claude.json`            | NO (was YES — removed)            | YES (`{}\n` if missing)    | YES (in `remote-compose.ts`) |
| Future caller `bind` | `bind`           | `~/.claude.json:/home/node/.claude.json`           | NO                                | NO                         | N/A             |
| Future caller `volume` | `volume`       | `./claude.json:/home/node/.claude.json`            | NO                                | YES                        | Caller's responsibility |

## Complexity Tracking

No constitution violations. Justification cells intentionally empty — the fix is the minimum diff that resolves the defect.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  |            |                                     |

## Phase 0 — Research

See [research.md](./research.md). All five open questions were closed in clarification batch 1; research.md captures the decision log and references the upstream cloud fix for traceability.

## Phase 1 — Design Artifacts

- [data-model.md](./data-model.md) — `ScaffoldComposeInput` typing (no schema change), emitted compose YAML shape, on-disk `claude.json` shape.
- [contracts/scaffolder-volume-mode.md](./contracts/scaffolder-volume-mode.md) — preconditions, postconditions, idempotency rules for `scaffoldDockerCompose` in `volume` mode.
- [contracts/remote-compose-ownership.md](./contracts/remote-compose-ownership.md) — the exact SSH command and its degradation contract.
- [quickstart.md](./quickstart.md) — how to repro the bug, apply the fix, and verify SC-001/SC-002/SC-003/SC-005.

## Next Step

Run `/speckit:tasks` to derive a task list from this plan.
