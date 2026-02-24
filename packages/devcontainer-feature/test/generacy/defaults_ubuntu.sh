#!/bin/sh
set -e

# Test: defaults on Ubuntu base image — all tools should be installed.

node --version
gh --version
claude --version
generacy --version
agency --version

echo "defaults_ubuntu test passed."
