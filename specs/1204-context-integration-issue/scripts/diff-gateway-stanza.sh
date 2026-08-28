#!/bin/sh
# diff-gateway-stanza.sh — four-way reconciliation of the `llm-gateway` compose stanza
# (FR-005 / SC-004). Canon is the tetrad dev compose; each of the other three sources is
# diffed against it. Trivial helper (Q1): extraction + diff + a canon-traits check. It does
# not classify hunks — the operator does that in results.md § stanzaDiff.
#
# Sources (override any via env var; each points at a rendered docker-compose*.yml):
#   CANON            tetrad dev compose (canon)      docker-compose.yml:180-218
#   SCAFFOLDER       scaffolder output (post-#1202)  a freshly scaffolded cluster's compose
#   CLUSTER_BASE     cluster-base compose (post-#90)
#   CLOUD_DEPLOY     cloud-deploy compose template (post-#919)
#
# Usage:
#   specs/1204-context-integration-issue/scripts/diff-gateway-stanza.sh
#   CANON=/path/compose.yml SCAFFOLDER=/path/.generacy/docker-compose.yml ... diff-gateway-stanza.sh
#
# Exit status: 0 if every present source matches canon; 1 if any diff or missing canon.

set -eu

CANON="${CANON:-/workspaces/tetrad-development/.devcontainer/generacy/docker-compose.yml}"
SCAFFOLDER="${SCAFFOLDER:-}"
CLUSTER_BASE="${CLUSTER_BASE:-}"
CLOUD_DEPLOY="${CLOUD_DEPLOY:-}"

# Extract the `llm-gateway:` service block from a compose file: from the line matching
# `^  llm-gateway:` up to (but not including) the next same-indent `^  \S` key or a
# top-level `^\S` key (networks:/volumes:). Emits nothing if the stanza is absent.
extract_stanza() {
  file="$1"
  [ -f "$file" ] || return 0
  awk '
    /^  llm-gateway:[ \t]*$/ { grab=1; print; next }
    grab && /^  [^ \t]/      { grab=0 }   # next 2-space service key
    grab && /^[^ \t]/        { grab=0 }   # top-level key (networks:/volumes:)
    grab { print }
  ' "$file"
}

# Canonical traits from research.md D3 — assert each appears in the canon stanza and, when a
# source is present, in that source. Reported per source; informational (does not set exit).
check_traits() {
  label="$1"
  # Strip comment lines (`^  # …`) so a trait mentioned only in prose does not count as
  # present, and the documented-but-unset `source_of_truth` note is not a false positive.
  code="$(printf '%s\n' "$2" | grep -v '^[[:space:]]*#')"
  printf '  traits:'
  # Positive traits that MUST be present.
  for t in \
    'maximhq/bifrost:v2.0.0' \
    'llm-gateway-data:/app/data' \
    'config.json:/app/data/config.json:ro' \
    '.env.local' \
    'start_period: 45s'
  do
    if printf '%s\n' "$code" | grep -qF "$t"; then :; else printf ' MISSING[%s]' "$t"; fi
  done
  # Negative trait that MUST be absent (v2.0.0 crash-loop hazard, D3).
  if printf '%s\n' "$code" | grep -qF 'source_of_truth'; then
    printf ' FORBIDDEN[source_of_truth set]'
  fi
  # No published host port on the gateway (management UI shares 8080).
  if printf '%s\n' "$code" | grep -Eq '^[[:space:]]*ports:'; then
    printf ' NOTE[host port published — canon has none]'
  fi
  printf ' ok\n'
}

CANON_STANZA="$(extract_stanza "$CANON")"
if [ -z "$CANON_STANZA" ]; then
  printf 'FATAL: canon stanza not found in %s\n' "$CANON" >&2
  exit 1
fi

printf '== canon: %s ==\n' "$CANON"
check_traits canon "$CANON_STANZA"

rc=0
tmp_canon="$(mktemp)"
printf '%s\n' "$CANON_STANZA" > "$tmp_canon"
trap 'rm -f "$tmp_canon"' EXIT

diff_source() {
  label="$1"; file="$2"
  printf '\n== %s: %s ==\n' "$label" "${file:-<unset>}"
  if [ -z "$file" ]; then
    printf '  SKIP: %s not set (source unavailable — e.g. contract still open)\n' "$label"
    return 0
  fi
  if [ ! -f "$file" ]; then
    printf '  SKIP: %s not found at %s\n' "$label" "$file"
    return 0
  fi
  stanza="$(extract_stanza "$file")"
  if [ -z "$stanza" ]; then
    printf '  DIVERGENCE: no llm-gateway stanza present in %s\n' "$file"
    rc=1
    return 0
  fi
  check_traits "$label" "$stanza"
  tmp_src="$(mktemp)"
  printf '%s\n' "$stanza" > "$tmp_src"
  if diff -u "$tmp_canon" "$tmp_src" > /dev/null 2>&1; then
    printf '  MATCH: identical to canon\n'
  else
    printf '  DIVERGENCE (unified diff, canon left / %s right):\n' "$label"
    diff -u "$tmp_canon" "$tmp_src" | sed 's/^/    /' || true
    rc=1
  fi
  rm -f "$tmp_src"
}

diff_source scaffolder   "$SCAFFOLDER"
diff_source cluster-base "$CLUSTER_BASE"
diff_source cloud-deploy "$CLOUD_DEPLOY"

printf '\n== summary ==\n'
if [ "$rc" -eq 0 ]; then
  printf 'All present sources match canon. Classify any SKIP in results.md.\n'
else
  printf 'Divergences found. Classify each hunk in results.md: intentional | fixed-here | filed.\n'
fi
exit "$rc"
