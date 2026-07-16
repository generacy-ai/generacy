# Contract: Persisted smee channel file

**Path**: `/var/lib/generacy/smee-channel` (overridable via `config.smee.channelFilePath`)
**Feature**: #952

## Filesystem contract

| Property | Value |
|----------|-------|
| Path | `/var/lib/generacy/smee-channel` |
| Owner | `node` user (uid 1000 in cluster-base container) |
| Group | `node` (gid 1000) |
| Mode | `0600` (read + write by owner only) |
| Filesystem | Bind-mounted host volume `/var/lib/generacy` (see cluster-base compose) |
| Sibling files | `cluster-api-key`, `cluster.json`, `master.key`, `credentials.dat`, `credentials.dat.lock` |

## Content format

- Plain text, UTF-8.
- Exactly one URL.
- No trailing newline written by the resolver. Trailing newline tolerated on read (defensively `.trim()`ed).
- URL grammar: `https://smee.io/<id>` where `<id>` matches `[A-Za-z0-9_-]+`.
- Validation regex: `^https:\/\/smee\.io\/[A-Za-z0-9_-]+$` (`SMEE_URL_PATTERN` in `smee-channel-resolver.ts`).

**Example content** (single line, no trailing newline):

```
https://smee.io/mNhnxyK56d9qkZo
```

**Byte-level example**:

```
0000000: 6874 7470 733a 2f2f 736d 6565 2e69 6f2f  https://smee.io/
0000010: 6d4e 686e 7879 4b35 3664 3971 6b5a 6f    mNhnxyK56d9qkZo
```

Length: exactly the length of the URL string, no more.

## Write contract

1. `mkdir(dirname(path), { recursive: true })` — no-op if the directory exists; defensive against first-boot edge cases.
2. `writeFile(path + '.tmp', url, { mode: 0o600 })` — mode set at creation.
3. `rename(path + '.tmp', path)` — atomic on POSIX within a filesystem. Both tmp and target live in `/var/lib/generacy/`, so guaranteed same filesystem.
4. No `fsync()`. Justification: on power-loss corruption, tier 2's regex validation (Q3→A) triggers re-provisioning on next boot; the correctness backstop makes `fsync()` unnecessary for this specific file. (Contrast with `credentials.dat`, which is load-bearing across restarts and uses `fsync()`.)

## Read contract

1. `readFile(path, 'utf-8')` → string.
2. `.trim()` the string. (Defense against a hand-edit adding a trailing newline.)
3. `SMEE_URL_PATTERN.test(trimmed)` → boolean.
4. If pass → use the trimmed string as the channel URL.
5. If fail → log warn L3 with truncated preview, treat as absent, proceed to tier 3.

**Read failure modes**:

| errno | Handling |
|-------|----------|
| ENOENT | Silent fall-through to tier 3. Expected on first boot. |
| EACCES | Log warn (defensively), fall through to tier 3. Not expected — the file is owned by the process user. |
| EIO | Log warn, fall through to tier 3. Not expected — disk-level failure. |
| EISDIR | Log warn, fall through to tier 3. Not expected — indicates something replaced the file with a directory. |
| Any other | Log warn, fall through to tier 3. |

## Validation contract

The regex `^https:\/\/smee\.io\/[A-Za-z0-9_-]+$` intentionally rejects:

- `http://smee.io/...` — non-HTTPS. Smee-io only serves over HTTPS; an HTTP URL indicates corruption.
- `https://smee.io/` — missing ID.
- `https://smee.io/abc/def` — extra path segments. Real IDs are single-segment.
- `https://smee.io/abc?q=1` — query strings. Real URLs have none.
- `https://smee.io/abc#f` — fragments. Real URLs have none.
- `https://smee.io:8080/abc` — non-default port.
- `https://smee.example.com/abc` — wrong host.
- `https://smee.io/abc.def` — dots in the ID. Real IDs are `[A-Za-z0-9_-]` only.
- `https://smee.io/abc def` — whitespace in the ID.
- Anything containing newlines, `<`, `>`, tabs, control characters.

Rejection is deliberately narrow. Anything that doesn't match this regex went through some corruption path (torn write, hand-edit, log line accidentally redirected here), and re-provisioning is safer than accepting.

## Migration contract

There is no migration. Existing clusters:

- With env-set `SMEE_CHANNEL_URL` (`tetrad-development` on `https://smee.io/mNhnxyK56d9qkZo`): tier 1 wins forever. File is never created, never read.
- Without env-set URL (`snappoll` and every fresh cluster): file is created on the next boot after this feature ships. Boots that occurred before this feature was deployed had no file; boot 1 after deploy provisions and writes; boot 2+ reads.
- With a hand-created file at this path (unlikely, but possible if someone anticipated this feature): tier 2 reads it. If valid, used as-is. If invalid, re-provisioned and overwritten.

## Rollback contract

Reverting the feature (deleting `smee-channel-resolver.ts` and the `server.ts` changes) leaves the file on disk. It becomes an inert orphan — no code path reads it or writes it. Safe to ignore or delete; ignoring costs nothing.

If the feature is later re-shipped, the existing file is picked up on next boot at tier 2 (assuming it still matches `SMEE_URL_PATTERN`).

## Concurrency contract

Single-writer assumption. One orchestrator per cluster (compose file spawns 1 container). If a second orchestrator is ever launched with the same volume, both call `POST /new`, both get different channels, and one write overwrites the other's file. The last write wins; the other's channel is orphaned on smee.io + orphaned as a GitHub webhook.

Guard: not implemented in v1 (out of scope). Future guard would use `flock` on `${path}.lock` following the `credentials.dat.lock` pattern.

## Security contract

- Mode `0600` prevents other users on the host from reading the channel URL. Smee channel URLs are unauthenticated capability URLs — anyone holding one can read the webhook event stream and inject forged payloads. Same threat model as `credentials.dat`, same mode.
- The URL is never logged at `debug` or `trace` from unvalidated sources. Tier 2 logs the URL at `info` only AFTER regex validation. Tier 3 logs the URL at `info` only AFTER regex validation of the Location header. Tier-2 malformed content is logged with `contentPreview` truncated to 64 chars.
- The URL is never written to `.generacy/config.yaml` (committed to project repo).
- The URL IS written to log lines that may be shipped to the cloud via relay. This is acceptable: the cluster-relay already ships operational logs, and the URL is the same URL the cloud UI needs to know about anyway.
