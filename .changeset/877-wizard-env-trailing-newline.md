---
"@generacy-ai/control-plane": patch
---

Terminate `wizard-credentials.env` with a trailing newline.

`formatEnvFile()` joined entries with `\n` but omitted a final newline, so any
later append (by an operator, a script, or a future writer) concatenated onto
the last key/value pair — corrupting the existing key and silently dropping the
appended one. The writer now ends the file with `\n`, matching the POSIX
convention that entrypoints rely on when sourcing the file.
