# Clarifications

## Batch 1 — 2026-06-02

### Q1: Approach for the `volume`-mode fix
**Context**: The spec's Open Questions #1 explicitly defers the fundamental approach. This choice drives every other decision (whether to emit a bind mount, whether to declare a top-level volume, whether to create a file). FR-002 lists two acceptable variants but doesn't pick one. Implementation cannot start until this is settled.
**Question**: Which approach should the `volume` branch of `scaffoldDockerCompose` take?
**Options**:
- A: Bind a scaffolder-created blank `claude.json` file (per-cluster persistence; mirrors generacy-cloud#782 intent — recommended in the spec). The top-level `claude-config:` named-volume declaration goes away.
- B: Drop the mount entirely in `volume` mode (`.claude.json` ephemeral; lives inside the container layer, lost on container recreation). No file or volume created.
- C: Collapse `volume` mode to behave identically to `bind` mode (both mount `~/.claude.json`). Loses per-cluster isolation but is the smallest change.

**Answer**: **A** — bind a scaffolder-created blank `claude.json` file; drop the top-level `claude-config:` named-volume declaration. Matches generacy-cloud#782 and the canonical cluster-base devcontainer, which binds `.claude.json` as a file and only ever uses a named volume for the `.claude` directory. B (ephemeral) loses the Claude session on every container recreation; C (collapse to `~/.claude.json`) throws away per-cluster isolation and just reproduces `bind` mode.

### Q2: Bind path for the scaffolder-created file (if Approach A)
**Context**: For the `deploy` SSH-to-VM flow, the scaffolder writes to a temp dir on the developer's laptop, then the bundle is SCP'd to a remote VM where `docker compose up` runs. A host-absolute bind path (e.g., `/opt/generacy/claude.json` as used in generacy-cloud#782) is wrong for `generacy launch` (which is local) and isn't portable across hosts. The mount path encoded in the emitted compose has to resolve correctly *on whichever host runs `docker compose up`*.
**Question**: What path should the emitted compose use for the host side of the bind mount?
**Options**:
- A: Compose-relative — `./claude.json:/home/node/.claude.json` (file lives next to `docker-compose.yml` in `.generacy/`; ports naturally through SCP; same encoding for `launch` and `deploy`).
- B: Tilde-expanded `~/.claude.json:/home/node/.claude.json` (identical to current `bind` mode — see Q1 option C; means `volume` mode shares host-user config).
- C: Configurable via a new `ScaffoldComposeInput` field (caller decides, e.g., `deploy` could pass `/opt/generacy/claude.json` like the cloud fix). Recommend against, but listed for completeness.

**Answer**: **A** — compose-relative `./claude.json:/home/node/.claude.json`. The file sits next to `docker-compose.yml` in `.generacy/`, so the same encoding works for local `launch` and for `deploy` (the bundle dir is SCP'd wholesale, so a relative path resolves on the VM too). An absolute path like `/opt/generacy/claude.json` is only correct because cloud-init controls that path; it's wrong for `launch`. C (new config field) is unnecessary surface for a value that's deterministic.

### Q3: File ownership / uid 1000 handling (Open Question #2 from the spec)
**Context**: The cluster image's `node` user is uid 1000. The scaffolder runs on the *host* (any uid — developer's laptop for `launch`, possibly root or any user on the VM after SCP for `deploy`). If the host-side file is owned by, say, uid 501, the container's uid 1000 process may not be able to write to it, breaking Claude's session-token persistence. generacy-cloud#782 chose `install -o 1000 -g 1000` in a runcmd, which works because cloud-init runs as root. The scaffolder usually does not run as root.
**Question**: How should the scaffolder handle ownership of the created `claude.json`?
**Options**:
- A: Best-effort `chown 1000:1000`; on `EPERM` (non-root host), log a warning and continue with host uid (`.claude.json` may end up read-only from the container's perspective, but mount won't fail).
- B: Don't `chown` at all; document the limitation. Rely on the cluster-image entrypoint to chown at startup (cluster-base entrypoints already run as root before dropping to uid 1000 — confirm and exploit).
- C: Emit `user: "${UID:-1000}:${GID:-1000}"` on `orchestrator`/`worker` so the container runs as the host's uid (changes container runtime behavior — likely breaks other code that assumes uid 1000).
- D: Create file with `chmod 0666` (world-writable) — sidesteps ownership but is a poor security posture for a token file.

**Answer**: **A** — best-effort `chown 1000:1000`; on `EPERM` log a warning and continue. ⚠️ **B is not viable**: the cluster image's orchestrator/worker run as `node` (uid 1000) — `USER node` in the Dockerfile and explicit `user: node` on services in the canonical compose — and the entrypoint's only sudoers privilege is a narrow `chmod 666` on the docker socket. The entrypoint cannot chown `.claude.json`. A matches today's `bind` mode (which also relies on the host file being usable by uid 1000 — true for Linux first-user and macOS Docker Desktop bind remapping). C (run container as host uid) breaks pervasive uid-1000 assumptions (credhelper uid 1002, tmpfs `uid=1000`, `/var/lib/generacy` owned by `node`); D (0666) is a poor posture for a token file. Where the scaffolder can chown (root/CI), A gets it right; where it can't, it degrades to current `bind`-mode behavior.

### Q4: Idempotency on re-scaffold
**Context**: `scaffoldDockerCompose` can be invoked multiple times (e.g., `generacy launch` on the same dir, `generacy update`, or re-runs after a partial failure). The compose file is always overwritten (deterministic). The new `claude.json` is *not* a compose file — it may hold a real Claude session/token after first use. generacy-cloud#782 used `test -f ... || install ...` to preserve existing content. The scaffolder needs a policy.
**Question**: When the scaffolder runs and a `claude.json` already exists at the target path, what should it do?
**Options**:
- A: Skip if exists (mirror cloud-init's `test -f || install` — preserve any existing Claude session). Safest default.
- B: Always overwrite with empty `{}` (deterministic scaffolder semantics; loses any saved session — users would have to re-`claude /login`).
- C: Skip if exists *and* non-empty; recreate if empty/zero-byte (handles partial-failure repair without clobbering real sessions).
- D: Out of scope for the scaffolder — caller (`launch`/`deploy`) decides; scaffolder only emits compose lines.

**Answer**: **A** — skip if exists. Mirrors #782's `test -f … || install …`. After first `claude /login` the file holds a real session/token; overwriting it (B) would force re-login on every re-scaffold/`update`. A zero-byte file from a partial failure is still a valid empty bind target, so C's "recreate if empty" buys little over A. Never clobber an existing file.

### Q5: Who creates the file in the `deploy` SSH flow?
**Context**: For `generacy launch` (local), the scaffolder writing to `<projectDir>/.generacy/claude.json` is straightforward — the file is already on the host that will run `docker compose up`. For `generacy deploy ssh://...`, the scaffolder runs locally and writes to a temp dir; `remote-compose.ts` then SCPs the bundle to the VM. The file must exist on the VM at the path the compose bind references *before* `docker compose up`. Two natural placements have different implications.
**Question**: For the `deploy` SSH-to-VM flow, where should `claude.json` get created?
**Options**:
- A: Scaffolder writes `claude.json` into the bundle dir; SCP carries it along (no remote-compose.ts changes needed). Requires the bind path to be compose-relative (ties to Q2 option A).
- B: Scaffolder declares the bind only; `remote-compose.ts` runs `sshExec(target, 'test -f ... || install -o 1000 ...')` before `docker compose pull`. Mirrors the cloud-init runcmd pattern; isolates ownership concerns to a root-capable code path.
- C: Both — scaffolder writes a blank file (works for `launch`); `remote-compose.ts` additionally re-`install`s on the remote with correct ownership (defense in depth, slight redundancy).

**Answer**: **C** — scaffolder writes `claude.json` into the bundle (required for both flows: `launch` runs `docker compose up` locally; for `deploy` it rides along the SCP), AND `remote-compose.ts` runs an idempotent ownership-fix SSH command before `docker compose up`. SCP lands the file owned by the deploy SSH user, which on many targets (e.g. `root@`) is not uid 1000, and per Q3 the container can't self-correct. Suggested form (around the existing `docker compose pull`/`up` calls at `remote-compose.ts:35,53`):

```
sshExec(target, `test -f "${remotePath}/claude.json" || install -o 1000 -g 1000 -m 0600 /dev/null "${remotePath}/claude.json"; chown 1000:1000 "${remotePath}/claude.json" 2>/dev/null || true`)
```

The `|| true` keeps it best-effort when the SSH user lacks privilege — same graceful-degradation philosophy as Q3.
