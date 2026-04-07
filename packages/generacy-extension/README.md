# Generacy - Workflow Development IDE

Generacy is a comprehensive workflow development IDE for Visual Studio Code that provides local development capabilities and cloud orchestration management.

## Features

### Local Mode (FREE)

#### 🗂️ Workflow Explorer
- Tree view of workflow files (`.generacy/*.yaml`)
- Create, rename, and delete workflows
- Template library with starter workflows

#### ✏️ Workflow Editor
- YAML-first editing with IntelliSense
- Schema validation with real-time diagnostics
- Phase and step visualization
- Variable and secret reference support

#### ▶️ Workflow Runner
- Execute workflows locally
- Real-time output streaming
- Environment variable configuration
- Dry-run mode for validation

#### 🐛 Workflow Debugger
- **Step-through execution** with breakpoints
- **State inspection** (variables, context, outputs)
- **Replay** from specific steps
- Error analysis and recovery

### Cloud Mode (Paid)

#### 🏢 Organization Dashboard
- Connected organization overview
- Member management
- Usage and billing summary

#### 📋 Workflow Queue
- View active, pending, and completed workflows
- Priority management
- Cancel and retry actions
- Filter by assignee, status, and repository

#### 🔌 Integration Management
- GitHub App connection status
- Issue tracker connections
- CI/CD integrations
- Webhook configuration

#### ☁️ Publishing
- **Develop → Debug → Publish** pattern
- Push local workflows to cloud
- Version management and rollback capability

## Getting Started

1. **Install the extension** from the VS Code Marketplace
2. **Open a project** with workflow files in `.generacy/` directory
3. **Explore workflows** in the Generacy tree view
4. **Start developing** with IntelliSense and validation

### Authentication (Optional)

Sign in with your GitHub account to unlock cloud features:
- Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
- Type "Generacy: Sign In"
- Follow the authentication flow

## Requirements

- VS Code 1.108.0 or higher
- For cloud features: generacy.ai account (free tier available)

## Extension Settings

This extension contributes the following settings:

* `generacy.workflowDirectory`: Specify the workflow directory (default: `.generacy`)
* `generacy.defaultTemplate`: Default workflow template to use
* `generacy.cloudEndpoint`: Cloud API endpoint (default: `https://api.generacy.ai`)
* `generacy.telemetry.enabled`: Enable anonymous usage telemetry (default: `false`)

## Known Issues

This is an initial release. Please report issues at: https://github.com/generacy-ai/generacy/issues

## Release Notes

### 0.1.0 (Initial Release)

- ✅ Local workflow development with explorer, editor, runner, and debugger
- ✅ Cloud mode with organization dashboard, queue, and publishing
- ✅ GitHub OAuth authentication
- ✅ Full Debug Adapter Protocol support
- ✅ YAML IntelliSense with schema validation

---

## Pricing

**Local Mode**: FREE (with generacy.ai account)

**Cloud Mode** (Organization):
| Tier | Price | Features |
|------|-------|----------|
| Free | $0 (1 seat) | 1 concurrent agent, GitHub only |
| Basic | $20/seat/mo | 2 concurrent agents, GitHub, Cloud UI |
| Standard | $50/seat/mo | 5 concurrent agents, all integrations, SSO |
| Professional | $100/seat/mo | 10 concurrent agents, all integrations, SSO |
| Enterprise | Custom | Unlimited, compliance, SLA |

---

**Enjoy developing with Generacy!**

For more information:
- 🌐 Website: https://generacy.ai
- 📖 Documentation: https://docs.generacy.ai
- 💬 Support: https://github.com/generacy-ai/generacy/discussions
