import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { JiraError } from './client.mjs';

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function openBrowser(url) {
  const windows = process.platform === 'win32';
  const command = windows ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\rundll32.exe`
    : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  return new Promise(resolve => {
    const child = spawn(command, windows ? ['url.dll,FileProtocolHandler', url] : [url],
      { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
  });
}

function messageFor(error) {
  return ({ AUTH_REQUIRED: 'Could not sign in. Check your username and password.',
    CAPTCHA_REQUIRED: 'Jira requires a CAPTCHA. Sign in on the Jira website, then try again.',
    ACCESS_DENIED: 'Jira denied access for this account.',
    CONNECTION_ERROR: 'Could not connect to Jira. Check your network or VPN.',
    JIRA_TIMEOUT: 'Jira did not respond in time. Try again.',
    CREDENTIAL_STORE_ERROR: 'Could not save the session. Allow access to the system credential storage.',
    INVALID_ARGUMENT: 'Enter your username and password.' })[error?.code] || 'Could not complete sign-in. Try again.';
}

export class LoginWindow {
  constructor(client, { opener = openBrowser, lifetimeMs = 10 * 60_000 } = {}) {
    this.client = client; this.opener = opener; this.lifetimeMs = lifetimeMs;
  }

  async open({ reopen = false } = {}) {
    if (!this.server) {
      this.token = randomBytes(24).toString('hex'); this.nonce = randomBytes(24).toString('base64');
      this.user = null; this.busy = false;
      const server = createServer((request, response) => {
        this.handle(request, response).catch(() => { if (!response.headersSent) this.send(response, 500, this.page('Sign-in failed. Try again.')); else response.end(); });
      });
      server.requestTimeout = 35_000; server.headersTimeout = 10_000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      server.on('error', () => {});
      this.server = server;
      this.origin = `http://127.0.0.1:${server.address().port}`;
      this.url = `${this.origin}/${this.token}`;
      this.timer = setTimeout(() => { void this.close(); }, this.lifetimeMs); this.timer.unref();
      this.browserOpened = await this.opener(this.url).catch(() => false);
    } else if (reopen) this.browserOpened = await this.opener(this.url).catch(() => false);
    return { status: this.user ? 'connected' : 'login_required', browser_opened: this.browserOpened, login_url: this.url,
      message: this.user ? 'Jira is connected. You can retry your Jira request.'
        : 'Enter your Jira username and password in the local browser window, then tell Codex that login is complete. Never enter them in chat.' };
  }

  send(response, status, html) {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${this.nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` });
    response.end(html);
  }

  page(error = '') {
    const title = this.user ? 'Jira connected' : 'Sign in to Jira';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
      <style nonce="${this.nonce}">
      *{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:#172b4d;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}
      main{width:100%;max-width:440px;background:white;border-radius:20px;padding:36px;box-shadow:0 12px 50px #15285812}.brand{color:#0052cc;font-weight:700;letter-spacing:.02em}h1{font-size:28px;line-height:1.25;margin:22px 0 10px}p{color:#5e6c84;margin:0 0 24px}label{display:block;font-weight:600;margin:18px 0 7px}
      input{width:100%;font:inherit;border:1px solid #b3bac5;border-radius:8px;padding:12px}input:focus{outline:3px solid #deebff;border-color:#0052cc}button{width:100%;margin:24px 0 18px;border:0;border-radius:8px;padding:13px;background:#0052cc;color:white;font:inherit;font-weight:600;cursor:pointer}button:hover{background:#0747a6}.note{font-size:13px;margin:0}.error{background:#ffebe6;color:#ae2a19;padding:12px;border-radius:8px;margin:18px 0}.ok{background:#e3fcef;color:#006644;padding:15px;border-radius:8px;margin:24px 0}a{color:#0052cc}.server{overflow-wrap:anywhere;font-size:14px;margin-bottom:20px}
      </style></head><body><main><div class="brand">JIRA + CODEX</div><h1>${title}</h1>
      ${this.user ? `<div class="ok">Signed in as <strong>${escapeHtml(this.user.display_name || this.user.name)}</strong>.</div><p>Return to Codex and say: “I signed in to Jira”. You can close this window.</p>`
        : `<p>Sign in to your account so Codex can read your tickets and attachments.</p><div class="server">${escapeHtml(this.client.baseUrl)}</div>
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
        <form method="post" action="/${this.token}/login"><label for="username">Jira username</label><input id="username" name="username" autocomplete="username" maxlength="250" required autofocus>
        <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="2000" required><button type="submit">Sign in</button></form>
        <p class="note">The plugin does not save your password. Your session is stored in the system credential storage.</p>
        ${error ? `<p class="note"><a href="${escapeHtml(this.client.baseUrl)}/login.jsp" target="_blank" rel="noopener noreferrer">Open the Jira website</a></p>` : ''}`}
      </main></body></html>`;
  }

  async handle(request, response) {
    const url = new URL(request.url, this.origin);
    if (request.headers.host !== new URL(this.origin).host || url.origin !== this.origin) {
      this.send(response, 403, 'Forbidden'); return;
    }
    if (request.method === 'GET' && url.pathname === `/${this.token}`) { this.send(response, 200, this.page()); return; }
    if (request.method !== 'POST' || url.pathname !== `/${this.token}/login`) { this.send(response, 404, 'Not found'); return; }
    if (request.headers.origin !== this.origin || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      this.send(response, 403, 'Forbidden'); return;
    }
    if (this.busy || this.user) { this.send(response, 409, this.page('Sign-in is already in progress. Please wait.')); return; }
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8192) { this.send(response, 413, this.page('Sign-in details are too long.')); return; }
      chunks.push(chunk);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    this.busy = true;
    try {
      this.user = await this.client.login(form.get('username'), form.get('password'));
      this.send(response, 200, this.page());
      clearTimeout(this.timer); this.timer = setTimeout(() => { void this.close(); }, 30_000); this.timer.unref();
    } catch (error) { this.send(response, error instanceof JiraError ? 400 : 500, this.page(messageFor(error))); }
    finally { this.busy = false; form.delete('password'); }
  }

  async close() {
    clearTimeout(this.timer);
    const server = this.server; this.server = null;
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
