# Feature Specification: ## Summary

`scaffoldDockerCompose` (`packages/generacy/src/cli/commands/cluster/scaffolder

**Branch**: `737-summary-scaffolddockercompose` | **Date**: 2026-06-02 | **Status**: Draft

## Summary

## Summary

`scaffoldDockerCompose` (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`) has a latent bug in its **`volume`** Claude-config mode: it mounts the `claude-config` **named volume onto the file path** `/home/node/.claude.json`:

```ts
const claudeConfigVolume =
  claudeConfigMode === 'bind'
    ? '~/.claude.json:/home/node/.claude.json'      // works (file→file bind)
    : 'claude-config:/home/node/.claude.json';      // BROKEN (named volume → file)
```

Docker named volumes are directories; the cluster image ships `.claude.json` as a *file*, so `docker compose up` fails to start the orchestrator:

```
Error response from daemon: source .../home/node/.claude.json is not directory
```

The default is `bind` mode, so this never triggers locally — but any caller passing `claudeConfigMode: 'volume'` gets a cluster whose orchestrator can't start. generacy-cloud's cloud-deploy template (which duplicated this scaffolder) hit exactly this in production; fixed there in generacy-ai/generacy-cloud#782.

## Suggested fix (mirror the generacy-cloud fix)

In `volume` mode, don't mount a named volume onto the file. Instead bind a real file and (if persistence is wanted) ensure it exists. Options:
- Bind a local file the scaffolder creates blank if missing (matches the cloud fix), e.g. `<scaffold-dir>/claude.json:/home/node/.claude.json`, created owned by the image's `node` user (uid 1000); or
- Drop the volume mount in `volume` mode and let `.claude.json` be ephemeral.

Either way, also remove the `claude-config` entry from the top-level `volumes:` map (`scaffolder.ts:258`) when not using a named volume.

## Acceptance criteria

- [ ] A cluster scaffolded with `claudeConfigMode: 'volume'` starts its orchestrator/worker successfully (no "is not directory" error).
- [ ] `bind` mode behavior is unchanged.

Context: discovered while debugging cloud cluster provisioning; see generacy-ai/generacy-cloud#782 for the equivalent fix and rationale.


## User Stories

### US1: Cloud-deploy caller can start a cluster in `volume` mode

**As a** caller of `scaffoldDockerCompose` that passes `claudeConfigMode: 'volume'` (e.g., `generacy deploy`, or the in-tree equivalent of generacy-cloud's cloud-deploy template),
**I want** the emitted `docker-compose.yml` to mount `.claude.json` against a real file (not a named volume),
**So that** `docker compose up` brings the orchestrator and worker up cleanly instead of failing with `source ... /home/node/.claude.json is not directory`.

**Acceptance Criteria**:
- [ ] Scaffolding with `claudeConfigMode: 'volume'` writes a `claude.json` file next to `docker-compose.yml` in the scaffold directory (created if missing, preserved if it already exists).
- [ ] The emitted compose uses a compose-relative bind mount: `./claude.json:/home/node/.claude.json` on both `orchestrator` and `worker` services.
- [ ] The emitted compose does NOT declare a `claude-config:` entry in the top-level `volumes:` map when `claudeConfigMode === 'volume'`.
- [ ] `docker compose up -d` starts both services successfully (no "is not directory" error) in a freshly scaffolded `volume`-mode cluster.

### US2: `bind`-mode callers see no behavior change

**As a** caller of `scaffoldDockerCompose` that uses the default `claudeConfigMode: 'bind'` (`generacy launch`, local devcontainer-style flows),
**I want** the emitted compose to be byte-identical to today's output,
**So that** existing local clusters continue working without re-scaffolding.

**Acceptance Criteria**:
- [ ] `claudeConfigMode === 'bind'` continues to emit `~/.claude.json:/home/node/.claude.json` on `orchestrator` and `worker`.
- [ ] `claudeConfigMode === 'bind'` does NOT create a per-cluster `claude.json` file.
- [ ] No top-level `claude-config:` volume is declared in `bind` mode (already true; verify it stays that way).

### US3: `deploy` SSH-to-VM flow lands a usable file on the VM

**As a** `generacy deploy ssh://...` user provisioning a cluster on a remote VM with `claudeConfigMode: 'volume'`,
**I want** `claude.json` to exist on the VM at the path the compose bind references, owned by uid 1000 when feasible, before `docker compose up` runs,
**So that** the orchestrator process (uid 1000 inside the container) can read and write the Claude session token across container recreations.

**Acceptance Criteria**:
- [ ] The scaffolder-written `claude.json` is included in the bundle scp'd to the VM (since the bind path is compose-relative).
- [ ] Before `docker compose pull` / `up`, `remote-compose.ts` runs an idempotent ownership fix over SSH:
  - Re-create the file with `install -o 1000 -g 1000 -m 0600 /dev/null` only if missing.
  - Best-effort `chown 1000:1000` on the path; suppress errors when the SSH user lacks privilege.
- [ ] When the SSH user *is* root (or has CAP_CHOWN), the file ends up owned by uid 1000:1000 with mode 0600.
- [ ] When the SSH user lacks privilege, the deploy still proceeds (best-effort) and the orchestrator starts.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | In `claudeConfigMode === 'volume'`, `scaffoldDockerCompose` MUST emit `./claude.json:/home/node/.claude.json` as the bind for both `orchestrator` and `worker` services. | P1 | Resolves Q1/Q2. Replaces broken `claude-config:/home/node/.claude.json`. |
| FR-002 | In `claudeConfigMode === 'volume'`, the scaffolder MUST create `<scaffoldDir>/claude.json` containing `{}\n` if it does not already exist. | P1 | Idempotency: skip if exists (Q4). |
| FR-003 | If `<scaffoldDir>/claude.json` already exists (non-zero or zero byte), the scaffolder MUST NOT overwrite it. | P1 | Preserves real session tokens across `generacy update` / re-scaffold (Q4). |
| FR-004 | After creating `<scaffoldDir>/claude.json`, the scaffolder SHOULD best-effort `chown 1000:1000` on the file. On `EPERM`/`EACCES`, log a warning to the logger and continue successfully. | P1 | Resolves Q3-A. Degrades cleanly on non-root hosts. |
| FR-005 | In `claudeConfigMode === 'volume'`, the scaffolder MUST NOT declare a `claude-config:` entry in the top-level `volumes:` map of the emitted compose. | P1 | Removes dead reference (Q1). |
| FR-006 | In `claudeConfigMode === 'bind'`, the scaffolder MUST emit `~/.claude.json:/home/node/.claude.json` on both services and MUST NOT create any per-cluster `claude.json` file. | P1 | No behavior change in default mode. |
| FR-007 | `remote-compose.ts` MUST run an idempotent ownership-fix SSH command before `docker compose pull` when `claudeConfigMode === 'volume'`: ensure-file-exists + best-effort `chown 1000:1000`, with errors suppressed via `\|\| true`. | P1 | Resolves Q5-C. Defense in depth for non-root SSH users. |
| FR-008 | The new file-creation and chown steps MUST log structured warnings (not throw) on permission errors so that a non-root scaffolder run on a Linux laptop completes without an exception. | P2 | Operability: matches today's user expectations for `launch`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `volume`-mode cluster boots cleanly | `docker compose up -d` against a freshly scaffolded `volume`-mode `.generacy/` brings `orchestrator` and `worker` to `running` (or `healthy`) with no "is not directory" error in `docker compose logs`. | Manual repro / integration test: scaffold → `up` → `docker compose ps`. |
| SC-002 | `bind`-mode emitted compose unchanged | Byte-equal `docker-compose.yml` output for an identical `ScaffoldComposeInput` with `claudeConfigMode === 'bind'` before vs after the fix. | Snapshot/golden comparison in scaffolder unit test. |
| SC-003 | Claude session survives container recreation | After `claude /login` inside the orchestrator and `docker compose down && up -d`, `claude` still recognizes the session (no re-auth required). | Manual repro on `volume`-mode cluster. |
| SC-004 | Re-scaffold preserves session token | After `claude /login` and re-running the scaffolder over the same `.generacy/`, `claude.json` contents are unchanged. | Hash of `claude.json` before/after re-scaffold. |
| SC-005 | `deploy` to VM as non-root succeeds | `generacy deploy ssh://user@vm` (where `user` ≠ root and lacks `sudo`) completes scaffolder + remote-compose without throwing; orchestrator starts (chown may fail silently, mount works because the SSH user owns the file). | Manual repro against a VM. |

## Assumptions

- The cluster image continues to run orchestrator/worker as `node` (uid 1000) with `USER node` in the Dockerfile and `user: node` in service definitions (verified via cluster-base#186 / docker-compose.yml#26,104).
- The cluster-base entrypoint does NOT have unrestricted root: its sudoers entry is scoped to `chmod 666` on the docker socket only. It cannot `chown` `.claude.json` at startup. (Verified in `entrypoint-orchestrator.sh:11-22`.)
- On macOS Docker Desktop, bind-mounted host files are uid-remapped to the container user, so the `bind` mode's lack of chown has worked for years; the new `volume` mode inherits the same property.
- On Linux hosts, the first user is conventionally uid 1000, so the default no-chown path Just Works for most local developers; the warning is informational only for that audience.
- `<scaffoldDir>` is writable by the process running the scaffolder (already true: `launch` writes `docker-compose.yml` there, `deploy` writes to a tmp bundle dir).
- Existing callers passing `claudeConfigMode` are limited to `launch` (`bind`) and `deploy` (`volume`); no third-party callers depend on the broken named-volume behavior.

## Out of Scope

- Migrating already-scaffolded `volume`-mode clusters that have the broken `claude-config:/home/node/.claude.json` mount on disk. Users hit the same boot error today; if they re-run `generacy launch`/`deploy` (which re-scaffolds), they pick up the fix. No data migration is needed because the broken cluster never successfully wrote anything to the named volume.
- Changing the cluster image to chown `.claude.json` from a privileged entrypoint stage. The image is fixed-uid and entrypoint sudoers is intentionally narrow; expanding it for this is out of scope.
- Touching the `bind`-mode path beyond verifying no regression. The default-mode emitted compose stays byte-identical.
- Removing the `claudeConfigMode` parameter entirely / collapsing the two modes. The split (host-shared vs per-cluster file) remains a meaningful product distinction.
- Cloud-side equivalent — generacy-cloud#782 already shipped the analogous fix in cloud-deploy. This issue is the in-tree mirror only.

---

*Generated by speckit*
