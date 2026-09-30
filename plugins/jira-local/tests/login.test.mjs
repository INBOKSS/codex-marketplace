import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginWindow } from '../src/login-window.mjs';
import { createJiraServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fixtureClient, MemoryStore } from './fixture.mjs';

test('browser form logs in locally, stores only a session and immediately authorizes MCP calls', async t => {
  const { client, store } = fixtureClient({ store: new MemoryStore(null) });
  const opened = [], login = new LoginWindow(client, { opener: async url => { opened.push(url); return true; } });
  t.after(() => login.close());
  const info = await login.open();
  assert.equal(info.browser_opened, true); assert.match(info.login_url, /^http:\/\/127\.0\.0\.1:[0-9]+\/[a-f0-9]{48}$/);
  const page = await fetch(info.login_url), html = await page.text();
  assert.equal(page.headers.get('Cache-Control'), 'no-store'); assert.match(page.headers.get('Content-Security-Policy'), /form-action 'self'/);
  // A native form POST needs its real Origin; no-referrer turns it into null.
  assert.equal(page.headers.get('Referrer-Policy'), 'same-origin');
  assert.match(html, /type="password"/); assert.doesNotMatch(html, /<script/);
  const result = await fetch(`${info.login_url}/login`, { method: 'POST', headers: { Origin: login.origin },
    body: new URLSearchParams({ username: 'alice', password: 'private-password' }) });
  assert.equal(result.status, 200); assert.match(await result.text(), /Jira connected/);
  assert.deepEqual(store.value, { cookie: 'new-session', username: 'alice' });
  assert.equal((await client.whoami()).name, 'alice');
  await login.open(); assert.equal(opened.length, 1);
});

test('login requires unpredictable path and matching Origin; failures never reflect the password', async t => {
  const { client, requests } = fixtureClient({ handler: url => url.pathname.endsWith('/rest/auth/1/session')
    ? new Response('private-cookie-and-password', { status: 401 }) : null });
  const login = new LoginWindow(client, { opener: async () => true }); t.after(() => login.close());
  const info = await login.open();
  assert.equal((await fetch(`${login.origin}/wrong-token`)).status, 404);
  for (const origin of ['https://evil.example', 'null', undefined]) {
    const badOrigin = await fetch(`${info.login_url}/login`, { method: 'POST', headers: origin ? { Origin: origin } : {},
      body: new URLSearchParams({ username: 'alice', password: 'private-password' }) });
    assert.equal(badOrigin.status, 403);
  }
  assert.equal(requests.length, 0);
  const denied = await fetch(`${info.login_url}/login`, { method: 'POST', headers: { Origin: login.origin },
    body: new URLSearchParams({ username: 'alice', password: 'private-password' }) });
  assert.equal(denied.status, 400); assert.doesNotMatch(await denied.text(), /private-password|private-cookie-and-password/);
  const large = await fetch(`${info.login_url}/login`, { method: 'POST', headers: { Origin: login.origin },
    body: new URLSearchParams({ username: 'alice', password: 'x'.repeat(9000) }) });
  assert.equal(large.status, 413);
});

test('unauthenticated MCP call opens one login page; reading succeeds after login without restart', async t => {
  const { client: jira } = fixtureClient({ store: new MemoryStore(null) });
  let opened = 0;
  const loginWindow = new LoginWindow(jira, { opener: async () => { opened++; return true; } });
  const { server } = createJiraServer({ client: jira, loginWindow });
  const mcp = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await mcp.close(); await server.close(); await loginWindow.close(); });
  await server.connect(serverTransport); await mcp.connect(clientTransport);
  const initial = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
  assert.equal(initial.isError, true); assert.match(initial.content[0].text, /AUTH_REQUIRED/); assert.equal(opened, 1);
  await fetch(`${loginWindow.url}/login`, { method: 'POST', headers: { Origin: loginWindow.origin },
    body: new URLSearchParams({ username: 'alice', password: 'private-password' }) });
  const result = await mcp.callTool({ name: 'jira_get_issue', arguments: { key: 'IMA-598' } });
  assert.ok(!result.isError); assert.equal(result.structuredContent.fields.description, 'Details');
  assert.equal(opened, 1);
});
