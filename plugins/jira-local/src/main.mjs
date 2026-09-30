import { main } from './server.mjs';

main().catch(() => { process.stderr.write('Jira MCP could not start. Check the plugin runtime and configuration.\n'); process.exitCode = 1; });
