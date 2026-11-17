#!/usr/bin/env node
// Evidence screenshots for NexCanvas employees.
//
//   node tools/shot.mjs <url | html file> <out.png> [options]
//
//   --serve "<command>"  start this command first (e.g. "npm run dev"), wait until the URL answers,
//                        take the shot, then stop the command and its children
//   --full               capture the whole scrollable page
//   --width=1280 --height=800   viewport (default 1280x800)
//   --wait=800           extra milliseconds after load (animations, fonts)
//   --selector=".card"   shoot only this element
//   --timeout=120        seconds to wait for the URL when using --serve
//
// Uses an installed Edge or Chrome (or NEXCANVAS_BROWSER=<path>); no browser download.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) {
    pos.push(a);
    continue;
  }
  const eq = a.indexOf('=');
  if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
  else if (a === '--full') flags.full = true;
  else flags[a.slice(2)] = args[++i];
}
const [target, out] = pos;
if (!target || !out) {
  console.error('usage: node shot.mjs <url | html file> <out.png> [--serve "<cmd>"] [--full] [--width=1280 --height=800] [--wait=ms] [--selector=css]');
  process.exit(2);
}

function findBrowser() {
  const env = process.env.NEXCANVAS_BROWSER;
  if (env && fs.existsSync(env)) return env;
  const win = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates =
    process.platform === 'win32'
      ? win.flatMap((d) => [path.join(d, 'Microsoft/Edge/Application/msedge.exe'), path.join(d, 'Google/Chrome/Application/chrome.exe')])
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
            .map((b) => spawnSync('which', [b], { encoding: 'utf8' }).stdout?.trim())
            .filter(Boolean);
  return candidates.find((c) => c && fs.existsSync(c));
}

const isUrl = /^https?:\/\//i.test(target);
const url = isUrl ? target : pathToFileURL(path.resolve(target)).href;
if (!isUrl && !fs.existsSync(path.resolve(target))) {
  console.error(`file not found: ${target}`);
  process.exit(1);
}

let server;
function stopServer() {
  if (!server?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}
process.on('exit', stopServer);
process.on('SIGINT', () => process.exit(130));

async function waitForUrl(u, seconds) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try {
      const r = await fetch(u, { redirect: 'manual' });
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (server && server.exitCode !== null) throw new Error(`--serve command exited with code ${server.exitCode}`);
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`${u} did not answer within ${seconds}s`);
}

try {
  if (flags.serve) {
    if (!isUrl) throw new Error('--serve needs a URL target');
    server = spawn(flags.serve, { shell: true, stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
    await waitForUrl(url, Number(flags.timeout ?? 120));
  }
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('no Edge/Chrome found (set NEXCANVAS_BROWSER to a Chromium-based browser)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nexcanvas-shot-'));
  process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }));
  // pipe: talk to the browser over stdio instead of a localhost DevTools socket — agent sandboxes
  // (e.g. Codex workspace-write) block that socket and the launch would hang.
  const launch = (extra = []) =>
    puppeteer.launch({
      executablePath,
      headless: true,
      pipe: true,
      timeout: 45_000,
      userDataDir: profile,
      args: ['--hide-scrollbars', '--no-first-run', '--no-default-browser-check', ...extra],
      defaultViewport: { width: Number(flags.width ?? 1280), height: Number(flags.height ?? 800), deviceScaleFactor: 1 },
    });
  let browser;
  try {
    browser = await launch();
  } catch {
    // Inside a restricted sandbox the browser's own sandbox and GPU process can fail to start.
    browser = await launch(['--no-sandbox', '--disable-gpu']);
  }
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
    await new Promise((r) => setTimeout(r, Number(flags.wait ?? 800)));
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    if (flags.selector) {
      const el = await page.waitForSelector(flags.selector, { timeout: 10_000 });
      await el.screenshot({ path: out });
    } else {
      await page.screenshot({ path: out, fullPage: !!flags.full });
    }
  } finally {
    await browser.close();
  }
  console.log(`saved ${path.resolve(out)}`);
  process.exit(0);
} catch (e) {
  console.error(`shot failed: ${e.message}`);
  process.exit(1);
}
