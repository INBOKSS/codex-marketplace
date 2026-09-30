import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const englishOnlyZod = { name: 'english-only-zod', setup(builder) {
  // The plugin uses English validation messages; omit unused dependency translations.
  builder.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/ }, args => ({
    contents: 'export { default as en } from "./en.js";', loader: 'js', resolveDir: dirname(args.path)
  }));
} };
await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
await build({ entryPoints: [join(root, 'src/main.mjs')], outfile: join(output, 'server.cjs'), bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', external: ['@napi-rs/keyring'], legalComments: 'eof',
  banner: { js: 'var __jira_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': '__jira_import_meta_url' }, plugins: [englishOnlyZod] });

const nativeRoot = join(output, 'node_modules', '@napi-rs'); await mkdir(nativeRoot, { recursive: true });
const wrapper = join(nativeRoot, 'keyring'); await mkdir(wrapper);
for (const name of ['index.js', 'package.json', 'LICENSE']) await cp(join(root, 'node_modules/@napi-rs/keyring', name), join(wrapper, name));
const targets = ['darwin-arm64', 'darwin-x64', 'win32-x64-msvc', 'win32-arm64-msvc', 'linux-x64-gnu', 'linux-arm64-gnu'];
for (const target of targets) {
  const name = `@napi-rs/keyring-${target}`, version = '2.1.0';
  const info = await (await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`)).json();
  if (info.version !== version || !info.dist?.integrity?.startsWith('sha512-')) throw new Error('Invalid registry metadata');
  const buffer = Buffer.from(await (await fetch(info.dist.tarball)).arrayBuffer());
  if (`sha512-${createHash('sha512').update(buffer).digest('base64')}` !== info.dist.integrity) throw new Error('Package integrity check failed');
  const folder = join(nativeRoot, `keyring-${target}`), archive = join(output, `native-${target}.tgz`);
  await mkdir(folder); await writeFile(archive, buffer);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (entries.some(name => !name.startsWith('package/') || name.split('/').includes('..'))) throw new Error('Invalid package archive');
  execFileSync('tar', ['-xzf', archive, '-C', folder, '--strip-components=1']); await rm(archive);
}

const licenses = [];
async function collectLicenses(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(folder, entry.name);
    if (entry.name.startsWith('@')) { await collectLicenses(path); continue; }
    let pkg; try { pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); } catch { continue; }
    if (pkg.name?.startsWith('@esbuild/') || pkg.name === 'esbuild' || pkg.name?.startsWith('@napi-rs/keyring-')) continue;
    const files = await readdir(path);
    const license = files.find(name => /^licen[cs]e(?:\.|$)/i.test(name));
    if (license) licenses.push(`\n## ${pkg.name} ${pkg.version}\n\n${await readFile(join(path, license), 'utf8')}`);
  }
}
await collectLicenses(join(root, 'node_modules'));
await writeFile(join(output, 'THIRD-PARTY-LICENSES.txt'), licenses.join('\n'));

const release = resolve(root, '../../releases/jira-local-codex');
await rm(release, { recursive: true, force: true });
const plugin = join(release, 'plugins/jira-local'); await mkdir(plugin, { recursive: true });
for (const name of ['.codex-plugin', '.mcp.json', 'dist', 'README.md']) await cp(join(root, name), join(plugin, name), { recursive: true });
await mkdir(join(release, '.agents/plugins'), { recursive: true });
await cp(resolve(root, '../../.agents/plugins/marketplace.json'), join(release, '.agents/plugins/marketplace.json'));
await cp(join(root, 'README.md'), join(release, 'START-HERE.md'));
console.log(JSON.stringify({ release, nativeTargets: targets, server: join(output, 'server.cjs') }));
