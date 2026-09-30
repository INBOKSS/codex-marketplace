import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bytes, issue } from './fixture.mjs';

test('real stdio subprocess exposes schemas and all five tools with structured results', async t => {
  const code = `
    import { createJiraServer } from './src/server.mjs';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { fixtureClient } from './tests/fixture.mjs';
    const { client } = fixtureClient();
    const loginWindow = { open: async () => ({ status: 'login_required', login_url: 'http://127.0.0.1/example' }) };
    const { server } = createJiraServer({ client, loginWindow });
    await server.connect(new StdioServerTransport());
  `;
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('JIRA_')));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', code], cwd: process.cwd(), env, stderr: 'pipe' });
  t.after(() => client.close()); await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['jira_get_attachment', 'jira_get_issue', 'jira_list_my_tickets', 'jira_login', 'jira_whoami']);
  for (const tool of tools) assert.doesNotMatch(JSON.stringify(tool.inputSchema), /password|cookie|ctx/);
  const result = await client.callTool({ name: 'jira_get_issue', arguments: { key: 'IMA-598' } });
  assert.deepEqual(result.structuredContent, issue); assert.deepEqual(JSON.parse(result.content[0].text), issue);
  const listed = await client.callTool({ name: 'jira_list_my_tickets', arguments: { group_by: 'project' } });
  assert.equal(listed.structuredContent.groups.IMA[0].key, 'IMA-598');
  const who = await client.callTool({ name: 'jira_whoami', arguments: {} }); assert.equal(who.structuredContent.name, 'alice');
  const login = await client.callTool({ name: 'jira_login', arguments: {} }); assert.equal(login.structuredContent.status, 'login_required');
  const attachment = await client.callTool({ name: 'jira_get_attachment', arguments: { attachment_id: '123' } });
  const path = attachment.structuredContent.path; t.after(() => rm(dirname(path), { recursive: true, force: true }));
  assert.deepEqual(await readFile(path), bytes);
  const missing = await client.callTool({ name: 'jira_get_issue', arguments: { key: 'IMA-99999' } });
  assert.equal(missing.isError, true); assert.doesNotMatch(missing.content[0].text, /private-error-body/);
});
