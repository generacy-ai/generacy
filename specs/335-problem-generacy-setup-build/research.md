# Research: Build phase environment detection

## Decision: Environment detection strategy

**Chosen**: Check existence of source repo directories (`/workspaces/agency`, `/workspaces/latency`)

**Rationale**: The presence of source repos on disk is the most reliable signal for distinguishing multi-repo development from external project usage. This is already the pattern used in the existing code (Phases 2 and 3 check `existsSync`), just not formalized as a concept.

**Alternatives considered**:
- **Environment variable** (e.g., `GENERACY_DEV_MODE`): More explicit, but adds configuration burden. External projects shouldn't need to set anything.
- **Check npm registry for installed packages**: Slower, requires network access, and the packages might be installed globally from the Docker image.
- **Config file flag**: Requires user action; the current approach is zero-config.

## Decision: Log level for expected skips

**Chosen**: Use `info` level for expected environment-based skips, reserve `warn` for unexpected failures.

**Rationale**: When an external project runs `generacy setup build`, skipping source builds is the expected happy path, not a warning condition. Using `warn` creates false alarm noise in CI/CD logs.

## Decision: setup-speckit.sh handling (FR-004)

**Chosen**: No changes needed — the script no longer exists.

**Rationale**: The `setup-speckit.sh` script was replaced by `packages/devcontainer-feature/src/generacy/install.sh`, which installs packages from npm (`npm install -g @generacy-ai/generacy` and `npm install -g @generacy-ai/agency`). The hardcoded `AGENCY_REPO_URL` clone fallback is gone. FR-004 is already satisfied.

## Implementation pattern

The fix follows the existing guard-and-return-early pattern already used in `buildAgency()` and `buildGeneracy()`. No new abstractions are introduced — just improved logging and a small helper function for environment detection.
