# Quickstart: `wizard-credentials.env` trailing newline fix

## Prerequisites

- Node.js >= 22
- `pnpm` installed
- Working copy on branch `877-found-during-cockpit-v1`

## Verifying the Bug (Before the Fix)

```bash
# Reproduce in a Node REPL against the pre-fix source:
node -e '
  const entries = [{key:"GH_EMAIL", value:"a@example.com"}];
  const joined = entries.map(e => `${e.key}=${e.value}`).join("\n");
  console.log(JSON.stringify(joined + "CLUSTER_ACTING_LOGIN=generacy-ai"));
'
# => "GH_EMAIL=a@example.comCLUSTER_ACTING_LOGIN=generacy-ai"
#     ^-- corruption pattern from the sniplink incident
```

## Applying the Fix

Single change in `packages/control-plane/src/services/wizard-env-writer.ts`:

```diff
 export function formatEnvFile(entries: EnvEntry[]): string {
   if (entries.length === 0) return '';
-  return entries.map((e) => `${e.key}=${e.value}`).join('\n');
+  return entries.map((e) => `${e.key}=${e.value}`).join('\n') + '\n';
 }
```

## Running the Tests

Targeted:

```bash
pnpm --filter @generacy-ai/control-plane test wizard-env-writer
```

Full control-plane suite (SC-002):

```bash
pnpm --filter @generacy-ai/control-plane test
```

Expected: all green, including three assertions on `formatEnvFile`:

1. Empty array → `''`.
2. Non-empty array → ends with `\n`.
3. Written file + naive `>>` append parses to distinct keys.

## Manual Validation (Optional)

On a live cluster (or a scratch directory):

```bash
# 1. Simulate the writer's output post-fix:
printf 'GH_TOKEN=xxx\nGH_USERNAME=alice\nGH_EMAIL=alice@users.noreply.github.com\n' > /tmp/wc.env

# 2. Naive append (the scenario that used to corrupt the file):
echo 'CLUSTER_ACTING_LOGIN=generacy-ai' >> /tmp/wc.env

# 3. Source and inspect:
set -a; source /tmp/wc.env; set +a
echo "GH_EMAIL=$GH_EMAIL"
echo "CLUSTER_ACTING_LOGIN=$CLUSTER_ACTING_LOGIN"
```

Expected output post-fix:

```
GH_EMAIL=alice@users.noreply.github.com
CLUSTER_ACTING_LOGIN=generacy-ai
```

Pre-fix, `GH_EMAIL` would be `alice@users.noreply.github.comCLUSTER_ACTING_LOGIN=generacy-ai` and `CLUSTER_ACTING_LOGIN` would be unset.

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `formatEnvFile` test fails with `expected 'K=v\n' to be 'K=v'` | Test assertion not updated after applying the fix. | Update `wizard-env-writer.test.ts:372` to expect `'KEY1=val1\nKEY2=val2\n'`. |
| Naive-append test still fails | `fs.appendFile` mistakenly given the pre-fix output (missing newline). | Ensure the test writes via `writeWizardEnvFile()` (which uses the fixed `formatEnvFile`), then appends. |
| File-mode test regressed | Someone changed `writeWizardEnvFile()` beyond the scope of this fix. | Revert non-scope changes; only `formatEnvFile()` and the tests should be touched (FR-003). |
| Empty-credentials path now writes `'\n'` instead of `''` | Empty-branch return statement was also changed. | Only touch the non-empty branch — FR-002 permits either, but we preserve `''` for diff minimality. |

## Rollback

Revert the one-line change in `formatEnvFile()`. No migrations, no persisted-state cleanup — the file is regenerated on every `bootstrap-complete` lifecycle action.
