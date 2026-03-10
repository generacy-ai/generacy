---
sidebar_position: 2
---

# Installation

This page covers installing the Generacy CLI, Docker Desktop, and the VS Code extension. Make sure you've reviewed the [Prerequisites](./prerequisites.md) first.

## Install the Generacy CLI

Install the CLI globally with npm:

```bash
npm install -g @generacy-ai/generacy
```

Verify the installation:

```bash
generacy --version
```

You should see a version number printed (e.g., `1.x.x`). If you get `command not found`, see the [troubleshooting guide](./troubleshooting.md#generacy-command-not-found).

## Install Docker Desktop

Docker is **optional for Level 1** (Agency Only) but **required for Level 2+** adoption levels.

1. Download Docker Desktop from [docker.com](https://www.docker.com/products/docker-desktop/)
2. Follow the installer for your operating system
3. Start Docker Desktop and verify it's running:

```bash
docker --version
```

:::tip
On Linux, you can use Docker Engine instead of Docker Desktop. See the [Docker Engine install docs](https://docs.docker.com/engine/install/) for instructions.
:::

## Install VS Code and the Generacy Extension

VS Code is the recommended editor for working with Generacy. If you don't already have it installed, download it from [code.visualstudio.com](https://code.visualstudio.com/).

To install the Generacy extension:

1. Open VS Code
2. Open the Extensions panel (**Ctrl+Shift+X** / **Cmd+Shift+X**)
3. Search for **Generacy**
4. Click **Install** on the Generacy extension

<!-- Screenshot placeholder: VS Code extension install -->

The extension provides project-aware tooling and integrates with the Generacy CLI for a streamlined development experience.

## Alternative Installation Methods

<details>
<summary>Install with pnpm</summary>

```bash
pnpm add -g @generacy-ai/generacy
```

Verify:

```bash
generacy --version
```

</details>

<details>
<summary>Install from source</summary>

For development or contributing to Generacy:

```bash
git clone https://github.com/generacy-ai/generacy.git
cd generacy
pnpm install
pnpm build
```

Then link the CLI globally:

```bash
cd packages/generacy
pnpm link --global
```

Verify:

```bash
generacy --version
```

</details>

## Next Steps

With the CLI installed, proceed to [Authentication](./authentication.md) to set up your GitHub and Anthropic credentials.
