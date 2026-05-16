# Clarifications for #632 — App-Config Secrets Env Renderer

## Batch 1 — 2026-05-16

### Q1: Secret-to-Nonsecret Transition
**Context**: The spec covers `PUT` with `secret: true` (FR-003) and `DELETE` for secrets (FR-004), but doesn't address what happens when a user re-PUTs an existing secret env var with `secret: false` — transitioning from encrypted to plaintext storage. This edge case affects the route handler logic and determines whether secrets.env removal must be coordinated with plaintext env writes.
**Question**: When a user changes an env var from secret to non-secret (re-PUT with `secret: false`), should the system move the value from the encrypted backend to the plaintext env file and remove it from `secrets.env`?
**Options**:
- A: Move the value automatically (delete from backend, write to plaintext env file, remove from secrets.env)
- B: Reject the transition — require explicit DELETE + re-PUT with the new secret flag
- C: Out of scope for this issue — preserve current PUT behavior (overwrite regardless of prior secret flag)

**Answer**: A — move automatically, generalized to handle both directions of the secret-flag transition.** The PUT handler should look up the existing entry in `values.yaml.env[name].secret`, detect any flag mismatch, and clean up the prior storage location before writing to the new one. Both transitions matter, not just secret→non-secret:

| Prior state | New `secret` | Action |
|---|---|---|
| absent | `true` | write to backend, render to `secrets.env` (current behavior) |
| absent | `false` | write to plaintext env file (current behavior) |
| `secret: true` | `false` | write to plaintext env file; **delete from backend; remove from secrets.env** |
| `secret: false` | `true` | write to backend; render to secrets.env; **remove from plaintext env file** |
| same flag | same flag | overwrite in current location (current behavior) |

Serialize the multi-step transitions under the same advisory lock `AppConfigEnvStore` already uses for the plaintext env file, so a concurrent reader doesn't observe an in-between state where the value lives in neither location. Order matters: write the new location first, then delete from the old location, then last update the `values.yaml.env[name].secret` flag — that way any reader that has already read the metadata still finds the value at the expected location.

Rejecting C: the current overwrite-only PUT plus a flag flip would leave the old encrypted entry (or old plaintext entry) lingering with no cleanup path other than DELETE, accumulating stale state on every flag flip. Rejecting B: forcing explicit DELETE+PUT for a UI toggle is bad UX with no security upside — the user is already authenticated and authorized to do both halves; making them do it manually just adds steps.

### Q2: Directory Creation on Missing Tmpfs Mount
**Context**: The spec assumes `/run/generacy-app-config/` exists as a tmpfs mount provided by companion cluster-base issue (#38). If this PR ships before the companion, the directory won't exist. This affects deployment ordering and whether the feature can be tested/deployed independently.
**Question**: If `/run/generacy-app-config/` doesn't exist at daemon startup, should the secrets renderer create the directory itself or enter a degraded state?
**Options**:
- A: Create the directory with `mkdir -p` as a fallback (works without companion, but may land on persistent storage instead of tmpfs)
- B: Follow the AppConfigEnvStore fallback pattern (try preferred path, then `/tmp/generacy-app-config/` fallback, then disabled mode)
- C: Log a warning and skip secrets rendering entirely (strict dependency on companion issue)

**Answer**: B — fallback chain matching the `AppConfigEnvStore` pattern from generacy-ai/generacy#624.** Try in order:

1. **`/run/generacy-app-config/secrets.env`** (preferred) — generacy-ai/cluster-base#38 provides the tmpfs mount. Use this when available.
2. **`/tmp/generacy-app-config/secrets.env`** (fallback) — `/tmp` is often tmpfs on Linux distros but the daemon cannot assume. Log a WARN-level message: "secrets file falling back to /tmp — may not be tmpfs on this container runtime; secrets could persist to disk."
3. **Disabled mode** — secret PUTs still accept and store the value in the encrypted backend (data isn't lost), but `secrets.env` is never rendered. The `GET /values` endpoint still reports the secret entries with `secret: true`. PUT and GET return success; consumers (entrypoint scripts sourcing the file, user services) simply won't see the env var. The disabled state must be surfaced via the `initResult` / relay metadata structure from #624 (e.g. `stores.appConfigSecretEnv: 'ok' | 'fallback' | 'disabled'`) so the cloud UI can display "Secret env rendering disabled — file path unwritable."

Rejecting A: `mkdir -p /run/generacy-app-config` succeeds on a Docker container where `/run` isn't itself tmpfs (which is the default in many base images), silently writing plaintext secrets to the container's writable overlay layer. That's a security regression for clusters that haven't picked up cluster-base#38 yet — fail-safe over fail-open.

Rejecting C: silent skip would leave users wondering why their secrets aren't reaching processes despite seeing the values in the UI. The fallback chain + structured init result gives operators visibility into why the feature is degraded.
