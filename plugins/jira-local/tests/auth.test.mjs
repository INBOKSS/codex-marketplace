import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createJiraServer } from '../src/server.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { bytes, fixtureClient, MemoryStore, rootUrl } from './fixture.mjs';

const credentials = { cookie: 'saved-session', username: 'alice@example.test', password: 'private-password' };
const expired = () => new Response('private-error-body', { status: 401 });

async function connect(t, client) {
  const opened = [];
  const loginWindow = { open: async () => {
    opened.push(true);
    return { message: 'Sign in locally.', login_url: 'http://127.0.0.1/example' };
  } };
  const { server } = createJiraServer({ client, loginWindow });
  const mcp = new Client({ name: 'auth-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await mcp.close(); await server.close(); });
  await server.connect(serverTransport); await mcp.connect(clientTransport);
  return { mcp, opened };
}

test('expired session is renewed from saved credentials without exposing secrets or opening a form', async t => {
  const { client, store, requests } = fixtureClient({ store: new MemoryStore({ ...credentials }),
    handler: (url, options) => options.headers.Cookie === 'JSESSIONID=saved-session' ? expired() : null });
  const { mcp, opened } = await connect(t, client);
  const result = await mcp.callTool({ name: 'jira_get_issue', arguments: { key: 'IMA-598' } });
  assert.ok(!result.isError); assert.equal(result.structuredContent.key, 'IMA-598');
  assert.equal(opened.length, 0);
  const logins = requests.filter(request => request.options.method === 'POST');
  assert.equal(logins.length, 1);
  assert.deepEqual(JSON.parse(logins[0].options.body), { username: 'alice@example.test', password: 'private-password' });
  assert.deepEqual(store.value, { ...credentials, cookie: 'new-session' });
  assert.doesNotMatch(JSON.stringify(result), /private-password|saved-session|new-session/);
  const restarted = fixtureClient({ store });
  assert.equal((await restarted.client.whoami()).name, 'alice');
  assert.equal(restarted.requests[0].options.headers.Cookie, 'JSESSIONID=new-session');
});

test('a pending vault read cannot replace a successfully applied manual session', async () => {
  const checking = Promise.withResolvers(), verification = Promise.withResolvers();
  let value = JSON.stringify(credentials);
  const store = new SessionStore(rootUrl, { entryFactory: () => ({
    getPassword: () => value, setPassword: data => { value = data; }
  }) });
  const { client } = fixtureClient({ store, handler: (url, options) => {
    if (url.pathname.endsWith('/rest/auth/1/session')) {
      return Response.json({ session: { name: 'JSESSIONID', value: 'manual-session' } });
    }
    if (options.headers.Cookie === 'JSESSIONID=manual-session') {
      return { status: 200, ok: true, headers: new Headers(), json() { checking.resolve(); return verification.promise; } };
    }
    return Response.json({ name: 'alice' });
  } });
  const manual = client.login('bob', 'replacement-password');
  await checking.promise;
  verification.resolve({ name: 'bob' });
  let reading;
  queueMicrotask(() => { reading = client.withSession(() => client.whoami()); });
  await manual;
  const result = await reading;
  assert.equal(result.name, 'bob'); assert.equal(client.cookie, 'manual-session');
  assert.deepEqual(await store.load(), { cookie: 'manual-session', username: 'bob', password: 'replacement-password' });
});

test('configured tool deadline covers slow session renewal and the retried request', { timeout: 3000 }, async t => {
  const config = JSON.parse(await readFile(new URL('../.mcp.json', import.meta.url), 'utf8'));
  const finished = Promise.withResolvers();
  const { client, requests } = fixtureClient({ store: new MemoryStore({ ...credentials }), handler: async (url, options) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (options.headers.Cookie === 'JSESSIONID=saved-session') return expired();
    if (url.pathname.endsWith('/issue/IMA-598')) finished.resolve();
  } });
  const { mcp } = await connect(t, client);
  try {
    // Scale configured seconds to milliseconds: five 20-second responses must fit the whole-tool deadline.
    const result = await mcp.callTool({ name: 'jira_get_issue', arguments: { key: 'IMA-598' } }, undefined,
      { timeout: config.mcpServers.jira.tool_timeout_sec });
    assert.ok(!result.isError); assert.equal(result.structuredContent.key, 'IMA-598');
    assert.equal(requests.length, 5);
  } finally { await finished.promise; }
});

test('parallel calls including a late expired response share one renewal', async t => {
  const late = Promise.withResolvers(); let oldRequests = 0;
  t.after(() => late.resolve());
  const { client, requests } = fixtureClient({ store: new MemoryStore({ ...credentials }), handler: async (url, options) => {
    if (options.headers.Cookie === 'JSESSIONID=saved-session') {
      if (++oldRequests === 3) await late.promise;
      return expired();
    }
  } });
  const { mcp, opened } = await connect(t, client);
  const calls = Array.from({ length: 3 }, () => mcp.callTool({ name: 'jira_whoami', arguments: {} }));
  const first = await Promise.all(calls.slice(0, 2));
  late.resolve();
  const results = [...first, await calls[2]];
  assert.ok(results.every(result => !result.isError && result.structuredContent.name === 'alice'));
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(opened.length, 0);
});

test('a manual sign-in wins over an older automatic login that finishes later', async t => {
  for (const status of [200, 401, 'network', 'timeout']) {
    await t.test(String(status), async t => {
      const started = Promise.withResolvers(), pendingLogin = Promise.withResolvers();
      t.after(() => pendingLogin.resolve(expired()));
      const { client, store } = fixtureClient({ store: new MemoryStore({ ...credentials }), handler: (url, options) => {
        if (url.pathname.endsWith('/rest/auth/1/session')) {
          if (JSON.parse(options.body).password === 'private-password') { started.resolve(); return pendingLogin.promise; }
          return Response.json({ session: { name: 'JSESSIONID', value: 'manual-session' } });
        }
        if (options.headers.Cookie === 'JSESSIONID=saved-session') return expired();
        if (url.pathname.endsWith('/myself') && options.headers.Cookie === 'JSESSIONID=manual-session') {
          return Response.json({ name: 'bob', displayName: 'Bob' });
        }
      } });
      const { mcp, opened } = await connect(t, client);
      const pending = mcp.callTool({ name: 'jira_whoami', arguments: {} });
      await started.promise;
      await client.login('bob', 'replacement-password');
      if (status === 'network' || status === 'timeout') {
        pendingLogin.reject(Object.assign(new Error('private-network-error'), { name: status === 'timeout' ? 'TimeoutError' : 'Error' }));
      } else pendingLogin.resolve(status === 200
        ? Response.json({ session: { name: 'JSESSIONID', value: 'stale-session' } }) : expired());
      const result = await pending;
      assert.ok(!result.isError); assert.equal(result.structuredContent.name, 'bob');
      assert.deepEqual(store.value, { cookie: 'manual-session', username: 'bob', password: 'replacement-password' });
      assert.equal(opened.length, 0);
    });
  }
});

test('failed manual credential save cannot hide an older automatic rejection or allow another password attempt', async t => {
  for (const [status, headers, code] of [[401, {}, 'AUTH_REQUIRED'],
    [403, { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' }, 'CAPTCHA_REQUIRED']]) {
    await t.test(code, async t => {
      const started = Promise.withResolvers(), pendingLogin = Promise.withResolvers();
      t.after(() => pendingLogin.resolve(expired()));
      const store = new SessionStore(rootUrl, { entryFactory: () => ({
        getPassword: () => JSON.stringify(credentials),
        setPassword: () => { throw new Error('private-vault-error'); }
      }) });
      const { client, requests } = fixtureClient({ store, handler: (url, options) => {
        if (url.pathname.endsWith('/rest/auth/1/session')) {
          if (JSON.parse(options.body).password === 'private-password') { started.resolve(); return pendingLogin.promise; }
          return Response.json({ session: { name: 'JSESSIONID', value: 'manual-session' } });
        }
        if (options.headers.Cookie === 'JSESSIONID=saved-session') return expired();
        if (url.pathname.endsWith('/myself')) return Response.json({ name: 'bob' });
      } });
      const { mcp, opened } = await connect(t, client);
      const pending = mcp.callTool({ name: 'jira_whoami', arguments: {} });
      await started.promise;
      await assert.rejects(client.login('bob', 'replacement-password'), { code: 'CREDENTIAL_STORE_ERROR' });
      pendingLogin.resolve(new Response('private-password', { status, headers }));
      const rejected = await pending;
      assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, new RegExp(code));
      assert.equal(opened.length, code === 'CAPTCHA_REQUIRED' ? 0 : 1);
      for (let i = 0; i < 2; i++) {
        const blocked = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
        assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, new RegExp(code));
        assert.doesNotMatch(JSON.stringify(blocked), /private-password|replacement-password|private-vault-error|saved-session/);
      }
      const automaticLogins = requests.filter(request => request.options.method === 'POST'
        && JSON.parse(request.options.body).password === 'private-password');
      assert.equal(automaticLogins.length, 1);
      assert.equal(client.cookie, 'saved-session');
      assert.deepEqual(await store.load(), credentials);
    });
  }
});

test('manual credentials win when manual and automatic account checks finish in the same microtask queue', async t => {
  for (const order of [['manual', 'auto'], ['auto', 'manual']]) {
    await t.test(order.join(' then '), async () => {
      const checks = { manual: Promise.withResolvers(), auto: Promise.withResolvers() };
      const checking = Promise.withResolvers(); let count = 0, value = null;
      const store = new SessionStore(rootUrl, { entryFactory: () => ({
        getPassword: () => value, setPassword: data => { value = data; }
      }) });
      const { client } = fixtureClient({ store, handler: (url, options) => {
        if (url.pathname.endsWith('/rest/auth/1/session')) {
          return Response.json({ session: { name: 'JSESSIONID', value: JSON.parse(options.body).username + '-session' } });
        }
        return { status: 200, ok: true, headers: new Headers(), json() {
          if (++count === 2) checking.resolve();
          return checks[options.headers.Cookie === 'JSESSIONID=manual-session' ? 'manual' : 'auto'].promise;
        } };
      } });
      const auto = client.login('auto', 'old-password', 0);
      const manual = client.login('manual', 'new-password');
      await checking.promise;
      for (const name of order) checks[name].resolve({ name });
      await Promise.all([auto, manual]);
      assert.deepEqual(await store.load(), { cookie: 'manual-session', username: 'manual', password: 'new-password' });
      assert.equal(client.cookie, 'manual-session');
    });
  }
});

test('session expiring during attachment download renews and retries the download', async t => {
  let downloads = 0;
  const { client, requests } = fixtureClient({ store: new MemoryStore({ ...credentials }), handler: url => {
    if (url.pathname.endsWith('review.txt') && ++downloads === 1) {
      return new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } });
    }
  } });
  const { mcp, opened } = await connect(t, client);
  const result = await mcp.callTool({ name: 'jira_get_attachment', arguments: { attachment_id: '123' } });
  assert.ok(!result.isError);
  const path = result.structuredContent.path; t.after(() => rm(dirname(path), { recursive: true, force: true }));
  assert.deepEqual(await readFile(path), bytes); assert.equal(downloads, 2);
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(opened.length, 0);
});

test('legacy sessions ask for HTML sign-in without attempting a password login', async t => {
  const { client, requests } = fixtureClient({ handler: expired });
  const { mcp, opened } = await connect(t, client);
  const result = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /AUTH_REQUIRED/);
  assert.equal(opened.length, 1); assert.equal(requests.length, 1);
});

test('rejected saved passwords are forgotten so subsequent calls cannot retry them', async t => {
  for (const [status, headers, code, forms] of [
    [401, {}, 'AUTH_REQUIRED', 1], [403, {}, 'AUTH_REQUIRED', 1],
    [403, { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' }, 'CAPTCHA_REQUIRED', 0]
  ]) {
    await t.test(String(status) + code, async t => {
      const { client, store, requests } = fixtureClient({ store: new MemoryStore({ ...credentials }), handler: url =>
        url.pathname.endsWith('/rest/auth/1/session') ? new Response('private-password', { status, headers }) : expired() });
      const { mcp, opened } = await connect(t, client);
      const result = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
      assert.equal(result.isError, true); assert.match(result.content[0].text, new RegExp(code));
      assert.doesNotMatch(JSON.stringify(result), /private-password|saved-session/);
      assert.equal(opened.length, forms); assert.equal(store.value.password, undefined);
      await mcp.callTool({ name: 'jira_whoami', arguments: {} });
      assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
    });
  }
});

test('rejected credentials stay blocked when vault cleanup fails, until a successful manual sign-in', async t => {
  for (const [status, headers, code] of [[401, {}, 'AUTH_REQUIRED'], [403, {}, 'AUTH_REQUIRED'],
    [403, { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' }, 'CAPTCHA_REQUIRED']]) {
    await t.test(String(status) + code, async t => {
      let value = JSON.stringify(credentials), denyWrites = true, rejectLogins = true, expireNext = false;
      const store = new SessionStore(rootUrl, { entryFactory: () => ({
        getPassword: () => value,
        setPassword: data => { if (denyWrites) throw new Error('private-vault-error'); value = data; }
      }) });
      const { client, requests } = fixtureClient({ store, handler: (url, options) => {
        if (url.pathname.endsWith('/rest/auth/1/session')) {
          return rejectLogins ? new Response('private-password', { status, headers }) : null;
        }
        if (options.headers.Cookie === 'JSESSIONID=saved-session') return expired();
        if (expireNext) { expireNext = false; return expired(); }
      } });
      const { mcp, opened } = await connect(t, client);
      const failed = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
      assert.equal(failed.isError, true); assert.match(failed.content[0].text, new RegExp(code));
      assert.doesNotMatch(JSON.stringify(failed), /private-password|saved-session|private-vault-error/);
      assert.equal(opened.length, code === 'CAPTCHA_REQUIRED' ? 0 : 1);
      for (let i = 0; i < 2; i++) {
        const blocked = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
        assert.equal(blocked.isError, true);
      }
      assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
      assert.equal((await store.load()).password, 'private-password');

      rejectLogins = false;
      await assert.rejects(client.login('alice', 'replacement-password'), { code: 'CREDENTIAL_STORE_ERROR' });
      await mcp.callTool({ name: 'jira_whoami', arguments: {} });
      assert.equal(requests.filter(request => request.options.method === 'POST').length, 2);

      denyWrites = false;
      await client.login('alice', 'replacement-password');
      expireNext = true;
      const renewed = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
      assert.ok(!renewed.isError); assert.equal(renewed.structuredContent.name, 'alice');
      const logins = requests.filter(request => request.options.method === 'POST');
      assert.equal(logins.length, 4);
      assert.equal(JSON.parse(logins.at(-1).options.body).password, 'replacement-password');
      assert.equal((await store.load()).password, 'replacement-password');
    });
  }
});

test('renewal retries the original operation only once even if the new session is rejected', async t => {
  const { client, requests } = fixtureClient({ store: new MemoryStore({ ...credentials }), handler: url =>
    url.pathname.endsWith('/issue/IMA-598') ? expired() : null });
  const { mcp, opened } = await connect(t, client);
  const result = await mcp.callTool({ name: 'jira_get_issue', arguments: { key: 'IMA-598' } });
  assert.equal(result.isError, true); assert.equal(opened.length, 1);
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(requests.filter(request => request.url.pathname.endsWith('/issue/IMA-598')).length, 2);
});

test('permission denial, CAPTCHA and network errors do not trigger password login', async t => {
  for (const [status, headers, code] of [[403, {}, 'ACCESS_DENIED'],
    [403, { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' }, 'CAPTCHA_REQUIRED'], [null, {}, 'CONNECTION_ERROR']]) {
    const { client, store, requests } = fixtureClient({ store: new MemoryStore({ ...credentials }), handler: () => {
      if (status === null) throw new Error('private-password');
      return new Response('private-password', { status, headers });
    } });
    const { mcp, opened } = await connect(t, client);
    const result = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
    assert.equal(result.isError, true); assert.match(result.content[0].text, new RegExp(code));
    assert.equal(opened.length, 0); assert.equal(requests.length, 1);
    assert.equal(store.value.password, 'private-password');
  }
});

test('temporary renewal connection errors retain credentials for a later request', async t => {
  let offline = true;
  const { client, store } = fixtureClient({ store: new MemoryStore({ ...credentials }), handler: (url, options) => {
    if (url.pathname.endsWith('/rest/auth/1/session') && offline) throw new Error('private-password');
    if (options.headers.Cookie === 'JSESSIONID=saved-session') return expired();
  } });
  const { mcp, opened } = await connect(t, client);
  const failed = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /CONNECTION_ERROR/);
  assert.equal(store.value.password, 'private-password'); assert.equal(opened.length, 0);
  offline = false;
  const result = await mcp.callTool({ name: 'jira_whoami', arguments: {} });
  assert.ok(!result.isError); assert.equal(result.structuredContent.name, 'alice');
});
