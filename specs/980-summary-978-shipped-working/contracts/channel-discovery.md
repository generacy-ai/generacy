# Contract: `channel-discovery.ts` — extended lookup chain (FR-002)

**Module**: `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts`

**Public API** (extended, backwards-compatible):

```ts
export async function discoverChannelUrl(
  input: ChannelDiscoveryInput,
): Promise<ChannelDiscoveryResult | null>;
```

## Inputs

See `data-model.md` for `ChannelDiscoveryInput`. Key new fields:

- `cwd?: string` — starting directory for walk-up scan (default
  `process.cwd()`).
- `workspaceMirrorPath?: string` — absolute-path fallback (default
  `/workspaces/.generacy/cockpit/smee-channel`).

Callers may pass only the existing fields; new fields fall back to their
defaults so `#978`'s call-site (`doorbell.ts:342`) needs no code change
beyond continuing to pass `channelFilePath` and `fs` as today.

## Lookup order

The function returns on the first stage that yields a URL matching
`SMEE_URL_PATTERN` (`/^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`).

1. **`env[COCKPIT_DOORBELL_SMEE_URL]`** — if present and non-empty:
   - Matches → `{ url, source: 'env' }`.
   - Non-matching → warn line (unchanged), continue.
2. **Walk-up scan** — starting at `cwd`, iterate ancestor directories toward
   the filesystem root:
   - For each ancestor `d`, attempt to read
     `<d>/.generacy/cockpit/smee-channel`.
   - `ENOENT` → advance to the next ancestor.
   - Non-`ENOENT` read error → warn one line, advance to the next ancestor
     (do not abort the walk).
   - Content matches `SMEE_URL_PATTERN` → return
     `{ url, source: 'workspace-walkup' }`.
   - Malformed content → warn one line, advance.
   - Terminate at `path.parse(cwd).root`.
3. **Absolute `workspaceMirrorPath`** — attempt to read the file at the
   configured absolute path (default `/workspaces/.generacy/cockpit/
   smee-channel`).
   - `ENOENT` → continue.
   - Non-`ENOENT` read error → warn one line, continue.
   - Content matches → `{ url, source: 'workspace-absolute' }`.
   - Malformed → warn line, continue.
4. **Cluster-internal `channelFilePath`** — today's `/var/lib/generacy/
   smee-channel` fallback (behavior identical to `#978`).
   - Content matches → `{ url, source: 'file' }`.
   - Malformed → warn line, return `null`.
   - `ENOENT` → return `null`.

## Guarantees

- **Never throws.** All I/O errors and validation failures fold into
  either a next-stage attempt (`ENOENT` / warn) or a `null` return.
- **Idempotent.** Multiple invocations with the same input produce the same
  result (subject to filesystem state).
- **No `cwd` mutation.** The walk-up reads `path.dirname()` values without
  chdir'ing.
- **Bounded work.** Walk-up performs one `readFile` attempt per ancestor
  directory; typical operator cwd (`/workspaces/<repo>/…`) means at most
  ~5 hops before hitting the volume root.

## Error surface for logs

One warn line per stage error, formatted as:

- Env mismatch: `cockpit doorbell: COCKPIT_DOORBELL_SMEE_URL does not match
  smee URL pattern; falling through to channel file` (unchanged).
- Walk-up read error at `<dir>`: `cockpit doorbell: walk-up read failed at
  <dir>: <message>`.
- Absolute-path read error: `cockpit doorbell: failed to read workspace
  mirror at <path>: <message>`.
- Cluster-internal read error: `cockpit doorbell: failed to read channel
  file <path>: <message>` (unchanged).
- Content mismatch (any stage): `cockpit doorbell: channel content at
  <path> does not match smee URL pattern`.

## Test scaffolding

Vitest specs in `__tests__/channel-discovery.test.ts`:

1. Env override present + valid → `{ source: 'env' }` (existing).
2. Env override present + invalid → walks fallback chain.
3. Walk-up hit at `<cwd>/.generacy/cockpit/smee-channel` → `{ source:
   'workspace-walkup' }`.
4. Walk-up hit at `<cwd>/../.generacy/cockpit/smee-channel` → same.
5. No walk-up hits + absolute-path hit → `{ source: 'workspace-absolute' }`.
6. Neither walk-up nor absolute-path + cluster-internal hit → `{ source:
   'file' }`.
7. All four stages miss → `null`.
8. Walk-up file exists but content malformed → warn + falls through to
   absolute path (does not return early).
9. `EACCES` on absolute-path read → warn + falls through to
   cluster-internal.

## Deferred / out of scope

- Mid-run re-read (Q4=A). The function is called once at doorbell startup.
- Non-`smee.io` URLs. The regex is intentionally strict; extending it is
  out of scope.
