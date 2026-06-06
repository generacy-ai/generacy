# Research: #777 — credential-less JIT gh token provider

## Investigation summary

The spec is grounded in live evidence from the `ai-lawfirm` production cluster. The narrative is verified against the actual code in this repo (post-#773), reproduced here as research notes so future readers don't have to re-derive it.

## Code-side verification of the spec claims

### Claim 1: provider is gated on a `github-app` descriptor

Verified at `packages/orchestrator/src/server.ts:201–224`:
```ts
let githubAppCredentialId: string | undefined;
{
  const initialDescriptors = await readCredentialDescriptors(agencyDir);
  const ghapp = initialDescriptors.find((d) => d.type === 'github-app');
  githubAppCredentialId = ghapp?.credentialId;
  …
}

const githubTokenProvider = githubAppCredentialId
  ? createJitGithubTokenProvider({ … credentialId: githubAppCredentialId, … })
  : undefined;
```
On a wizard-bootstrapped cluster, `.agency/credentials.yaml` carries entries like `GH_TOKEN`/`GH_USERNAME`/`GH_EMAIL` with `type: 'github-pat'` (or similar), never `type: 'github-app'`. So `githubAppCredentialId` stays `undefined`, and `githubTokenProvider` is `undefined`.

### Claim 2: `gh` falls through to ambient `GH_TOKEN`

Verified at `packages/workflow-engine/src/actions/github/client/gh-cli.ts:67–80`:
```ts
private async resolveTokenEnv(): Promise<Record<string, string> | undefined> {
  if (!this.tokenProvider) return undefined;
  const token = await this.tokenProvider();
  return token ? { GH_TOKEN: token } : undefined;
}

private async executeGh(args: string[]) {
  const env = await this.resolveTokenEnv();
  const result = await executeCommand('gh', args, { cwd: this.workdir, env });
  …
}
```
When `env` is `undefined`, `executeCommand` does not override the spawn environment, so the `gh` subprocess inherits the orchestrator's `process.env.GH_TOKEN` — which is the static value seeded by `wizard-env-writer.ts` into `wizard-credentials.env` and sourced by `entrypoint-orchestrator.sh`. That value is a GitHub installation token with a 1-hour TTL.

### Claim 3: the credential-less path *works* end-to-end

Verified at `packages/control-plane/src/services/jit-git-token-client.ts:86–97`:
```ts
async fetch(credentialId?: string): Promise<JitGitTokenResponse> {
  const body = credentialId === undefined ? '{}' : JSON.stringify({ credentialId });
  …
}
```
The client already accepts an undefined `credentialId` and sends `'{}'`. The control-plane `POST /git-token` handler resolves the installation from the cluster identity (`cluster-api-key` Authorization header), not the request body — proven by the working `git-credential-generacy` path, which calls `client.fetch()` with no argument and successfully clones private repos.

### Claim 4: file-presence is the correct precondition

`/var/lib/generacy/cluster-api-key` is written by the orchestrator's activation flow (`packages/orchestrator/src/activation/persistence.ts`) on first boot and persisted to a tmpfs-backed volume across container restarts. Its presence is exactly the signal that the cluster is cloud-connected and can pull tokens. The control-plane's `ClusterApiKeyReader` (`packages/control-plane/src/services/cluster-api-key.ts`) reads it on every `/git-token` request, so anything past that read fails closed with `CLUSTER_API_KEY_MISSING` — the orchestrator never needs to validate the contents at startup.

## Decisions

### D1: gate on `clusterApiKeyExists()`, not socket probe or unconditional construction

**Chosen**: `fs.existsSync('/var/lib/generacy/cluster-api-key')` at orchestrator startup.

**Rationale**: matches the precondition the working git path implicitly relies on. A socket probe (`fs.existsSync('/run/generacy-control-plane/control.sock')`) is racy — the control-plane socket can bind *after* the orchestrator resolves credential descriptors (this is the same startup-race class #598 fixed for relay-bridge initialization). Unconditional construction breaks the truly-unconfigured case (a cluster with neither api-key nor descriptor) by turning every `gh` call into a thrown `JitTokenError`.

**Alternatives rejected**:
- *Always construct* — breaks unconfigured/offline clusters by making every `gh` call throw with no recovery. Cluster operators would need to either configure cloud or accept that `gh` doesn't work.
- *Probe the control-plane socket* — startup race risk; the socket may not be bound yet at descriptor-resolution time, and a single existsSync probe at boot cannot retry. Would reintroduce the same silent-fallback class we're fixing.
- *Synthesize a `github-app` descriptor for wizard clusters* — large surface change, requires touching `wizard-env-writer.ts` and `.agency/credentials.yaml` write path; doesn't match the architectural invariant ("the control-plane resolves installation from cluster identity, not descriptor id").

### D2: `'__wizard__'` sentinel for cache + authHealth keys

**Chosen**: literal string `'__wizard__'`, exported as `WIZARD_SENTINEL_KEY` from `jit-github-token-provider.ts`.

**Rationale**: self-documenting in logs and relay events; can never collide with real descriptor ids (which are GitHub installation/credential identifiers, not strings starting with `__`); zero cost to recognize-and-ignore if a future cloud consumer wants to filter synthetic ids.

**Alternatives rejected**:
- `'default'` — acceptable per Q1, but reads like it could be a real fallback value rather than an explicit sentinel. Higher cognitive load in logs.
- Derived from `clusterId` — introduces variability, requires reading `cluster.json` at provider-construction time, and risks leaking cluster identity into relay events whose existing payloads don't carry it.

### D3: defense-in-depth `GH_TOKEN` env override

**Chosen**: when `this.tokenProvider` is set, `resolveTokenEnv` always returns an env object with the `GH_TOKEN` key (= token, or `''` if a token is missing for any reason). Today's `return token ? { GH_TOKEN: token } : undefined` is the silent-fallback bug structurally embedded into the success path: an empty string token would degrade to ambient. Setting `GH_TOKEN: ''` produces a loud `gh` auth failure rather than a delayed 401 from the wrong token.

**Rationale**: structural — once any caller has injected a provider, ambient inheritance is wrong by construction. Belt-and-braces on top of the JitTokenError throw-and-skip behavior.

### D4: worker-mode provider built in-process at worker startup

**Chosen**: the worker process constructs its own `createJitGithubTokenProvider` via the same code path in `server.ts` (which already runs in both modes). Independent in-process cache.

**Rationale**: cross-process sharing is structurally impossible — the provider is a closure over a `Map`. The current code in `server.ts:201–224` already runs in both `isWorkerMode` and orchestrator mode, so changing the gating condition there fixes both. No separate worker-side construction site exists.

## Implementation patterns referenced

- **#598 deferred-binding pattern**: precedent for the api-key probe gating approach — gate on a stable on-disk signal (file presence) rather than a dynamic runtime signal (socket connect).
- **#762 GhAuthError + AuthHealthSink**: precedent for fail-loud telemetry around `gh` auth failures. The existing `catch (GhAuthError)` branches in `LabelMonitorService.pollRepo` and `PrFeedbackMonitorService.pollRepo` are the same loop boundaries that will catch `JitTokenError`.
- **#766 git-credential-generacy**: precedent for the credential-less control-plane path. Already proven on the git side; #777 extends the same precedent to the gh side.

## Key sources / references

- `packages/orchestrator/src/server.ts:201–224` — the bug site.
- `packages/orchestrator/src/services/jit-github-token-provider.ts:14–97` — function to modify.
- `packages/control-plane/src/services/jit-git-token-client.ts:86–166` — credential-less branch (already present).
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:67–80` — env override site.
- `packages/control-plane/src/services/cluster-api-key.ts:4` — api-key path constant.
- `packages/orchestrator/src/services/credential-expiry-watcher.ts:164–175` — `readCredentialDescriptors` (unchanged).
- `packages/orchestrator/src/services/github-auth-health.ts:73–162` — `recordResult`/`maybeRequestRefresh` (unchanged; receives sentinel key when no descriptor).
- [CLAUDE.md "Cluster-side JIT Git Credential Helper (#766)"](../../CLAUDE.md) — architectural context for the credential-less path.
- [CLAUDE.md "Cluster-Side GH_TOKEN Expiry Detection and Refresh Backstop (#762)"](../../CLAUDE.md) — context for `AuthHealthSink` and the relay event flow.
