# Contract: `SmeeChannelResolver` — workspace-mirror write (FR-001, FR-008)

**Module**: `packages/orchestrator/src/services/smee-channel-resolver.ts`

## Extension summary

`SmeeChannelResolver` gains an optional `workspaceMirrorPath` in its
options. When set, the resolver mirror-writes the resolved channel URL to
that path (mode `0644`, bare-URL content) alongside the existing atomic
write to the cluster-internal `channelFilePath` (mode `0600`).

## Public API (extended)

```ts
export interface SmeeChannelResolverOptions {
  channelFilePath: string;
  presetUrl?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  workspaceMirrorPath?: string;             // NEW
}
```

`resolve()` return shape unchanged.

## Write behavior

The resolver writes to the workspace mirror on two paths:

### 1. Tier-3 provisioning (net-new URL)

After `writePersistedFile(url)` succeeds (existing atomic tmp+rename to
`channelFilePath`, mode `0600`), call the new `mirrorToWorkspace(url)`
best-effort:
- `mkdir(dirname(workspaceMirrorPath), { recursive: true })`
- Atomic tmp + rename write with mode `0644`, bare-URL content.
- Failure → **one** `logger.warn({ path, err.code, err.message },
  'Workspace mirror write failed — operator sessions may fall back to
  polling')`.
- Never throws; never causes `resolve()` to return `null`.

### 2. Tier-2 persisted-read hit

When `readPersistedFile()` returns a URL and the mirror path is set, guard
the mirror write on **"file missing or content differs"**:
- `readFile(workspaceMirrorPath)` — if it succeeds and equals the persisted
  URL, do nothing (avoid inode churn on every restart).
- Otherwise, mirror-write as above.
- `ENOENT` on the mirror-read → write.
- Any other mirror-read error → attempt the write; failure logs one warn.

### 3. Tier-1 preset (env / yaml)

Same as tier-2: `readFile(workspaceMirrorPath)` guard, then mirror-write if
missing or differs.

## Mode and content

- **Mode**: `0644` (Q5=B). Rationale: reader may run under a different uid
  than writer (operator devcontainer/tunnel vs. orchestrator container).
- **Content**: bare URL, no trailing newline (symmetric with cluster-
  internal). Reader trims whitespace anyway.
- **Atomicity**: tmp + rename, same as `channelFilePath`.

## Guarantees

- **Cluster-internal write is the source of truth.** Mirror-write failures
  never affect the resolver's return value or the orchestrator's
  `startSmeePipeline` decision.
- **Idempotent across restarts.** Repeated `resolve()` calls do not re-write
  the mirror unless the URL has changed.
- **No new failure modes for orchestrator boot.** All mirror-write errors
  are caught and logged.
- **Disabled when path is unset.** When `workspaceMirrorPath` is
  `undefined` or empty string, the mirror path is a no-op — behavior is
  identical to today's shipped resolver.

## Config wiring

`SmeeConfigSchema` in `packages/orchestrator/src/config/schema.ts` gains:

```ts
workspaceMirrorPath: z
  .string()
  .default('/workspaces/.generacy/cockpit/smee-channel');
```

`loader.ts` allows override via env `SMEE_WORKSPACE_MIRROR_PATH`.
Explicitly-empty override (`SMEE_WORKSPACE_MIRROR_PATH=""`) disables the
mirror.

`server.ts` (existing `SmeeChannelResolver` construction at line ~573)
passes `workspaceMirrorPath: config.smee.workspaceMirrorPath`.

## Test scaffolding

Additions to `packages/orchestrator/src/services/__tests__/
smee-channel-resolver.test.ts`:

1. Tier-3 provisioning success + mirror write success → mirror file exists
   with mode 0644 and bare URL.
2. Tier-3 provisioning success + cluster-internal write success + mirror
   write EACCES → resolver returns `{ channelUrl, source: 'provisioned' }`;
   one warn log emitted; mirror file absent.
3. Tier-2 persisted-read hit + mirror missing → mirror written.
4. Tier-2 persisted-read hit + mirror already matches → no write (assert
   `writeFile` not called for mirror path).
5. Tier-2 persisted-read hit + mirror differs → mirror re-written.
6. `workspaceMirrorPath: undefined` → no mirror write attempted; behavior
   identical to today.

## Deferred / out of scope

- Metadata content (JSON with `{ url, writtenAt, clusterId }`). Q5=B
  explicitly rejects this for the initial fix; the reader's tolerance for
  JSON is not required.
- Preflight of the workspace volume writability at server boot (see
  `research.md` Q5).
