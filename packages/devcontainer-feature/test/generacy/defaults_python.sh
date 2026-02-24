#!/bin/sh
set -e

# Test: defaults on Python 3.12 base image — all tools should be installed.

node --version
gh --version
claude --version
generacy --version
agency --version

echo "defaults_python test passed."
