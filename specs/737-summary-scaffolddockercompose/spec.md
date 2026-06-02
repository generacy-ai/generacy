# Feature Specification: Fix `scaffoldDockerCompose` `volume` claudeConfigMode mounting named volume onto a file

**Branch**: `737-summary-scaffolddockercompose` | **Date**: 2026-06-02 | **Status**: Draft
**Issue**: [generacy-ai/generacy#737](https://github.com/generacy-ai/generacy/issues/737)
**Related**: [generacy-ai/generacy-cloud#782](https://github.com/generacy-ai/generacy-cloud/pull/782) (equivalent cloud-side fix)

## Summary

`scaffoldDockerCompose` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` has a latent bug in its `volume` Claude-config mode: it mounts the `claude-config` **named volume onto a file path** `/home/node/.claude.json`:

```ts
const claudeConfigVolume =
  claudeConfigMode === 'bind'
    ? '~/.claude.json:/home/node/.claude.json'      // works (file→file bind)
    : 'claude-config:/home/node/.claude.json';      // BROKEN (named volume → file)
```

Docker named volumes are directories; the cluster image ships `.claude.json` as a *file*, so `docker compose up` fails to start the orchestrator with:

```
Error response from daemon: source .../home/node/.claude.json is not directory
```

The default is `bind` mode, so this never triggers locally — but any caller passing `claudeConfigMode: 'volume'` gets a cluster whose orchestrator can't start. generacy-cloud's cloud-deploy template (which duplicated this scaffolder) hit exactly this in production; fixed there in generacy-ai/generacy-cloud#782.

## User Stories

### US1: Cloud-deploy / CLI caller using `volume` mode gets a working cluster

**As a** caller of `scaffoldDockerCompose` that passes `claudeConfigMode: 'volume'` (e.g. `generacy deploy` for BYO-VM cloud provisioning),
**I want** the generated `docker-compose.yml` to actually start the orchestrator and worker,
**So that** my scaffolded cluster boots and reaches the bootstrap wizard without manual compose edits.

**Acceptance Criteria**:
- [ ] `docker compose up -d` against a `volume`-mode scaffolded compose file succeeds for both orchestrator and worker — no `source ... is not directory` error.
- [ ] The orchestrator can read/write its Claude config across container recreations (or, if ephemeral was chosen, the config is allowed to reset across recreations without breaking startup).

### US2: Local user using default `bind` mode is unaffected

**As a** local CLI user invoking `generacy launch` (which uses `claudeConfigMode: 'bind'`),
**I want** my existing scaffolded compose file to keep working exactly as before,
**So that** the fix doesn't regress the happy path that is in active use.

**Acceptance Criteria**:
- [ ] `bind`-mode output retains the `~/.claude.json:/home/node/.claude.json` mount and is byte-identical aside from the `volume`-branch lines.
- [ ] Local `generacy launch` and subsequent `up` continue to work without changes elsewhere.

## Functional Requirements

| ID    | Requirement                                                                                                                                                                                  | Priority | Notes                                                                                                                       |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-----------------------------------------------------------------------------------------------------------------------------|
| FR-001 | In `volume` mode, `scaffoldDockerCompose` MUST NOT emit a named-volume → file mount (`claude-config:/home/node/.claude.json`).                                                              | P1       | Root-cause fix.                                                                                                             |
| FR-002 | In `volume` mode, the orchestrator/worker MUST still be able to start with a valid `/home/node/.claude.json` present (created by the image or by the scaffolder before `docker compose up`). | P1       | Choose between (a) bind a scaffolder-created file or (b) drop the mount and let `.claude.json` be ephemeral. See Open Questions. |
| FR-003 | When the fix does not use a named volume, the top-level `volumes:` map MUST NOT declare `claude-config: null`.                                                                              | P1       | Currently emitted at `scaffolder.ts:258`; must be conditional on the chosen approach.                                       |
| FR-004 | `bind` mode behavior MUST be unchanged (same mount line, no new file creation).                                                                                                             | P1       | Regression guard.                                                                                                           |
| FR-005 | If the scaffolder creates a `.claude.json` file on disk for binding (approach A), it MUST be owned by uid 1000 (the cluster image's `node` user) and have sensible permissions.             | P2       | Only applicable to approach A; mirrors generacy-cloud#782.                                                                  |
| FR-006 | The `ScaffoldComposeInput.claudeConfigMode` field MUST keep accepting `'bind' \| 'volume'` (no API rename) so existing callers (`generacy launch`, `generacy deploy`) compile unchanged.    | P1       | Backwards compatibility for the input shape; only the *emitted* compose changes.                                            |

## Success Criteria

| ID     | Metric                                                              | Target                                                                                                          | Measurement                                                                                                                            |
|--------|---------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|
| SC-001 | Orchestrator startup with `claudeConfigMode: 'volume'`             | `docker compose up -d` exits 0 and orchestrator reaches healthy state within `start_period` (30s).             | Run `docker compose ps --format json` and assert `orchestrator.Health == "healthy"` against a fresh `volume`-mode scaffold.            |
| SC-002 | No regression to `bind` mode                                        | `bind`-mode `docker-compose.yml` is unchanged outside the `volume` branch lines.                                | Snapshot diff of generated compose for a fixed `ScaffoldComposeInput` before/after fix — only the `volume` branch differs.            |
| SC-003 | `generacy deploy` cloud flow completes                              | A real `generacy deploy ssh://...` to a clean VM reaches "cluster status: connected" without manual edits.    | Manual or scripted end-to-end against a throwaway VM (or staging). Optional gating criterion; primary is SC-001.                       |

## Assumptions

- The fix can mirror the generacy-cloud#782 approach (bind a scaffolder-created file). No need to invent a new architecture.
- Callers of the scaffolder (`generacy launch` uses `'bind'`, `generacy deploy` uses `'volume'`) do not rely on the specific volume name `claude-config` being present in the emitted compose for any other purpose (grep confirms no other reference within `packages/generacy`).
- The cluster image (`cluster-base`) already ensures `/home/node/.claude.json` exists inside the container with valid contents at the time of mount — i.e., the host-side file the scaffolder creates can be an empty/blank JSON file and the container will continue to function.
- Per-cluster persistence of `.claude.json` across container recreations is desirable for `volume` mode but not strictly required for shipping the fix; the issue explicitly lists "drop the mount and let `.claude.json` be ephemeral" as an acceptable variant.

## Out of Scope

- Refactoring `scaffoldDockerCompose` beyond the minimum needed to fix the `volume` branch and the conditional top-level volume declaration.
- Changes to the `cluster-base` image or its bundled `.claude.json`.
- Changes to `generacy-cloud`'s template (already fixed in generacy-cloud#782).
- Migrating existing scaffolded clusters that were already created with the broken compose — those users can rerun the scaffolder or hand-edit.
- Adding new `claudeConfigMode` variants (e.g., `'none'`, `'ephemeral'`); we keep the existing two-value union.

## Open Questions

1. **Approach A vs B** — bind a scaffolder-created `<scaffold-dir>/claude.json` (matches generacy-cloud#782, persists across container recreations), or drop the mount entirely (ephemeral)? Recommend A for parity with the cloud fix and to preserve the implicit persistence promise of the `volume` name. Defer to `/clarify`.
2. **File ownership when approach A is chosen** — the scaffolder runs on the *host* (any uid), but the container expects uid 1000. Do we `chown` (requires root on host), document the limitation, or use `:Z`/`:z`/explicit `user:` directive? generacy-cloud#782's resolution should inform this.

---

*Generated by speckit*
