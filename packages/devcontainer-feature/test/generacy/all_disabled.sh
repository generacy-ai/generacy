#!/bin/sh
set -e

# Test: installAgency=false, installClaudeCode=false
# Generacy and GitHub CLI should be present; Claude Code and Agency should NOT.

node --version
gh --version
generacy --version

# Verify claude is NOT installed
if command -v claude > /dev/null 2>&1; then
    echo "FAIL: claude should not be installed when installClaudeCode=false"
    exit 1
fi

# Verify agency is NOT installed
if command -v agency > /dev/null 2>&1; then
    echo "FAIL: agency should not be installed when installAgency=false"
    exit 1
fi

echo "all_disabled test passed."
