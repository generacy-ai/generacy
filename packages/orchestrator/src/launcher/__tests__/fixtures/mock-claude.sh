#!/bin/sh
# Mock claude binary for spawn-e2e tests.
# Writes argv and selected env vars to $MOCK_CLAUDE_CAPTURE_FILE,
# then emits $MOCK_CLAUDE_RESPONSE_FILE contents (or a default JSON line) to stdout.

# Write argv section
{
  echo "=== ARGV ==="
  for arg in "$@"; do
    echo "$arg"
  done

  # Write env section — only vars the tests care about
  echo "=== ENV ==="
  env | sort
} > "$MOCK_CLAUDE_CAPTURE_FILE"

# Emit response
if [ -n "$MOCK_CLAUDE_RESPONSE_FILE" ] && [ -f "$MOCK_CLAUDE_RESPONSE_FILE" ]; then
  cat "$MOCK_CLAUDE_RESPONSE_FILE"
else
  echo '{"type":"result","subtype":"success"}'
fi

exit 0
