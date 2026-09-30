# Inbox Codex Marketplace

Private marketplace `inbox-local` for the Inbox team. The catalog lives in
`.agents/plugins/marketplace.json`; plugin paths are relative to this repository
root.

## Plugins

| Plugin | Version | Purpose |
| --- | --- | --- |
| `jira-local` | `0.2.3` | Read Jira tickets, download attachments, and sign in through a local browser window. |

The Jira plugin includes its compiled MCP server and native credential-storage
libraries for Windows x64 / ARM64, macOS Intel / Apple Silicon, and Linux
x64 / ARM64 with glibc. Installation does not require npm or a build.

## Connect this marketplace in Codex

Your GitLab account must have read access to this repository. In Codex, use
**Add a marketplace** with:

```text
https://git.co.inbox.lv/nikolay/codex-marketplace.git
```

Then install **jira-local** from **Inbox — Local Plugins** (`inbox-local`).
The equivalent CLI commands are:

```sh
codex plugin marketplace add https://git.co.inbox.lv/nikolay/codex-marketplace.git
codex plugin add jira-local@inbox-local
```

Until the initial merge request is merged into `master`, select the prepared
branch explicitly:

```sh
codex plugin marketplace add https://git.co.inbox.lv/nikolay/codex-marketplace.git --ref setup-codex-marketplace
codex plugin add jira-local@inbox-local
```

If the CLI is not on PATH, ask Codex to locate the CLI bundled with its desktop
app and run these commands. The local MCP process must resolve Node.js 22 or
newer. Use the desktop runtime when available.

Restart Codex or open a new chat, then ask **“Show my Jira tickets”**. Enter your
own Jira credentials only in the browser sign-in window. Each employee's session
is stored in their operating system credential store.

You need access to `https://jira.co.inbox.lv`, including VPN access when required.
See [the Jira plugin README](plugins/jira-local/README.md) for tool details and
authentication behavior.

## Company workspace

This GitLab marketplace can be connected directly to local Codex clients.
The documented **Admin → Plugins → Import marketplace** workflow currently
accepts GitHub repositories only. To use that workspace import, mirror this
repository to a private GitHub repository and import the mirror as a workspace
administrator. Plugins declaring `.mcp.json` are marked **Desktop only**.

Workspace policies govern employee access; importing a marketplace does not
connect employees to Jira or share the administrator's Jira session.

References:

- [Package plugins and configure local marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Workspace marketplace import and sync](https://learn.chatgpt.com/docs/enterprise/plugin-management)

## Maintain the Jira plugin

The repository includes the source, pinned dependency lockfile, tests, and the
ready-to-run `plugins/jira-local/dist/` directory. Runtime files are deliberately
tracked so users can install the plugin without building it.

```sh
cd plugins/jira-local
npm ci --ignore-scripts
npm test
npm run build
```

Building requires Node.js 22+, `tar`, and access to the npm registry. The build
verifies SHA-512 integrity for native packages and refreshes `dist/`; it also
creates an untracked local marketplace distribution under `releases/`.

When changing runtime behavior, update the plugin, npm package, and MCP server
versions together, run the tests, rebuild, and commit the refreshed `dist/`.
Keep passwords, cookies, `.env`, and downloaded attachments outside the repository.
