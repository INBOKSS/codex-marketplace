import { createRequire } from 'node:module';
import { JiraError } from './client.mjs';

const require = createRequire(import.meta.url);
const SERVICE = 'jira-local-mcp';

export class SessionStore {
  constructor(baseUrl, { entryFactory } = {}) { this.baseUrl = baseUrl; this.entryFactory = entryFactory; }

  entry() {
    if (!this.backend) {
      try {
        if (this.entryFactory) this.backend = this.entryFactory(SERVICE, this.baseUrl);
        else {
          const { Entry } = require('@napi-rs/keyring');
          this.backend = new Entry(SERVICE, this.baseUrl, { linux: { store: 'secret-service' } });
        }
      } catch { throw new JiraError('CREDENTIAL_STORE_ERROR', 'System credential storage is unavailable. Check its permissions.'); }
    }
    return this.backend;
  }

  async load() {
    try {
      const raw = this.entry().getPassword();
      if (raw === null || raw === undefined) return null;
      const data = JSON.parse(raw);
      if (typeof data?.cookie !== 'string' || typeof data?.username !== 'string') throw new Error();
      return data;
    } catch { throw new JiraError('CREDENTIAL_STORE_ERROR', 'Cannot read the system credential storage. Check its permissions.'); }
  }

  async save(cookie, username) {
    try { this.entry().setPassword(JSON.stringify({ cookie, username })); }
    catch { throw new JiraError('CREDENTIAL_STORE_ERROR', 'Cannot save the Jira session in system credential storage.'); }
  }
}
