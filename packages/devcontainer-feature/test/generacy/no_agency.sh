#!/bin/sh
set -e

# Test: installAgency=false
# All tools except Agency should be installed.

node --version
gh --version
claude --version
generacy --version

# Verify agency is NOT installed
if command -v agency > /dev/null 2>&1; then
    echo "FAIL: agency should not be installed when installAgency=false"
    exit 1
fi

echo "no_agency test passed."
