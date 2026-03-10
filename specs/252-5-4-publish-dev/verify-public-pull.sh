#!/bin/bash
set -euo pipefail

# T012: Verify public pull of preview artifact
# Run this script after T011 (GHCR package set to public).
#
# Prerequisites:
#   - Docker installed and running
#   - No GHCR authentication (tests anonymous/public pull)
#   - devcontainer CLI installed (npm install -g @devcontainers/cli)
#
# This script checks:
#   1. docker pull succeeds without authentication
#   2. devcontainer builds with the feature reference
#   3. All expected tools are available inside the container

FEATURE_REF="ghcr.io/generacy-ai/generacy/generacy:preview"
TMPDIR_BASE="${TMPDIR:-/tmp}"
TEST_DIR=""

cleanup() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}
trap cleanup EXIT

echo "=== T012: Verify public pull of preview artifact ==="
echo ""

# --------------------------------------------------------------------------
# Step 1: Pull the OCI artifact via docker (unauthenticated)
# --------------------------------------------------------------------------
echo "--- Step 1: Docker pull (public, no auth) ---"

# Remove any cached credentials for ghcr.io to ensure a truly public pull
if docker logout ghcr.io > /dev/null 2>&1; then
    echo "  Logged out of ghcr.io to test anonymous pull"
fi

if docker pull "$FEATURE_REF"; then
    echo "  PASS: docker pull succeeded (public access confirmed)"
else
    echo "  FAIL: docker pull failed"
    echo "  Ensure T011 is complete (GHCR package visibility set to public)"
    echo "  Settings: https://github.com/orgs/generacy-ai/packages/container/generacy%2Fgeneracy/settings"
    exit 1
fi
echo ""

# --------------------------------------------------------------------------
# Step 2: Build a devcontainer using the feature reference
# --------------------------------------------------------------------------
echo "--- Step 2: Build devcontainer with feature ---"

TEST_DIR=$(mktemp -d "${TMPDIR_BASE}/t012-verify-XXXXXX")

# Create a minimal devcontainer.json that references the preview feature
mkdir -p "$TEST_DIR/.devcontainer"
cat > "$TEST_DIR/.devcontainer/devcontainer.json" <<'DEVCONTAINER'
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:preview": {}
  }
}
DEVCONTAINER

echo "  Test workspace: $TEST_DIR"
echo "  devcontainer.json:"
cat "$TEST_DIR/.devcontainer/devcontainer.json" | sed 's/^/    /'
echo ""

if ! command -v devcontainer > /dev/null 2>&1; then
    echo "  SKIP: devcontainer CLI not installed"
    echo "  Install with: npm install -g @devcontainers/cli"
    echo "  Falling back to docker-only verification (Step 1 passed)"
    echo ""
    echo "=== T012: Partial pass (docker pull OK, devcontainer CLI not available) ==="
    exit 0
fi

echo "  Building devcontainer..."
if devcontainer build --workspace-folder "$TEST_DIR"; then
    echo "  PASS: devcontainer build succeeded"
else
    echo "  FAIL: devcontainer build failed"
    echo "  Check that install.sh runs correctly and all npm packages are published."
    exit 1
fi
echo ""

# --------------------------------------------------------------------------
# Step 3: Verify all tools are installed inside the container
# --------------------------------------------------------------------------
echo "--- Step 3: Verify tool installations ---"

VERIFY_SCRIPT='
set -e
echo "  node:     $(node --version)"
echo "  gh:       $(gh --version | head -1)"
echo "  claude:   $(claude --version)"
echo "  generacy: $(generacy --version)"
echo "  agency:   $(agency --version)"
echo "ALL_TOOLS_OK"
'

RESULT=$(devcontainer exec --workspace-folder "$TEST_DIR" bash -c "$VERIFY_SCRIPT" 2>&1) || true

echo "$RESULT" | sed 's/^/  /'

if echo "$RESULT" | grep -q "ALL_TOOLS_OK"; then
    echo ""
    echo "  PASS: All tools installed successfully"
else
    echo ""
    echo "  FAIL: One or more tools failed to install"
    echo "  Review the output above for errors."
    exit 1
fi

echo ""
echo "=== T012: All checks passed ==="
echo ""
echo "Summary:"
echo "  - Preview artifact is publicly pullable (no auth required)"
echo "  - Devcontainer builds successfully with the feature"
echo "  - All tools verified: node, gh, claude, generacy, agency"
echo ""
echo "The dev container feature is ready for use. Users can add:"
echo '  "features": { "ghcr.io/generacy-ai/generacy/generacy:preview": {} }'
echo "to their devcontainer.json to get the full Generacy development toolchain."
