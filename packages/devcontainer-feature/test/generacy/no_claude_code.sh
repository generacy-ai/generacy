#!/bin/sh
set -e

# Test: installClaudeCode=false
# All tools except Claude Code should be installed.

node --version
gh --version
generacy --version
agency --version

# Verify claude is NOT installed
if command -v claude > /dev/null 2>&1; then
    echo "FAIL: claude should not be installed when installClaudeCode=false"
    exit 1
fi

echo "no_claude_code test passed."
