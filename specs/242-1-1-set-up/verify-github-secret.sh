#!/bin/bash
set -euo pipefail

# T003 Verification Script: Check GitHub Organization Secret Configuration
# This script verifies that NPM_TOKEN is properly configured as an organization secret

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

ORG="generacy-ai"
REPOS=("latency" "agency" "generacy")
SECRET_NAME="NPM_TOKEN"

echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  T003: Verify GitHub Organization Secret Configuration        ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo ""

# Check if gh CLI is available
if ! command -v gh &> /dev/null; then
    echo -e "${RED}✗ GitHub CLI (gh) is not installed${NC}"
    echo -e "${YELLOW}  Install it from: https://cli.github.com${NC}"
    exit 1
fi

# Check if authenticated
if ! gh auth status &> /dev/null; then
    echo -e "${RED}✗ Not authenticated with GitHub CLI${NC}"
    echo -e "${YELLOW}  Run: gh auth login${NC}"
    exit 1
fi

echo -e "${GREEN}✓ GitHub CLI is installed and authenticated${NC}"
echo ""

# Function to check if secret exists in organization
check_org_secret() {
    echo -e "${BLUE}Checking organization-level secret...${NC}"

    # Try to list organization secrets
    if gh api "orgs/${ORG}/actions/secrets" --jq '.secrets[] | select(.name=="'${SECRET_NAME}'")' 2>/dev/null | grep -q "name"; then
        echo -e "${GREEN}✓ Organization secret '${SECRET_NAME}' exists${NC}"

        # Get secret details
        gh api "orgs/${ORG}/actions/secrets/${SECRET_NAME}" --jq '{
            name: .name,
            created_at: .created_at,
            updated_at: .updated_at,
            visibility: .visibility
        }' 2>/dev/null | while IFS= read -r line; do
            echo -e "${BLUE}  $line${NC}"
        done

        return 0
    else
        echo -e "${RED}✗ Organization secret '${SECRET_NAME}' not found${NC}"
        echo -e "${YELLOW}  Please complete the manual setup steps in T003-github-org-secret-setup.md${NC}"
        return 1
    fi
}

# Function to check if secret is available to a repository
check_repo_access() {
    local repo=$1
    echo -e "${BLUE}Checking ${repo} repository access...${NC}"

    # List repository secrets (includes org secrets available to the repo)
    if gh api "repos/${ORG}/${repo}/actions/secrets" --jq '.secrets[] | select(.name=="'${SECRET_NAME}'")' 2>/dev/null | grep -q "name"; then
        echo -e "${GREEN}✓ Secret '${SECRET_NAME}' is available to ${repo}${NC}"
        return 0
    else
        echo -e "${RED}✗ Secret '${SECRET_NAME}' is NOT available to ${repo}${NC}"
        echo -e "${YELLOW}  Check repository access settings for the organization secret${NC}"
        return 1
    fi
}

# Main verification flow
main() {
    local all_checks_passed=true

    # Check organization secret
    if ! check_org_secret; then
        all_checks_passed=false
    fi
    echo ""

    # Check each repository
    for repo in "${REPOS[@]}"; do
        if ! check_repo_access "$repo"; then
            all_checks_passed=false
        fi
        echo ""
    done

    # Summary
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    if [ "$all_checks_passed" = true ]; then
        echo -e "${GREEN}✓ All checks passed!${NC}"
        echo -e "${GREEN}  NPM_TOKEN is properly configured for all repositories${NC}"
        echo ""
        echo -e "${BLUE}Next steps:${NC}"
        echo -e "  → T004: Configure changesets in each repository"
        echo -e "  → T005: Implement GitHub Actions workflows"
        return 0
    else
        echo -e "${RED}✗ Some checks failed${NC}"
        echo -e "${YELLOW}  Please review the manual setup guide: T003-github-org-secret-setup.md${NC}"
        echo -e "${YELLOW}  URL: https://github.com/organizations/${ORG}/settings/secrets/actions${NC}"
        return 1
    fi
}

# Run main function
main
