#!/bin/sh
set -e

# Test: defaults on TypeScript-Node base image.
# Node.js is already present in this image — install.sh should skip Node install.

node --version
gh --version
claude --version
generacy --version
agency --version

# Verify Node.js major version is 22 (pre-installed by the base image, not by install.sh)
NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" != "22" ]; then
    echo "FAIL: expected Node.js major version 22 (from base image), got $NODE_MAJOR"
    exit 1
fi

echo "defaults_typescript_node test passed."
