#!/bin/sh
set -e

# ============================================================================
# Generacy Dev Container Feature — Install Script
# Installs Node.js, GitHub CLI, Claude Code, @generacy-ai/generacy, and
# @generacy-ai/agency into any Debian/Ubuntu-based dev container.
# ============================================================================

# --- Step 1: Resolve non-root username ---
USERNAME="${_REMOTE_USER:-""}"
if [ -z "$USERNAME" ] || [ "$USERNAME" = "root" ]; then
    USERNAME=$(awk -F: '$3 >= 1000 && $3 < 65534 { print $1; exit }' /etc/passwd)
fi
if [ -z "$USERNAME" ]; then
    USERNAME=root
fi
echo "Using username: $USERNAME"

# --- Step 2: Install Node.js (if not present) ---
if ! command -v node > /dev/null 2>&1; then
    echo "Node.js not found — installing v${NODEVERSION}..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODEVERSION}.x" | bash -
    apt-get install -y nodejs
else
    echo "Node.js already installed: $(node --version)"
fi

# --- Step 3: Install GitHub CLI (if not present) ---
if ! command -v gh > /dev/null 2>&1; then
    echo "GitHub CLI not found — installing..."
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    apt-get update
    apt-get install -y gh
else
    echo "GitHub CLI already installed: $(gh --version | head -1)"
fi

# --- Step 4: Install Claude Code (if enabled) ---
if [ "$INSTALLCLAUDECODE" = "true" ]; then
    echo "Installing Claude Code..."
    npm install -g @anthropic-ai/claude-code
else
    echo "Skipping Claude Code (installClaudeCode=false)"
fi

# --- Step 5: Install @generacy-ai/generacy ---
echo "Installing @generacy-ai/generacy@${VERSION}..."
npm install -g "@generacy-ai/generacy@${VERSION}"

# --- Step 6: Install @generacy-ai/agency (if enabled) ---
if [ "$INSTALLAGENCY" = "true" ]; then
    echo "Installing @generacy-ai/agency@${AGENCYVERSION}..."
    npm install -g "@generacy-ai/agency@${AGENCYVERSION}"
else
    echo "Skipping Agency (installAgency=false)"
fi

# --- Step 7: Verify installations ---
echo "Verifying installations..."
node --version
gh --version
generacy --version
if [ "$INSTALLCLAUDECODE" = "true" ]; then
    claude --version
fi
if [ "$INSTALLAGENCY" = "true" ]; then
    agency --version
fi
echo "Generacy dev container feature installed successfully."
