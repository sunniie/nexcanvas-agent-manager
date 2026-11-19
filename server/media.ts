import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Agents (Claude, Codex) cannot watch a video: they read text and images. So a video the boss sends is
 * turned into what a model CAN use: technical facts, scene cuts, a contact sheet, a few key frames and
 * the loudness, written next to the file as <name>.video.md.
 */

export const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.m4v', '.mkv'];
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

export interface VideoAnalysis {
  /** File names (same folder as the video) of the contact sheet + key frames, for the model to look at. */
  images: string[];
  /** File name of the markdown summary. */
  summary: string;
  info: { duration: number; width: number; height: number; fps: number; audio: boolean; cuts: number[]; lufs?: number };
}

let ffmpegOk: boolean | undefined;
export function hasFfmpeg() {
  ffmpegOk ??= spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 && spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;
  return ffmpegOk;
}

function run(bin: string, args: string[], timeoutMs = 180_000): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (e: any, out, err) =>
      resolve({ out: String(out ?? ''), err: String(err ?? ''), code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 }),
    );
  });
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
};

export async function analyzeVideo(file: string): Promise<VideoAnalysis> {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));

  // 1) technical facts
  const probe = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60_000);
  let meta: any = {};
  try {
    meta = JSON.parse(probe.out);
  } catch {
    throw new Error('ffprobe could not read this video');
  }
  const v = (meta.streams ?? []).find((s: any) => s.codec_type === 'video');
  const a = (meta.streams ?? []).find((s: any) => s.codec_type === 'audio');
  if (!v) throw new Error('no video stream in this file');
  const duration = Number(meta.format?.duration ?? v.duration ?? 0);
  const [fn, fd] = String(v.avg_frame_rate ?? v.r_frame_rate ?? '0/1').split('/').map(Number);
  const fps = fd ? fn / fd : 0;
  const width = Number(v.width ?? 0);
  const height = Number(v.height ?? 0);
  const span = Math.min(duration || 600, 600); // analyse at most the first 10 minutes

  // 2) scene cuts (on a small copy of each frame: fast)
  const scene = await run('ffmpeg', ['-hide_banner', '-nostats', '-t', String(span), '-i', file, '-an', '-vf', "scale=320:-2,select='gt(scene,0.3)',metadata=print", '-f', 'null', '-'], 240_000);
  const cuts = [...`${scene.out}\n${scene.err}`.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.4).slice(0, 200);

  // 3) contact sheet: 12 evenly spaced frames in a 4x3 grid
  const images: string[] = [];
  const sheet = `${base}-sheet.jpg`;
  const tiles = 12;
  const sheetRun = await run('ffmpeg', ['-hide_banner', '-y', '-t', String(span), '-i', file, '-vf', `fps=${(tiles / Math.max(span, 1)).toFixed(6)},scale=480:-2,tile=4x3:padding=4:color=black`, '-frames:v', '1', '-q:v', '4', path.join(dir, sheet)]);
  if (sheetRun.code === 0 && fs.existsSync(path.join(dir, sheet))) images.push(sheet);

  // 4) key frames: the middle of the longest shots (or evenly spaced when there are few cuts)
  const bounds = [0, ...cuts, span];
  const shots = bounds.slice(0, -1).map((s, i) => ({ s, e: bounds[i + 1] })).filter((x) => x.e - x.s > 0.3);
  const picks = (shots.length >= 4 ? [...shots].sort((x, y) => y.e - y.s - (x.e - x.s)).slice(0, 6) : Array.from({ length: 5 }, (_, i) => ({ s: (span * i) / 5, e: (span * (i + 1)) / 5 })))
    .map((x) => (x.s + x.e) / 2)
    .sort((x, y) => x - y);
  for (const [i, t] of picks.entries()) {
    const name = `${base}-f${String(i + 1).padStart(2, '0')}-${t.toFixed(1)}s.jpg`;
    const r = await run('ffmpeg', ['-hide_banner', '-y', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', path.join(dir, name)], 60_000);
    if (r.code === 0 && fs.existsSync(path.join(dir, name))) images.push(name);
  }

  // 5) loudness (integrated LUFS), when there is audio
  let lufs: number | undefined;
  if (a) {
    const l = await run('ffmpeg', ['-hide_banner', '-nostats', '-t', String(span), '-i', file, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], 240_000);
    const m = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/.exec(l.err);
    if (m) lufs = Number(m[1]);
  }

  const shotLens = shots.map((x) => x.e - x.s);
  const avgShot = shotLens.length ? shotLens.reduce((p, c) => p + c, 0) / shotLens.length : span;
  const aspect = width && height ? (width / height > 1.6 ? '16:9 (landscape)' : width / height < 0.7 ? '9:16 (vertical)' : width / height > 0.9 && width / height < 1.1 ? '1:1 (square)' : `${(width / height).toFixed(2)}:1`) : '?';
  const lines = [
    `# Video: ${path.basename(file)}`,
    '',
    'Automatic analysis by NexCanvas (ffprobe/ffmpeg). You cannot watch the video: use these facts and the attached frames.',
    '',
    `- Duration: ${fmt(duration)} (${duration.toFixed(1)} s)${duration > span ? ` (analysed the first ${fmt(span)})` : ''}`,
    `- Frame: ${width}×${height}, ${aspect}, ${fps ? fps.toFixed(2) : '?'} fps, codec ${v.codec_name ?? '?'}`,
    `- Audio: ${a ? `${a.codec_name ?? '?'}, ${a.channels ?? '?'} ch, ${a.sample_rate ?? '?'} Hz${lufs !== undefined ? `, integrated loudness ${lufs} LUFS` : ''}` : 'none'}`,
    `- Size: ${(Number(meta.format?.size ?? 0) / 1024 / 1024).toFixed(1)} MB, bitrate ${Math.round(Number(meta.format?.bit_rate ?? 0) / 1000)} kb/s`,
    `- Pacing: ${cuts.length} hard cuts → ${shots.length} shots, average shot ${avgShot.toFixed(1)} s${shotLens.length ? `, shortest ${Math.min(...shotLens).toFixed(1)} s, longest ${Math.max(...shotLens).toFixed(1)} s` : ''}`,
    `- Cut times: ${cuts.length ? cuts.slice(0, 60).map(fmt).join(', ') + (cuts.length > 60 ? ' …' : '') : '(none detected: one continuous shot, or soft transitions)'}`,
    '',
    '## Frames (same folder as this file)',
    ...images.map((n) => `- ${n}${n.endsWith('-sheet.jpg') ? ' (contact sheet: 12 evenly spaced frames, read left→right, top→bottom)' : ''}`),
    '',
    '## Not covered automatically',
    '- Speech/voice-over text: no transcript. If the style depends on narration, transcribe the audio with a local tool (e.g. whisper) or ask the boss for the script.',
    '- Motion between frames (easing, camera moves), music choice and sound effects: infer from the frames, or sample more frames with ffmpeg (-ss <time> -frames:v 1).',
  ];
  const summary = `${base}.video.md`;
  fs.writeFileSync(path.join(dir, summary), `${lines.join('\n')}\n`);
  return { images, summary, info: { duration, width, height, fps, audio: !!a, cuts, lufs } };
}
