import { JiraClient } from '../src/client.mjs';

export const rootUrl = 'https://jira.example/jira';
export const bytes = Buffer.from('Fixture attachment\n');
export const metadata = { id: '123', filename: 'review.txt', size: bytes.length, mimeType: 'text/plain',
  content: `${rootUrl}/secure/attachment/123/review.txt`, extra: { keep: true } };
export const issue = { key: 'IMA-598', id: '10000', properties: { example: null }, names: { customfield_10000: 'Custom' },
  fields: { summary: 'Fixture', description: 'Details', customfield_10000: { value: 'Custom' }, attachment: [metadata],
    comment: { startAt: 0, maxResults: 1, total: 12, comments: [{ id: '456', body: 'Review',
      author: { name: 'bob', emailAddress: 'bob@example.test' }, visibility: { type: 'role', value: 'Developers' } }] } } };

export class MemoryStore {
  constructor(value = { cookie: 'saved-session', username: 'alice' }) { this.value = value; }
  async load() { return this.value; }
  async save(cookie, username) { this.value = { cookie, username }; }
}

export function fixtureClient({ store = new MemoryStore(), handler } = {}) {
  const requests = [];
  const fetchImpl = async (value, options) => {
    const url = new URL(value); requests.push({ url, options });
    if (handler) { const response = await handler(url, options); if (response) return response; }
    if (url.pathname.endsWith('/rest/auth/1/session')) return Response.json({ session: { name: 'JSESSIONID', value: 'new-session' } });
    if (url.pathname.endsWith('/myself')) return Response.json({ name: 'alice', displayName: 'Alice' });
    if (url.pathname.endsWith('/search')) return Response.json({ startAt: 2, total: 5, issues: [issue] });
    if (url.pathname.endsWith('/issue/IMA-598')) return Response.json(issue);
    if (url.pathname.endsWith('/rest/api/2/attachment/123')) return Response.json(metadata);
    if (url.pathname.endsWith('/secure/attachment/123/review.txt')) return new Response(bytes, { headers: { 'Content-Type': 'text/plain' } });
    return new Response('private-error-body', { status: 404 });
  };
  return { client: new JiraClient({ url: rootUrl, store, fetchImpl }), requests, store };
}
