# Jira for Codex

A local plugin for Jira Server 7.2.3. Codex starts the MCP server in the background.
You do not need to install Python, npm or a separate Jira application.
The plugin uses Node.js bundled with the current Codex desktop app. MCP libraries
and native components for system credential storage are included in the package.

## Install from the team marketplace

Follow the [marketplace installation instructions](../../README.md) to register
`https://git.co.inbox.lv/nikolay/codex-marketplace.git`, then install
`jira-local@inbox-local`. The compiled server and native libraries are committed
in this repository, so users do not need to run npm or build the plugin.

## Installing from an offline distribution

**This ZIP is a local marketplace distribution. Do not use “Upload plugin
archive” / “Add plugin” for it.** That dialog uploads a package to the hosted
plugin service; it does not install the bundled Node.js server on your computer.
This integration must run locally so it can open the sign-in window and use your
operating system's credential storage. Repacking it as a single plugin ZIP does
not turn it into a hosted integration.

1. Extract `jira-local-codex.zip` into a permanent folder on your computer.
   On Windows, for example, use `C:\CodexPlugins\jira-local-codex`. Choose the
   extracted folder containing `START-HERE.md`, `.agents` and `plugins`.
2. Open that folder as a project in Codex and send this message:

   **“Install the local Jira plugin from this folder. Register this folder as a
   local plugin marketplace and install jira-local from inbox-local. Keep other
   integrations unchanged. If a separate Jira MCP server is already connected,
   disable it after verifying the plugin so its tools are not duplicated.”**

3. Restart Codex or open a new chat after installation.
4. Say **“Show my Jira tickets”**. A sign-in window will open in your browser if
   needed. Enter **your own** Jira username and password only in that window.
5. When you see “Jira connected”, return to Codex and say **“I signed in to Jira”**.

Codex runs the installation commands; you do not need to open a terminal.
You need the Codex desktop app and access to `https://jira.co.inbox.lv`
(including a VPN if your network requires one).

### Windows installation details

If the Plugins menu offers **Add a marketplace**, choose the extracted folder
containing `.agents/plugins/marketplace.json`, then install **jira-local** from
**inbox-local**. Otherwise, use the project and installation message above.

The equivalent commands are shown below for Codex to run. If `codex` is not on
PATH, ask Codex to locate its bundled CLI; installing a separate CLI is not
required for this route.

```powershell
codex plugin marketplace add 'C:\CodexPlugins\jira-local-codex'
codex plugin add jira-local@inbox-local
```

The MCP configuration uses `node`. Codex should verify that its local MCP
process can resolve Node.js 22 or newer, using the desktop runtime if available.
An installation failure and a later “node not found” startup failure are
different problems. Keep the extracted marketplace folder available for future
refreshes.

If **Upload plugin archive** shows **“Couldn't add plugin. Try again.”**, follow
the local marketplace steps above. The distribution contains a marketplace
root, with the plugin manifest under
`plugins/jira-local/.codex-plugin/plugin.json`; a hosted single-plugin upload
expects a different root layout and cannot use this local server as a registered
remote MCP connection.

The sign-in form opens again when your session expires. You can also say
**“Sign in to Jira”** to reopen it using the `jira_login` tool.

## Tools

- `jira_list_my_tickets`: list your unresolved tickets, filter by priority,
  group by project and paginate results.
- `jira_get_issue`: return the full Jira response JSON, including all fields
  and properties. Additional representations are available through `expand`,
  for example `changelog,names,schema`. Pagination within the response is
  preserved exactly as Jira returns it.
- `jira_get_attachment`: download an attachment by ID into the system temporary
  folder and return its full metadata JSON, absolute path, size and SHA-256.
  The default limit is 50 MiB; `max_size_mb` accepts values from 1 to 500.
- `jira_whoami`: check authentication and the current account.
- `jira_login`: open the local sign-in form without sending a password through chat.

## Authentication

The form listens only on `127.0.0.1` on a random port. It closes after 10 minutes
without a successful sign-in, or 30 seconds after success. Its URL contains a
random token; requests with other Origin or Host values are rejected. The password
is sent to Jira over HTTPS. The plugin does not save it or include it in process
arguments, logs, MCP responses or the distribution archive.

Only the Jira session (`JSESSIONID`) and username are saved: in Keychain on macOS
and Credential Manager on Windows. Storage is associated with the operating
system user and Jira URL. The plugin does not create a password or cookie file
if system credential storage is unavailable. Each user signs in independently.

The package includes native components for macOS Apple Silicon / Intel,
Windows x64 / ARM64, and Linux x64 / ARM64 with glibc and a working Secret Service.
Running natively on Windows requires neither WSL nor Python. Under WSL, the
plugin uses Linux credential storage instead of Windows Credential Manager.

Attachments are streamed to disk; the session is sent only to the same HTTPS
origin as Jira. Incomplete files are removed on failure. Downloaded files remain
in the temporary folder until you delete them or the operating system cleans it
up. They are not executed automatically.

## Development

Source files are in `src/`; the bundled server is `dist/server.cjs`.
The plugin contains no skill, so the agent does not need to read additional
instructions. The previous Python MCP server and `jira-my-tickets` skill
remain separate and are not deleted.

```sh
npm ci --ignore-scripts
npm test
npm run build
codex plugin marketplace add /absolute/path/to/jira-local-codex
codex plugin add jira-local@inbox-local
```

The build pins library versions, verifies the SHA-512 integrity of native
packages from npm, and creates `releases/jira-local-codex` without `.env`,
sessions, `.venv`, tests or build dependencies. Validation messages are bundled
in English only. Building requires `tar`.
