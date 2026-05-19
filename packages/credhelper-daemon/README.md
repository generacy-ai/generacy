# @generacy-ai/credhelper-daemon

Runtime daemon for credential session management. HTTP-over-Unix-socket API for beginning and ending credential sessions.

## Backends

### `env` — Environment Variable Backend

Reads secrets directly from `process.env`. Useful for development and CI.

### `cluster-local` — Encrypted File Backend

Stores credentials in an AES-256-GCM encrypted file at `/var/lib/generacy/credentials.dat`. This is the default backend for v1.5 clusters.

- **Master key**: Auto-generated 32-byte key at `/var/lib/generacy/master.key` (mode 0600, uid 1002)
- **Encryption**: AES-256-GCM with per-credential random 12-byte IV and 16-byte auth tag
- **Persistence**: JSON envelope with version field; atomic writes via temp-file + fsync + rename
- **Concurrency**: fd-based advisory locking (no external dependencies)
- **Interface**: Implements `WritableBackendClient` (extends `BackendClient` with `setSecret`/`deleteSecret`)

#### Security Notes

- The master key file must be on a persistent volume. If the master key is lost, stored credentials are unrecoverable — delete both files and re-enter credentials via the bootstrap UI.
- Key rotation is not supported in v1.5. The recovery model is destroy-and-reenter.
- Master key file permissions (0600) are set on creation. Verify with `ls -la /var/lib/generacy/master.key`.
- No plaintext secrets appear in logs. Error messages reference credential key names only.
- The credential store fails closed on corrupt data — it will refuse to start rather than operate on bad data.

## Development

```bash
pnpm install
pnpm test        # Run tests
pnpm build       # Build TypeScript
```
