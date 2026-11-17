// Pixel office renderer. Everything is drawn procedurally with fillRect — no third-party art.
import type { Account, AppSnapshot, Employee, Task } from '../../../shared/types';

export const T = 16; // tile size in logical pixels
export const COLS = 30;
export const ROWS = 18;
export const W = COLS * T;
export const H = ROWS * T;

type Pose = 'stand' | 'walk' | 'sit' | 'sleep';
type Pt = { x: number; y: number };

interface Actor {
  id: string;
  pos: Pt;
  path: Pt[];
  pose: Pose;
  facing: 1 | -1;
  dest: string;
  bubble?: { text: string; until: number };
}

// ---------- layout (logical px) ----------

const DESKS: Pt[] = [
  { x: 2.5 * T, y: 5 * T },
  { x: 8.5 * T, y: 5 * T },
  { x: 14.5 * T, y: 5 * T },
  { x: 2.5 * T, y: 10.5 * T },
  { x: 8.5 * T, y: 10.5 * T },
  { x: 14.5 * T, y: 10.5 * T },
];
const LEAD_DESK: Pt = { x: 23.5 * T, y: 5 * T };
const seatOf = (d: Pt): Pt => ({ x: d.x + 1.5 * T, y: d.y + 2.6 * T });
const AISLE_Y = 9.2 * T;
const DOOR: Pt = { x: 10 * T, y: 17.2 * T };
const ROOM_DOOR: Pt = { x: 20.5 * T, y: 8.6 * T };
const SOFA_SPOTS: Pt[] = [
  { x: 23 * T, y: 14.1 * T },
  { x: 25 * T, y: 14.1 * T },
  { x: 27 * T, y: 14.1 * T },
  { x: 22 * T, y: 15.6 * T },
  { x: 24.5 * T, y: 15.6 * T },
  { x: 27 * T, y: 15.6 * T },
];
const BOARD_SPOT: Pt = { x: 12 * T, y: 3.9 * T };

// ---------- palette ----------

const C = {
  wall: '#2b2d4a',
  wallDark: '#1f2038',
  wallTrim: '#3d4070',
  wood1: '#c8925a',
  wood2: '#bb8650',
  woodLine: '#a6743f',
  carpet1: '#4a3a6b',
  carpet2: '#45365f',
  lounge1: '#2f5d62',
  lounge2: '#2b5559',
  hall: '#22243a',
  hallLine: '#2c2f4a',
  desk: '#8b5a2b',
  deskTop: '#a86b35',
  deskDark: '#5e3b1b',
  monitor: '#1a1c2c',
  screenOff: '#2a3045',
  plantPot: '#b5562d',
  plant: '#3fa34d',
  plantDark: '#2b7a36',
  shadow: 'rgba(0,0,0,0.22)',
};

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

// ---------- static layer ----------

function skyColor(hour: number) {
  if (hour >= 6 && hour < 17) return ['#8fd3ff', '#bfe8ff'];
  if (hour >= 17 && hour < 19) return ['#ff9e6b', '#ffc59e'];
  return ['#1b2350', '#2e3a78'];
}

function drawWindow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hour: number) {
  const [a, b] = skyColor(hour);
  rect(ctx, x - 2, y - 2, w + 4, 2 * T + 4, '#151628');
  rect(ctx, x, y, w, 2 * T, a);
  rect(ctx, x, y, w, T * 0.7, b);
  if (hour >= 6 && hour < 19) {
    rect(ctx, x + 6, y + 8, 10, 3, '#ffffff');
    rect(ctx, x + 9, y + 6, 6, 2, '#ffffff');
  } else {
    rect(ctx, x + w - 10, y + 5, 4, 4, '#f6f1c1');
    rect(ctx, x + 8, y + 12, 1, 1, '#ffffff');
    rect(ctx, x + 20, y + 7, 1, 1, '#ffffff');
  }
  rect(ctx, x + w / 2 - 1, y, 2, 2 * T, '#151628');
  rect(ctx, x, y + 2 * T - 3, w, 3, '#d9dbe8');
}

function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number) {
  rect(ctx, x + 3, y + 16, 10, 2, C.shadow);
  rect(ctx, x + 4, y + 9, 8, 7, C.plantPot);
  rect(ctx, x + 4, y + 9, 8, 2, '#d06a3a');
  rect(ctx, x + 2, y + 1, 12, 9, C.plant);
  rect(ctx, x + 5, y - 2, 6, 4, C.plant);
  rect(ctx, x + 3, y + 5, 4, 3, C.plantDark);
  rect(ctx, x + 9, y + 2, 3, 3, C.plantDark);
}

function drawDesk(ctx: CanvasRenderingContext2D, d: Pt, wide = 3) {
  const w = wide * T;
  rect(ctx, d.x + 2, d.y + 1.6 * T, w, 4, C.shadow);
  rect(ctx, d.x, d.y + T * 0.6, w, T, C.deskTop);
  rect(ctx, d.x, d.y + T * 1.6, w, 4, C.deskDark);
  rect(ctx, d.x + 2, d.y + T * 1.6, 3, 6, C.deskDark);
  rect(ctx, d.x + w - 5, d.y + T * 1.6, 3, 6, C.deskDark);
  // keyboard + mug
  rect(ctx, d.x + w / 2 - 7, d.y + T * 1.05, 14, 3, '#d8dbe6');
  rect(ctx, d.x + w - 9, d.y + T * 0.85, 4, 4, '#f2f2f2');
}

function drawChair(ctx: CanvasRenderingContext2D, d: Pt) {
  const s = seatOf(d);
  rect(ctx, s.x - 6, s.y - 4, 12, 9, '#2c2f45');
  rect(ctx, s.x - 6, s.y + 5, 12, 2, '#1d1f30');
  rect(ctx, s.x - 1, s.y + 7, 2, 4, '#1d1f30');
  rect(ctx, s.x - 5, s.y + 11, 10, 2, '#1d1f30');
}

function buildStatic(hour: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;

  // floors
  for (let y = 3; y < 16; y++) {
    for (let x = 0; x < COLS; x++) {
      const px = x * T;
      const py = y * T;
      if (x < 20) {
        rect(ctx, px, py, T, T, (x + y) % 2 ? C.wood1 : C.wood2);
        rect(ctx, px, py + T - 1, T, 1, C.woodLine);
        if ((x * 7 + y * 3) % 5 === 0) rect(ctx, px + T / 2, py, 1, T - 1, C.woodLine);
      } else if (x > 20 && y < 11) {
        rect(ctx, px, py, T, T, (x + y) % 2 ? C.carpet1 : C.carpet2);
      } else if (x > 20) {
        rect(ctx, px, py, T, T, (x + y) % 2 ? C.lounge1 : C.lounge2);
      }
    }
  }
  // bottom hallway with entrance
  for (let y = 16; y < ROWS; y++) for (let x = 0; x < 20; x++) {
    rect(ctx, x * T, y * T, T, T, C.hall);
    rect(ctx, x * T, y * T, T, 1, C.hallLine);
  }
  for (let y = 16; y < ROWS; y++) for (let x = 20; x < COLS; x++) rect(ctx, x * T, y * T, T, T, (x + y) % 2 ? C.lounge1 : C.lounge2);
  rect(ctx, 0, 15.75 * T, 20 * T, 4, C.wallTrim);
  rect(ctx, 8.5 * T, 15.75 * T, 3 * T, 4, '#6b5a3a'); // door threshold

  // top wall
  rect(ctx, 0, 0, W, 3 * T, C.wall);
  rect(ctx, 0, 3 * T - 4, W, 4, C.wallTrim);
  for (const x of [1, 5.5, 22.5, 26.5]) drawWindow(ctx, x * T, 0.4 * T, 3 * T, hour);

  // partition wall between floor and lead's room / lounge
  rect(ctx, 20 * T, 3 * T, T, 13 * T, C.wallDark);
  rect(ctx, 20 * T + 3, 3 * T, T - 6, 13 * T, C.wallTrim);
  rect(ctx, 20 * T, 7.6 * T, T, 2 * T, C.wood2); // doorway to lead's room
  rect(ctx, 20 * T, 12 * T, T, 2 * T, C.lounge1); // doorway to lounge
  rect(ctx, 21 * T, 11 * T - 2, 9 * T, 3, C.wallTrim); // room divider
  rect(ctx, 24 * T, 11 * T - 2, 2 * T, 3, C.lounge2);

  // lead's room: rug + desk + bookshelf
  rect(ctx, 22 * T, 4.4 * T, 7 * T, 5.4 * T, '#5b4580');
  rect(ctx, 22.3 * T, 4.7 * T, 6.4 * T, 4.8 * T, '#6a5193');
  drawDesk(ctx, LEAD_DESK, 3);
  drawChair(ctx, LEAD_DESK);
  rect(ctx, 28 * T, 3.2 * T, T * 1.6, T * 1.8, '#5e3b1b');
  for (let i = 0; i < 4; i++) rect(ctx, 28 * T + 3 + i * 5, 3.4 * T, 4, 10, ['#e85d4a', '#4a90e2', '#f2a93b', '#50b36b'][i]);
  for (let i = 0; i < 4; i++) rect(ctx, 28 * T + 3 + i * 5, 4.2 * T, 4, 9, ['#9b59d0', '#2fb6a8', '#e45f9b', '#f2e85c'][i]);

  // lounge: sofa, coffee machine, plants
  rect(ctx, 22 * T, 13.2 * T, 7 * T, T * 1.4, '#8c2f39');
  rect(ctx, 22 * T, 12.8 * T, 7 * T, 8, '#a63a46');
  rect(ctx, 21.7 * T, 12.8 * T, 6, T * 1.8, '#7a2832');
  rect(ctx, 29 * T - 1, 12.8 * T, 6, T * 1.8, '#7a2832');
  rect(ctx, 21.2 * T, 16.2 * T, 2 * T, T, '#3a3d55'); // beanbag-ish mat
  rect(ctx, 28.6 * T, 11.4 * T, 18, 22, '#3b3f58'); // coffee machine
  rect(ctx, 28.6 * T + 4, 11.4 * T + 4, 10, 6, '#7fd6ff');
  rect(ctx, 28.6 * T + 6, 11.4 * T + 14, 6, 5, '#f2f2f2');

  // main floor props
  drawPlant(ctx, 0.3 * T, 3.2 * T);
  drawPlant(ctx, 18.7 * T, 3.2 * T);
  drawPlant(ctx, 0.3 * T, 14.4 * T);
  drawPlant(ctx, 18.7 * T, 14.4 * T);
  drawPlant(ctx, 21.2 * T, 3.3 * T);
  // bookshelf + printer in the middle aisle edge
  rect(ctx, 18.6 * T, 7.4 * T, T * 1.3, T * 2.4, '#5e3b1b');
  for (let r = 0; r < 3; r++) for (let i = 0; i < 3; i++) rect(ctx, 18.6 * T + 3 + i * 6, 7.6 * T + r * 12, 5, 9, ['#e85d4a', '#4a90e2', '#f2a93b', '#50b36b', '#9b59d0'][(r + i) % 5]);
  // server rack in the hallway
  rect(ctx, 0.5 * T, 16.1 * T, T * 1.2, T * 1.8, '#151628');
  for (let i = 0; i < 4; i++) rect(ctx, 0.5 * T + 3, 16.3 * T + i * 6, T * 1.2 - 6, 4, '#2a2d48');

  for (const d of DESKS) drawChair(ctx, d);
  return cv;
}

// ---------- dynamic pieces ----------

function drawMonitor(ctx: CanvasRenderingContext2D, d: Pt, on: boolean, working: boolean, t: number, accent: string) {
  const mx = d.x + 1.5 * T - 9;
  const my = d.y - 2;
  rect(ctx, mx, my, 18, 13, C.monitor);
  rect(ctx, mx + 2, my + 2, 14, 9, on ? '#0f2a3a' : C.screenOff);
  if (on) {
    const lines = working ? 4 : 2;
    for (let i = 0; i < lines; i++) {
      const len = working ? 3 + ((Math.floor(t * 6) + i * 3) % 9) : 6 - i * 2;
      rect(ctx, mx + 3, my + 3 + i * 2, len, 1, i % 2 ? accent : '#7fffb0');
    }
  }
  rect(ctx, mx + 7, my + 13, 4, 3, C.monitor);
  rect(ctx, mx + 4, my + 15, 10, 2, C.monitor);
}

function drawWhiteboard(ctx: CanvasRenderingContext2D, tasks: Task[]) {
  const x = 10 * T;
  const y = 0.3 * T;
  const w = 9.5 * T;
  const h = 2.3 * T;
  rect(ctx, x - 2, y - 2, w + 4, h + 4, '#8a8fa8');
  rect(ctx, x, y, w, h, '#f4f5fa');
  const cols: [string, Task['status'][]][] = [
    ['#9aa0b5', ['todo', 'needs_permission']],
    ['#f2a93b', ['in_progress', 'waiting_quota']],
    ['#9b59d0', ['review']],
    ['#50b36b', ['done']],
  ];
  const cw = w / 4;
  cols.forEach(([color, statuses], i) => {
    const cx = x + i * cw;
    rect(ctx, cx + 3, y + 3, cw - 6, 2, color);
    if (i > 0) rect(ctx, cx, y + 2, 1, h - 4, '#d5d8e3');
    const items = tasks.filter((t) => statuses.includes(t.status)).slice(0, 12);
    items.forEach((t, k) => {
      const ix = cx + 4 + (k % 4) * 8;
      const iy = y + 9 + Math.floor(k / 4) * 7;
      rect(ctx, ix, iy, 6, 5, t.status === 'waiting_quota' ? '#7fb8ff' : t.status === 'needs_permission' ? '#ff6f61' : color);
    });
  });
}

function drawClock(ctx: CanvasRenderingContext2D, now: Date) {
  const cx = 9.2 * T;
  const cy = 1.4 * T;
  ctx.fillStyle = '#f4f5fa';
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#151628';
  ctx.lineWidth = 2;
  ctx.stroke();
  const hA = ((now.getHours() % 12) + now.getMinutes() / 60) * (Math.PI / 6) - Math.PI / 2;
  const mA = now.getMinutes() * (Math.PI / 30) - Math.PI / 2;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(hA) * 3.5, cy + Math.sin(hA) * 3.5);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(mA) * 5.5, cy + Math.sin(mA) * 5.5);
  ctx.strokeStyle = '#d9534f';
  ctx.stroke();
}

/** 16x24 character, (x,y) = feet center. */
function drawCharacter(ctx: CanvasRenderingContext2D, e: Employee, a: Actor, t: number) {
  const { skin, hair, shirt, pants, hairStyle } = e.look;
  const x = Math.round(a.pos.x - 8);
  const y = Math.round(a.pos.y - 24);
  if (a.pose === 'sleep') {
    // lying on the sofa
    rect(ctx, x - 2, y + 14, 20, 6, shirt);
    rect(ctx, x + 14, y + 14, 6, 6, pants);
    rect(ctx, x - 7, y + 12, 8, 8, skin);
    rect(ctx, x - 7, y + 11, 8, 3, hair);
    rect(ctx, x - 5, y + 16, 2, 1, '#3a2a20');
    return;
  }
  const walk = a.pose === 'walk';
  const sit = a.pose === 'sit';
  const step = walk ? Math.floor(t * 8) % 2 : 0;
  const bob = walk && step ? -1 : 0;
  // shadow
  rect(ctx, x + 2, y + 23, 12, 2, C.shadow);
  // legs
  if (sit) {
    rect(ctx, x + 4, y + 17, 8, 3, pants);
  } else {
    rect(ctx, x + 4, y + 17 + (step ? 1 : 0), 3, 6 - (step ? 1 : 0), pants);
    rect(ctx, x + 9, y + 17 + (step ? 0 : 1), 3, 6 - (step ? 0 : 1), pants);
    rect(ctx, x + 4, y + 22, 3, 2, '#1d1f30');
    rect(ctx, x + 9, y + 22, 3, 2, '#1d1f30');
  }
  // body
  rect(ctx, x + 3, y + 10 + bob, 10, 8, shirt);
  rect(ctx, x + 3, y + 16 + bob, 10, 1, 'rgba(0,0,0,0.15)');
  // arms (typing animation when sitting at a working desk)
  const typing = sit && e.status === 'working' ? Math.floor(t * 10) % 2 : 0;
  rect(ctx, x + 1, y + 11 + bob + (sit ? typing : 0), 2, 6, shirt);
  rect(ctx, x + 13, y + 11 + bob + (sit ? 1 - typing : 0), 2, 6, shirt);
  rect(ctx, x + 1, y + 16 + bob + (sit ? typing : 0), 2, 2, skin);
  rect(ctx, x + 13, y + 16 + bob + (sit ? 1 - typing : 0), 2, 2, skin);
  // head
  rect(ctx, x + 4, y + 2 + bob, 8, 8, skin);
  // hair styles
  rect(ctx, x + 3, y + 1 + bob, 10, 3, hair);
  if (hairStyle === 1) rect(ctx, x + 3, y + 1 + bob, 2, 7, hair);
  if (hairStyle === 2) {
    rect(ctx, x + 3, y + 1 + bob, 2, 9, hair);
    rect(ctx, x + 11, y + 1 + bob, 2, 9, hair);
  }
  if (hairStyle === 3) rect(ctx, x + 5, y - 1 + bob, 6, 2, hair);
  // face (looking at monitor when seated = back view)
  if (!sit) {
    const ex = a.facing === 1 ? 1 : 0;
    rect(ctx, x + 5 + ex, y + 5 + bob, 1, 2, '#1d1f30');
    rect(ctx, x + 9 + ex, y + 5 + bob, 1, 2, '#1d1f30');
  } else {
    rect(ctx, x + 4, y + 2 + bob, 8, 5, hair);
  }
  if (e.isCoordinator) {
    // tie for the boss of the floor
    rect(ctx, x + 7, y + 10 + bob, 2, 5, '#f2e85c');
  }
}

// ---------- engine ----------

export class OfficeEngine {
  private ctx: CanvasRenderingContext2D;
  private staticLayer: HTMLCanvasElement;
  private staticHour = -1;
  private actors = new Map<string, Actor>();
  private snap?: AppSnapshot;
  private raf = 0;
  private last = performance.now();
  private scale = 3;
  private offX = 0;
  private offY = 0;
  hover?: string;
  selected?: string;

  /** Screen (CSS px, relative to the canvas) position of an actor's head — for DOM tooltips. */
  anchorOf(id: string): { x: number; y: number } | undefined {
    const a = this.actors.get(id);
    if (!a) return undefined;
    const dpr = window.devicePixelRatio || 1;
    return { x: (this.offX + a.pos.x * this.scale) / dpr, y: (this.offY + (a.pos.y - 28) * this.scale) / dpr };
  }

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.staticLayer = buildStatic(new Date().getHours());
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }

  resize(cssW: number, cssH: number) {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const s = Math.min(this.canvas.width / W, this.canvas.height / H);
    this.scale = s >= 2 ? Math.floor(s) : s;
    this.offX = Math.floor((this.canvas.width - W * this.scale) / 2);
    this.offY = Math.floor((this.canvas.height - H * this.scale) / 2);
  }

  setSnapshot(s: AppSnapshot) {
    this.snap = s;
    const staff = this.staff();
    for (const e of staff) {
      let a = this.actors.get(e.id);
      if (!a) {
        const start = e.isCoordinator ? seatOf(LEAD_DESK) : e.status === 'walking-in' ? { ...DOOR } : this.destFor(e).pt;
        a = { id: e.id, pos: { ...start }, path: [], pose: 'stand', facing: 1, dest: '' };
        this.actors.set(e.id, a);
      }
      const d = this.destFor(e);
      if (d.key !== a.dest) {
        a.dest = d.key;
        a.path = this.route(a.pos, d.pt);
      }
    }
    for (const id of [...this.actors.keys()]) if (!staff.some((e) => e.id === id)) this.actors.delete(id);
  }

  say(id: string, text: string, ms = 4500) {
    const a = this.actors.get(id);
    if (a) a.bubble = { text, until: performance.now() + ms };
  }

  /** Map a mouse event to an employee id. */
  pick(clientX: number, clientY: number): string | undefined {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const lx = ((clientX - r.left) * dpr - this.offX) / this.scale;
    const ly = ((clientY - r.top) * dpr - this.offY) / this.scale;
    let best: string | undefined;
    for (const a of this.actors.values()) {
      const w = a.pose === 'sleep' ? 14 : 9;
      if (lx > a.pos.x - w && lx < a.pos.x + w && ly > a.pos.y - 26 && ly < a.pos.y + 2) best = a.id;
    }
    return best;
  }

  private staff(): Employee[] {
    const o = this.snap?.office;
    if (!o) return [];
    return o.coordinator ? [o.coordinator, ...o.employees] : o.employees;
  }

  private destFor(e: Employee): { key: string; pt: Pt } {
    const o = this.snap!.office;
    if (e.status === 'sleeping') {
      const sleepers = this.staff().filter((x) => x.status === 'sleeping');
      const i = Math.max(0, sleepers.findIndex((x) => x.id === e.id));
      return { key: `sofa${i}`, pt: SOFA_SPOTS[i % SOFA_SPOTS.length] };
    }
    if (e.isCoordinator) {
      const planning = o.jobs.some((j) => j.employeeId === e.id && j.status === 'running' && j.kind === 'plan');
      if (planning) return { key: 'board', pt: BOARD_SPOT };
      return { key: 'lead', pt: seatOf(LEAD_DESK) };
    }
    return { key: `desk${e.desk}`, pt: seatOf(DESKS[e.desk] ?? DESKS[0]) };
  }

  /** Manhattan routing through the aisle and the room doorways. */
  private route(from: Pt, to: Pt): Pt[] {
    const inRight = (p: Pt) => p.x > 20 * T;
    const pts: Pt[] = [];
    const rightDoor = (p: Pt) => (p.y > 11 * T ? { x: 20.5 * T, y: 13 * T } : ROOM_DOOR);
    if (inRight(from) !== inRight(to)) {
      const door = inRight(from) ? rightDoor(from) : rightDoor(to);
      if (!inRight(from)) {
        pts.push({ x: from.x, y: AISLE_Y }, { x: 18 * T, y: AISLE_Y }, { x: 18 * T, y: door.y }, door, { x: door.x + T, y: door.y }, { x: to.x, y: door.y }, to);
      } else {
        pts.push({ x: from.x, y: door.y }, { x: door.x + T, y: door.y }, door, { x: 18 * T, y: door.y }, { x: 18 * T, y: AISLE_Y }, { x: to.x, y: AISLE_Y }, to);
      }
    } else if (!inRight(from)) {
      pts.push({ x: from.x, y: AISLE_Y }, { x: to.x, y: AISLE_Y }, to);
    } else {
      pts.push({ x: from.x, y: 11 * T }, { x: to.x, y: 11 * T }, to);
    }
    return pts;
  }

  private loop(now: number) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const hour = new Date().getHours();
    if (hour !== this.staticHour) {
      this.staticLayer = buildStatic(hour);
      this.staticHour = hour;
    }
    for (const a of this.actors.values()) this.step(a, dt);
    this.draw(now / 1000);
    this.raf = requestAnimationFrame(this.loop);
  }

  private step(a: Actor, dt: number) {
    const speed = 46;
    let budget = speed * dt;
    while (budget > 0 && a.path.length) {
      const target = a.path[0];
      const dx = target.x - a.pos.x;
      const dy = target.y - a.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        a.pos = { ...target };
        a.path.shift();
        budget -= dist;
      } else {
        a.pos.x += (dx / dist) * budget;
        a.pos.y += (dy / dist) * budget;
        if (Math.abs(dx) > 0.5) a.facing = dx > 0 ? 1 : -1;
        budget = 0;
      }
    }
    if (a.path.length) a.pose = 'walk';
    else if (a.dest.startsWith('sofa')) a.pose = 'sleep';
    else if (a.dest.startsWith('desk') || a.dest === 'lead') a.pose = 'sit';
    else a.pose = 'stand';
  }

  private draw(t: number) {
    const { ctx } = this;
    const s = this.snap;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#12131f';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offX, this.offY);
    ctx.drawImage(this.staticLayer, 0, 0);

    const staff = this.staff();
    const accounts = new Map<string, Account>((s?.accounts ?? []).map((a) => [a.id, a]));
    drawWhiteboard(ctx, s?.office.tasks ?? []);
    drawClock(ctx, new Date());

    // desks + monitors (only for occupied seats, so the office "grows" with the team)
    const occupied = new Map(staff.filter((e) => !e.isCoordinator).map((e) => [e.desk, e]));
    DESKS.forEach((d, i) => {
      const e = occupied.get(i);
      drawDesk(ctx, d);
      const actor = e && this.actors.get(e.id);
      const seated = !!actor && actor.pose === 'sit';
      drawMonitor(ctx, d, seated, e?.status === 'working', t + i, accounts.get(e?.accountId ?? '')?.color ?? '#7fd6ff');
      if (!e) {
        // vacant desk: dimmed, with a little "+" sticky note
        ctx.fillStyle = 'rgba(18,19,31,0.35)';
        ctx.fillRect(d.x - 2, d.y - 4, 3 * T + 4, 2.6 * T + 16);
        rect(ctx, d.x + 3, d.y + 0.7 * T, 8, 8, '#f2e85c');
        rect(ctx, d.x + 6, d.y + 0.7 * T + 2, 2, 4, '#8a6d1d');
        rect(ctx, d.x + 5, d.y + 0.7 * T + 3, 4, 2, '#8a6d1d');
      }
    });
    const lead = s?.office.coordinator;
    const leadActor = lead && this.actors.get(lead.id);
    drawMonitor(ctx, LEAD_DESK, !!leadActor && leadActor.pose === 'sit', lead?.status === 'working', t, '#f2e85c');

    // server rack LEDs blink with activity
    const busy = Object.keys(s?.busy ?? {}).length;
    for (let i = 0; i < 4; i++) {
      const on = busy > 0 ? Math.floor(t * 6 + i) % 2 === 0 : i === 0;
      rect(ctx, 0.5 * T + 14, 16.3 * T + i * 6 + 1, 2, 2, on ? '#5fd47a' : '#2f6b3d');
    }

    // characters sorted by y for depth; seated characters are drawn behind their desk edge
    const sorted = [...this.actors.values()].sort((a, b) => a.pos.y - b.pos.y);
    for (const a of sorted) {
      const e = staff.find((x) => x.id === a.id);
      if (!e) continue;
      if (this.hover === a.id || this.selected === a.id) {
        // pixel selection ring under the feet
        const pulse = Math.floor(t * 4) % 2;
        ctx.fillStyle = this.selected === a.id ? '#f2e85c' : '#7fd6ff';
        const w = a.pose === 'sleep' ? 26 : 18 + pulse * 2;
        ctx.fillRect(Math.round(a.pos.x - w / 2), Math.round(a.pos.y) - 1, w, 2);
        ctx.fillRect(Math.round(a.pos.x - w / 2 + 2), Math.round(a.pos.y) + 1, w - 4, 1);
      }
      drawCharacter(ctx, e, a, t);
    }
    // zzz for sleepers
    for (const a of sorted) {
      if (a.pose !== 'sleep') continue;
      const k = (t * 1.2 + a.pos.x) % 3;
      ctx.fillStyle = '#cfe3ff';
      ctx.font = 'bold 7px monospace';
      ctx.fillText('z', a.pos.x - 4 + k * 2, a.pos.y - 14 - k * 4);
      ctx.fillText('Z', a.pos.x + 1 + k * 2, a.pos.y - 20 - k * 4);
    }

    // labels & bubbles in screen space (crisp text)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    const toScreen = (p: Pt) => ({ x: this.offX + p.x * this.scale, y: this.offY + p.y * this.scale });
    const fs = Math.max(10, Math.round(this.scale * 3.6));
    const nowMs = performance.now();
    for (const a of sorted) {
      const e = staff.find((x) => x.id === a.id);
      if (!e) continue;
      const p = toScreen({ x: a.pos.x, y: a.pos.y + (a.pose === 'sleep' ? 6 : 4) });
      const acc = accounts.get(e.accountId);
      const label = e.isCoordinator ? `★ ${e.name}` : e.name;
      ctx.font = `700 ${fs}px "Be Vietnam Pro", system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      const padX = 6 * dpr;
      const hBox = fs + 6 * dpr;
      const bx = p.x - tw / 2 - padX - 5 * dpr;
      ctx.fillStyle = this.hover === e.id ? 'rgba(255,255,255,0.95)' : 'rgba(18,19,31,0.85)';
      roundRect(ctx, bx, p.y, tw + padX * 2 + 10 * dpr, hBox, 4 * dpr);
      ctx.fill();
      ctx.fillStyle = acc?.color ?? '#888';
      ctx.fillRect(bx + 5 * dpr, p.y + hBox / 2 - 3 * dpr, 6 * dpr, 6 * dpr);
      ctx.fillStyle = this.hover === e.id ? '#12131f' : '#f4f5fa';
      ctx.fillText(label, bx + padX + 9 * dpr, p.y + fs + 1 * dpr);

      const bubble = a.bubble && a.bubble.until > nowMs ? a.bubble.text : e.status === 'sleeping' ? '😴 ' + (e.statusText ?? 'Đang nghỉ') : undefined;
      if (bubble) {
        const text = bubble.length > 46 ? bubble.slice(0, 45) + '…' : bubble;
        ctx.font = `600 ${fs}px "Be Vietnam Pro", system-ui, sans-serif`;
        const bw = ctx.measureText(text).width + 16 * dpr;
        const head = toScreen({ x: a.pos.x, y: a.pos.y - (a.pose === 'sleep' ? 18 : 30) });
        const bh = fs + 12 * dpr;
        let x0 = head.x - bw / 2;
        x0 = Math.max(4, Math.min(this.canvas.width - bw - 4, x0));
        const y0 = head.y - bh;
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, x0, y0, bw, bh, 6 * dpr);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(head.x - 5 * dpr, y0 + bh);
        ctx.lineTo(head.x + 5 * dpr, y0 + bh);
        ctx.lineTo(head.x, y0 + bh + 6 * dpr);
        ctx.fill();
        ctx.fillStyle = '#1d1f30';
        ctx.fillText(text, x0 + 8 * dpr, y0 + fs + 4 * dpr);
      }
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const avatarCache = new Map<string, string>();

/** Head-and-shoulders pixel avatar as a data URL (memoized per look) — used in chat, cards, dock. */
export function avatarURL(e: Employee): string {
  const key = JSON.stringify(e.look) + (e.isCoordinator ? '*' : '');
  const hit = avatarCache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  const s = 4;
  cv.width = 16 * s;
  cv.height = 16 * s;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  const a: Actor = { id: e.id, pos: { x: 8, y: 26 }, path: [], pose: 'stand', facing: 1, dest: '' };
  drawCharacter(ctx, { ...e, status: 'idle' }, a, 0);
  const url = cv.toDataURL();
  avatarCache.set(key, url);
  return url;
}

/** Small standalone portrait for the employee card. */
export function drawPortrait(canvas: HTMLCanvasElement, e: Employee) {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = Math.floor(canvas.width / 20);
  ctx.setTransform(s, 0, 0, s, 0, 0);
  const a: Actor = { id: e.id, pos: { x: 10, y: 26 }, path: [], pose: 'stand', facing: 1, dest: '' };
  drawCharacter(ctx, { ...e, status: 'idle' }, a, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
