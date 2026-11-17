import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { baseUrl, downloadUrl, safeFilename } from '../src/client.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { bytes, fixtureClient, issue, metadata, MemoryStore, rootUrl } from './fixture.mjs';

test('single issue preserves the entire response, custom fields, authors and server pagination', async () => {
  const { client, requests } = fixtureClient();
  assert.deepEqual(await client.getIssue({ key: 'ima-598', expand: 'names,schema' }), issue);
  assert.deepEqual(Object.fromEntries(requests.at(-1).url.searchParams), { fields: '*all', properties: '*all', expand: 'names,schema' });
  assert.equal(requests.length, 2);
});

test('list filters priority safely, groups tickets and exposes next page', async () => {
  const { client, requests } = fixtureClient();
  const result = await client.listMyTickets({ priority: 'High" OR "bad', group_by: 'project', start_at: 2, max_results: 1 });
  assert.equal(result.next_start_at, 3); assert.equal(result.groups.IMA[0].key, 'IMA-598');
  assert.match(requests.at(-1).url.searchParams.get('jql'), /High\\" OR \\"bad/);
  assert.equal(requests.at(-1).url.searchParams.get('fields'), 'summary,status,created,updated,priority');
});

test('login saves credentials after verifying the account without returning secrets', async () => {
  const { client, store, requests } = fixtureClient({ store: new MemoryStore(null) });
  const result = await client.login(' alice@example.test ', 'private-password');
  assert.deepEqual(store.value, { cookie: 'new-session', username: 'alice@example.test', password: 'private-password' });
  assert.equal(requests[0].options.headers.Cookie, undefined);
  assert.equal(requests[1].options.headers.Cookie, 'JSESSIONID=new-session');
  assert.doesNotMatch(JSON.stringify(result), /private-password|new-session/);
  assert.equal((await client.whoami()).name, 'alice');
});

test('missing auth, invalid keys and limits never query Jira anonymously', async () => {
  const { client, requests } = fixtureClient({ store: new MemoryStore(null) });
  await assert.rejects(client.whoami(), { code: 'AUTH_REQUIRED' });
  await assert.rejects(client.getIssue({ key: '../auth/1/session' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.getAttachment({ attachment_id: '../123' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.listMyTickets({ max_results: 101 }), { code: 'INVALID_ARGUMENT' });
  assert.equal(requests.length, 0);
});

test('failed account verification does not overwrite stored credentials', async () => {
  const store = new MemoryStore({ cookie: 'saved-session', username: 'alice', password: 'saved-password' });
  const { client } = fixtureClient({ store, handler: url => url.pathname.endsWith('/myself')
    ? new Response('private-error-body', { status: 401 }) : null });
  await assert.rejects(client.login('other-user', 'unverified-password'), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(store.value, { cookie: 'saved-session', username: 'alice', password: 'saved-password' });
});

test('HTTP errors, CAPTCHA and network failures do not expose response bodies or retry login', async () => {
  for (const [status, headers, code] of [[401, {}, 'AUTH_REQUIRED'], [403, {}, 'ACCESS_DENIED'],
    [403, { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' }, 'CAPTCHA_REQUIRED'], [404, {}, 'NOT_FOUND']]) {
    const { client, requests } = fixtureClient({ handler: () => new Response('private-cookie-and-password', { status, headers }) });
    await assert.rejects(client.whoami(), error => error.code === code && !error.message.includes('private-cookie-and-password'));
    assert.equal(requests.length, 1);
  }
  const { client } = fixtureClient({ handler: () => { throw new Error('private-cookie-and-password'); } });
  await assert.rejects(client.whoami(), error => error.code === 'CONNECTION_ERROR' && !error.message.includes('private-cookie-and-password'));
});

test('authenticated attachment download yields exact bytes, metadata, private file and checksum', async t => {
  const { client, requests } = fixtureClient();
  const result = await client.getAttachment({ attachment_id: '123' });
  t.after(() => rm(dirname(result.path), { recursive: true, force: true }));
  assert.ok(isAbsolute(result.path)); assert.deepEqual(await readFile(result.path), bytes);
  assert.deepEqual(result.metadata, metadata); assert.equal(result.downloaded_size, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(requests.every(request => request.options.headers.Cookie === 'JSESSIONID=saved-session'));
  if (process.platform !== 'win32') assert.equal((await stat(result.path)).mode & 0o777, 0o600);
});

test('attachment URL and redirect cannot send a session to another origin', async () => {
  for (const value of ['https://other.example/file', 'http://jira.example/file', 'https://jira.example:444/file', 'https://user:password@jira.example/file']) {
    assert.throws(() => downloadUrl(value, rootUrl), { code: 'INVALID_RESPONSE' });
  }
  const { client, requests } = fixtureClient({ handler: url => url.pathname.endsWith('review.txt')
    ? new Response(null, { status: 302, headers: { Location: 'https://other.example/file' } }) : null });
  await assert.rejects(client.getAttachment({ attachment_id: '123' }), { code: 'INVALID_RESPONSE' });
  assert.ok(requests.every(request => request.url.hostname === 'jira.example'));
});

test('oversized attachments and truncated responses fail rather than return a partial file', async () => {
  const large = fixtureClient({ handler: url => url.pathname.endsWith('/attachment/123')
    ? Response.json({ ...metadata, size: 2 * 1024 * 1024 }) : null });
  await assert.rejects(large.client.getAttachment({ attachment_id: '123', max_size_mb: 1 }), { code: 'ATTACHMENT_TOO_LARGE' });
  assert.equal(large.requests.length, 2);
  const truncated = fixtureClient({ handler: url => url.pathname.endsWith('review.txt') ? new Response('short') : null });
  await assert.rejects(truncated.client.getAttachment({ attachment_id: '123' }), { code: 'INVALID_RESPONSE' });
  const streaming = fixtureClient({ handler: url => url.pathname.endsWith('review.txt') ? new Response(Buffer.alloc(1024 * 1024 + 1)) : null });
  await assert.rejects(streaming.client.getAttachment({ attachment_id: '123', max_size_mb: 1 }), { code: 'ATTACHMENT_TOO_LARGE' });
});

test('download filenames stay local and work with Windows reserved names', () => {
  assert.equal(safeFilename('../../review.txt'), 'review.txt');
  assert.equal(safeFilename('C:\\tmp\\CON.txt'), '_CON.txt');
  assert.equal(safeFilename('bad:name?.txt'), 'bad_name_.txt');
  assert.equal(safeFilename('...'), 'attachment.bin');
  assert.throws(() => baseUrl('https://user:password@jira.example'), { code: 'CONFIG_ERROR' });
});

test('credential vault saves passwords, reads legacy sessions and never falls back to a file', async () => {
  let value = null;
  const store = new SessionStore(rootUrl, { entryFactory: () => ({ getPassword: () => value, setPassword: data => { value = data; } }) });
  assert.equal(await store.load(), null); await store.save('session-cookie', 'alice');
  assert.deepEqual(await store.load(), { cookie: 'session-cookie', username: 'alice' });
  await store.save('new-session', 'alice@example.test', 'private-password');
  assert.deepEqual(await store.load(), { cookie: 'new-session', username: 'alice@example.test', password: 'private-password' });
  value = JSON.stringify({ cookie: 'new-session', username: 'alice', password: 123 });
  await assert.rejects(store.load(), { code: 'CREDENTIAL_STORE_ERROR' });
  const broken = new SessionStore(rootUrl, { entryFactory: () => { throw new Error('private-store-error'); } });
  await assert.rejects(broken.load(), error => error.code === 'CREDENTIAL_STORE_ERROR' && !error.message.includes('private-store-error'));
});
