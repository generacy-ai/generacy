---
"@generacy-ai/generacy": patch
---

Fix docker-compose scaffolding for `claudeConfigMode: 'volume'` (deploy/cloud). Previously a named volume was mounted onto the `/home/node/.claude.json` file path, which Docker rejects with "is not a directory". The scaffolder now writes a `claude.json` file next to the compose file and binds it (`./claude.json:/home/node/.claude.json`), chowning it to `1000:1000` (best-effort). `deploy` likewise ensures `claude.json` exists on the remote VM owned by `1000:1000` before `compose up`.
