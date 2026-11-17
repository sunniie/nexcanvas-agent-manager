import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Native "choose folder" dialog of the host OS. Resolves undefined when cancelled/unavailable. */
export function pickFolder(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const done = (err: unknown, out: string) => {
      const p = (out || '').trim();
      resolve(!err && p ? p : undefined);
    };
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms;
$f = New-Object System.Windows.Forms.FolderBrowserDialog;
$f.Description = 'NexCanvas - chọn thư mục dự án';
$f.UseDescriptionForTitle = $true;
$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false};
if ($f.ShowDialog($owner) -eq 'OK') { [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $f.SelectedPath }`;
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: false }, (e, o) => done(e, o));
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "NexCanvas - chọn thư mục dự án")'], (e, o) => done(e, o));
    } else {
      execFile('zenity', ['--file-selection', '--directory'], (e, o) => done(e, o));
    }
  });
}

export function listDir(dir: string) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return {
    path: path.resolve(dir),
    parent: path.dirname(path.resolve(dir)),
    dirs: entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(),
  };
}
