#!/usr/bin/env node
// Launcher: builds the UI on first run, then starts the local server and opens the browser.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (!existsSync(path.join(root, 'dist', 'web', 'index.html'))) {
  console.log('Building UI (first run)…');
  const r = spawnSync(npx, ['vite', 'build', '--config', 'web/vite.config.ts'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'server', 'index.ts'), '--open', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
