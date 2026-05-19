# Quickstart: Scoped Private-Registry Credentials

## Overview

When a Generacy cloud project is configured with a private container registry, `generacy launch` automatically authenticates during image pull without requiring manual `docker login`.

## User Experience

### With private registry (automatic)

```bash
npx generacy launch --claim=ABC123
# 1. Fetches launch config (includes registryCredentials)
# 2. Writes scoped Docker auth config
# 3. Pulls image using scoped credentials
# 4. Cleans up auth config
# 5. Starts cluster normally
```

No additional user action required — credentials are provided by the cloud.

### Without private registry (unchanged)

```bash
npx generacy launch --claim=XYZ789
# Pulls using ambient Docker auth (~/.docker/config.json)
# Exactly the same as before this feature
```

## Error Messages

### Invalid/expired credentials (401)

```
Failed to pull cluster image ghcr.io/org/image:tag:
  Registry authentication failed.
  The credentials configured in your Generacy project may be expired.
  Update them in the Generacy dashboard, or run `docker login ghcr.io` to use local auth.
```

### Image not found (404)

```
Failed to pull cluster image ghcr.io/org/image:tag:
  Image not found: ghcr.io/org/image:tag
  Verify the image name and tag in your project settings.
```

## Cloud Configuration

Project admins configure registry credentials in the Generacy dashboard. The cloud includes them in the `LaunchConfig` response:

```json
{
  "projectId": "...",
  "registryCredentials": {
    "url": "ghcr.io",
    "username": "robot-user",
    "password": "ghp_xxxxxxxxxxxx"
  }
}
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Pull fails with auth error | Cloud-configured creds expired | Update in Generacy dashboard |
| Pull fails with 404 | Wrong image name/tag | Check project settings |
| Pull works locally but not via launch | Ambient auth not in scope | Ensure cloud creds are configured |
| `.docker/` dir left behind | Process killed mid-pull | Safe to delete `<projectDir>/.docker/` manually |
