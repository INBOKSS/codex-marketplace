import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_BASE_URL = 'https://jira.co.inbox.lv';
export const LIST_FIELDS = 'summary,status,created,updated,priority';

export class JiraError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

export function baseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new JiraError('CONFIG_ERROR', 'Use an HTTPS Jira root URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new JiraError('CONFIG_ERROR', 'Use an HTTPS Jira root URL without credentials.');
  }
  return url.href.replace(/\/+$/, '');
}

function issueKey(value) {
  const key = typeof value === 'string' ? value.toUpperCase() : '';
  if (!/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(key)) throw new JiraError('INVALID_ARGUMENT', 'Use an issue key such as IMA-598.');
  return key;
}

function pageArguments(start, limit) {
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new JiraError('INVALID_ARGUMENT', 'start_at must be nonnegative; max_results must be between 1 and 100.');
  }
}

export function downloadUrl(value, root) {
  let url;
  try { url = new URL(value); } catch { throw new JiraError('INVALID_RESPONSE', 'Invalid attachment download URL.'); }
  if (url.protocol !== 'https:' || url.origin !== new URL(root).origin || url.username || url.password || url.hash) {
    throw new JiraError('INVALID_RESPONSE', 'Attachment URLs must use the configured Jira HTTPS origin.');
  }
  return url.href;
}

export function safeFilename(value) {
  let name = value.replaceAll('\\', '/').split('/').at(-1).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[ .]+|[ .]+$/g, '');
  name = Buffer.from(name).subarray(0, 180).toString('utf8').replace(/[ .]+$/g, '');
  if (!name) return 'attachment.bin';
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(name.split('.')[0].trimEnd())) name = `_${name}`;
  return name;
}

function normalizedIssue(item, root) {
  const fields = item.fields ?? {};
  return { key: item.key, summary: fields.summary ?? null, status: fields.status?.name ?? null,
    priority: fields.priority?.name ?? null, created: fields.created ?? null, updated: fields.updated ?? null,
    project: item.key.split('-')[0], url: `${root}/browse/${item.key}` };
}

export class JiraClient {
  constructor({ url = process.env.JIRA_BASE_URL || DEFAULT_BASE_URL, store, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl(url); this.store = store; this.fetch = fetchImpl; this.cookie = null;
  }

  setCookie(cookie) {
    if (typeof cookie !== 'string' || !/^[A-Za-z0-9._~!$&'()*+,=:@%\-]+$/.test(cookie)) {
      throw new JiraError('AUTH_REQUIRED', 'Sign in to Jira in the local login window.');
    }
    this.cookie = cookie;
  }

  async loadSession() {
    if (this.cookie) return;
    const cookie = process.env.JIRA_JSESSIONID || (await this.store.load())?.cookie;
    if (cookie) this.setCookie(cookie);
  }

  async response(url, { method = 'GET', json, cookie = this.cookie, accept = 'application/json' } = {}) {
    try {
      return await this.fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { Accept: accept, 'Accept-Encoding': 'identity', ...(cookie ? { Cookie: `JSESSIONID=${cookie}` } : {}),
          ...(json ? { 'Content-Type': 'application/json' } : {}) },
        ...(json ? { body: JSON.stringify(json) } : {}) });
    } catch (error) { throw this.networkError(error); }
  }

  networkError(error) {
    return ['TimeoutError', 'AbortError'].includes(error?.name)
      ? new JiraError('JIRA_TIMEOUT', 'Jira request timed out. Try again.')
      : new JiraError('CONNECTION_ERROR', 'Cannot reach Jira. Check your network, VPN and TLS certificate.');
  }

  checkResponse(response) {
    if (response.headers.get('X-Seraph-LoginReason')?.toUpperCase() === 'AUTHENTICATION_DENIED') {
      throw new JiraError('CAPTCHA_REQUIRED', 'Sign in on the Jira website to clear CAPTCHA, then try again.');
    }
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      throw new JiraError('AUTH_REQUIRED', 'Sign in to Jira in the local login window.');
    }
    if (response.status === 403) throw new JiraError('ACCESS_DENIED', 'This Jira account does not have permission.');
    if (response.status === 404) throw new JiraError('NOT_FOUND', 'Issue or attachment does not exist, or this account cannot view it.');
    if (response.status === 400) throw new JiraError('INVALID_REQUEST', 'Jira rejected the request. Check its arguments.');
    if (!response.ok) throw new JiraError('JIRA_ERROR', `Jira returned HTTP ${response.status}.`);
  }

  async request(path, { params, ...options } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    const response = await this.response(url.href, options);
    try { this.checkResponse(response); } catch (error) { await response.body?.cancel(); throw error; }
    let data;
    try { data = await response.json(); } catch { throw new JiraError('INVALID_RESPONSE', 'Jira returned an invalid JSON response.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new JiraError('INVALID_RESPONSE', 'Unexpected Jira response format.');
    return data;
  }

  async login(username, password) {
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
      throw new JiraError('INVALID_ARGUMENT', 'Enter your Jira username and password.');
    }
    const data = await this.request('/rest/auth/1/session', { method: 'POST', cookie: null,
      json: { username: username.trim(), password } });
    const cookie = data.session?.value;
    if (data.session?.name !== 'JSESSIONID' || typeof cookie !== 'string' || !/^[A-Za-z0-9._~!$&'()*+,=:@%\-]+$/.test(cookie)) {
      throw new JiraError('AUTH_REQUIRED', 'Jira did not return an authenticated session.');
    }
    const user = await this.request('/rest/api/2/myself', { cookie });
    if (!user.name) throw new JiraError('AUTH_REQUIRED', 'Jira did not confirm the account.');
    await this.store.save(cookie, user.name);
    this.setCookie(cookie);
    return { name: user.name, display_name: user.displayName ?? null, base_url: this.baseUrl };
  }

  async whoami() {
    await this.loadSession();
    if (!this.cookie) throw new JiraError('AUTH_REQUIRED', 'Sign in to Jira in the local login window.');
    let user;
    try { user = await this.request('/rest/api/2/myself'); }
    catch (error) { if (error.code === 'AUTH_REQUIRED') this.cookie = null; throw error; }
    if (!user.name) { this.cookie = null; throw new JiraError('AUTH_REQUIRED', 'Jira did not confirm the account.'); }
    return { name: user.name, display_name: user.displayName ?? null, base_url: this.baseUrl };
  }

  async listMyTickets({ priority = null, group_by = null, start_at = 0, max_results = 50 } = {}) {
    pageArguments(start_at, max_results);
    if (group_by !== null && group_by !== 'project') throw new JiraError('INVALID_ARGUMENT', 'group_by must be project or omitted.');
    let jql = 'assignee = currentUser() AND resolution = Unresolved';
    if (priority !== null) {
      if (typeof priority !== 'string' || !priority.trim() || priority.length > 100 || /[\x00-\x1f]/.test(priority)) {
        throw new JiraError('INVALID_ARGUMENT', 'Use a Jira priority name such as High or Major.');
      }
      jql += ` AND priority = "${priority.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    }
    await this.whoami();
    const data = await this.request('/rest/api/2/search', { params: { jql: `${jql} ORDER BY updated DESC`, fields: LIST_FIELDS,
      startAt: start_at, maxResults: max_results } });
    const issues = (data.issues ?? []).map(item => normalizedIssue(item, this.baseUrl));
    const offset = data.startAt ?? start_at, total = data.total ?? issues.length, next = offset + issues.length;
    const result = { issues, start_at: offset, total, next_start_at: issues.length && next < total ? next : null };
    if (group_by) {
      const groups = new Map();
      for (const issue of issues) { if (!groups.has(issue.project)) groups.set(issue.project, []); groups.get(issue.project).push(issue); }
      result.groups = Object.fromEntries(groups);
    }
    return result;
  }

  async getIssue({ key, expand = null }) {
    key = issueKey(key);
    await this.whoami();
    return this.request(`/rest/api/2/issue/${key}`, { params: { fields: '*all', properties: '*all', ...(expand ? { expand } : {}) } });
  }

  async getAttachment({ attachment_id, max_size_mb = 50 }) {
    if (typeof attachment_id !== 'string' || !/^[1-9][0-9]{0,29}$/.test(attachment_id)) {
      throw new JiraError('INVALID_ARGUMENT', 'Use an attachment ID from fields.attachment.');
    }
    if (!Number.isInteger(max_size_mb) || max_size_mb < 1 || max_size_mb > 500) {
      throw new JiraError('INVALID_ARGUMENT', 'max_size_mb must be between 1 and 500 (MiB).');
    }
    await this.whoami();
    const metadata = await this.request(`/rest/api/2/attachment/${attachment_id}`);
    if (typeof metadata.content !== 'string' || typeof metadata.filename !== 'string' || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      throw new JiraError('INVALID_RESPONSE', 'Jira returned invalid attachment metadata.');
    }
    const url = downloadUrl(metadata.content, this.baseUrl), maxBytes = max_size_mb * 1024 * 1024;
    if (metadata.size > maxBytes) throw new JiraError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds max_size_mb.');
    let directory;
    try {
      directory = await mkdtemp(resolve(tmpdir(), 'jira-mcp-attachment-'));
      const path = join(directory, safeFilename(metadata.filename));
      const { size, sha256 } = await this.download(url, path, maxBytes, metadata);
      return { attachment_id, metadata, path, downloaded_size: size, sha256 };
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (error instanceof JiraError) throw error;
      throw new JiraError('DOWNLOAD_ERROR', 'Cannot save the attachment in the local temporary directory.');
    }
  }

  async download(url, path, maxBytes, metadata) {
    for (let hop = 0; hop < 6; hop++) {
      const response = await this.response(url, { accept: '*/*' });
      try {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('Location');
          if (!location || hop === 5) throw new JiraError('INVALID_RESPONSE', 'Invalid or excessive attachment redirects.');
          url = downloadUrl(new URL(location, url).href, this.baseUrl); continue;
        }
        this.checkResponse(response);
        const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
        if (contentType === 'text/html' && String(metadata.mimeType ?? '').split(';')[0].trim().toLowerCase() !== 'text/html') {
          throw new JiraError('AUTH_REQUIRED', 'Jira returned a sign-in page. Sign in locally.');
        }
        if (Number(response.headers.get('Content-Length')) > maxBytes) throw new JiraError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds max_size_mb.');
        const file = await open(path, 'wx', 0o600), digest = createHash('sha256'); let size = 0;
        try {
          try {
            for await (const chunk of response.body ?? []) {
              size += chunk.length;
              if (size > maxBytes) throw new JiraError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds max_size_mb.');
              await file.writeFile(chunk); digest.update(chunk);
            }
          } catch (error) { if (error instanceof JiraError || error.code) throw error; throw this.networkError(error); }
        } finally { await file.close(); }
        if (size !== metadata.size) throw new JiraError('INVALID_RESPONSE', 'Downloaded size does not match Jira metadata.');
        return { size, sha256: digest.digest('hex') };
      } finally { if (!response.bodyUsed) await response.body?.cancel(); }
    }
  }
}
