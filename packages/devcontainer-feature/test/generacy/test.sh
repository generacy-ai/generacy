#!/bin/sh
set -e

# Default scenario test — verifies all tools are installed with default options.

# Verify Node.js
node --version

# Verify GitHub CLI
gh --version

# Verify Claude Code
claude --version

# Verify Generacy
generacy --version

# Verify Agency
agency --version

echo "All default tests passed."
