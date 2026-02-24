#!/bin/sh
set -e

# Test: nodeVersion="20"
# All tools should be installed, and Node.js major version should be 20.

node --version
gh --version
claude --version
generacy --version
agency --version

# Verify Node.js major version is 20
NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" != "20" ]; then
    echo "FAIL: expected Node.js major version 20, got $NODE_MAJOR"
    exit 1
fi

echo "node_20 test passed."
