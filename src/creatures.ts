/**
 * The deep-sea cast. Every animal is a body plus a behaviour engine.
 *
 *   body  — a side-view shape function f(s, w) → skin / fin / eye / glow, where s runs
 *           nose (0) → tail (1) and w is height above the body axis, both in body
 *           lengths; or, for the small seabed animals, a hand-drawn ASCII sprite.
 *   think — a small state machine built from how the real animal is known to behave.
 *           It sets a desired velocity (dvx, dvy) and pose channels; integrate()
 *           does the physics, turning (with foreshortening) and pitching.
 *
 * The state string doubles as the hover label, so it reads as plain English.
 */
import { angleDiff, clamp, hash3, inTriangle as tri, rand, TAU } from "./math";
import type { Fish, World } from "./world";

export type Kind =
  | "sperm" | "humpback" | "orca" | "dolphin" | "white" | "hammer" | "sword" | "manta"
  | "turtle" | "squid" | "octopus" | "jelly" | "moray" | "angler" | "seahorse" | "crab";

export const F_BODY = 1, F_EDGE = 2, F_FIN = 3, F_EYE = 4, F_MARK = 5, F_PALE = 6, F_GLOW = 7, F_MOUTH = 8, F_SPRITE = 9;

const HALF_PI = Math.PI / 2;

export interface Creature {
  id: number;
  kind: Kind;
  alive: boolean;
  respawnAt: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Desired velocity, set by think(); integrate() eases toward it at `accel` per second. */
  dvx: number;
  dvy: number;
  accel: number;
  L: number;
  /** Intended horizontal travel direction. */
  dir: 1 | -1;
  /** −1 facing left … 1 facing right; passes through 0 while turning, which foreshortens the body. */
  face: number;
  faceWant: number;
  faceLock: boolean;
  /** Nose-up angle, radians. */
  pitch: number;
  pitchLock: boolean;
  /** Swims tail-first (a squid creeping up on prey arms-first). */
  reverse: boolean;
  phase: number;
  /** 0.5 far / dim → 1 near / bright. */
  depth: number;
  wander: number;
  state: string;
  stateT: number;
  timer: number;
  hunger: number;
  target: Fish | Creature | null;
  tx: number;
  ty: number;
  slot: number;
  /** Pod mode (leaders only) and time in it. */
  mode: number;
  modeT: number;
  /** Pose channels, per species: jaw / tentacles / extension (open), pulse / air / bite (aux). */
  open: number;
  aux: number;
  camo: number;
  homeX: number;
  homeY: number;
  home: number;
}

export interface Shape {
  flag: number;
  shade: number;
}

export interface Def {
  name: string;
  count: number;
  /** Body length in px from the shorter screen side; sprites return their width in cells. */
  size: (m: number) => number;
  depth: [number, number];
  maxPitch: number;
  /** How fast the facing flips (1/s); the body foreshortens mid-turn. */
  turn: number;
  /** Swim-cycle rate: base + per px/s of speed. */
  beat: [number, number];
  /** Up-down tail beat in body lengths: whales and dolphins swim with horizontal flukes. */
  bend: number;
  /** Fish keep fear·L + 40 px away; 0 = harmless. */
  fear: number;
  /** Bounding box in body coordinates: s from, s to, |w| max. */
  ext: [number, number, number];
  /** Skin colour at full light. */
  tint: [number, number, number];
  pale?: [number, number, number];
  glow?: [number, number, number][];
  /** Lives on the seabed; no automatic floor clamp. */
  seabed?: boolean;
  spawn: (c: Creature, w: World, i: number) => void;
  think: (c: Creature, w: World, dt: number) => void;
  shape?: (s: number, w: number, c: Creature, t: number, out: Shape) => boolean;
  sprite?: (c: Creature, t: number) => string[];
  colors?: Record<string, [number, number, number]>;
}

export function makeCreature(kind: Kind, id: number, slot: number): Creature {
  return {
    id, kind, alive: true, respawnAt: 0, x: 0, y: 0, vx: 0, vy: 0, dvx: 0, dvy: 0, accel: 1,
    L: 100, dir: 1, face: 1, faceWant: 1, faceLock: false, pitch: 0, pitchLock: false, reverse: false,
    phase: rand(0, TAU), depth: 1, wander: 0, state: "", stateT: 0, timer: 0, hunger: rand(0.2, 0.6),
    target: null, tx: 0, ty: 0, slot, mode: 0, modeT: 0, open: 0, aux: 0, camo: 0, homeX: 0, homeY: 0, home: 0,
  };
}

// ── physics ────────────────────────────────────────────────────────────

export function integrate(c: Creature, def: Def, w: World, dt: number) {
  // Whatever a behaviour wants, nobody strays far beyond the edges (chases and escapes included).
  const m = c.L * 1.2 + 60;
  if (c.x < -m) c.dvx = Math.abs(c.dvx) + 30;
  else if (c.x > w.width + m) c.dvx = -Math.abs(c.dvx) - 30;
  const k = Math.min(1, dt * c.accel);
  c.vx += (c.dvx - c.vx) * k;
  c.vy += (c.dvy - c.vy) * k;
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  if (!c.faceLock && Math.abs(c.vx) > 4) c.faceWant = (c.vx > 0 ? 1 : -1) * (c.reverse ? -1 : 1);
  const turn = def.turn * dt;
  c.face += clamp(c.faceWant - c.face, -turn, turn);
  const speed = Math.hypot(c.vx, c.vy);
  if (!c.pitchLock && speed > 3) {
    let p = Math.atan2(-c.vy, Math.abs(c.vx));
    if (c.reverse) p = -p;
    p = clamp(p, -def.maxPitch, def.maxPitch);
    c.pitch += angleDiff(c.pitch, p) * Math.min(1, dt * 2.2);
  }
  c.phase += dt * (def.beat[0] + speed * def.beat[1]);
  if (!def.seabed) {
    const floor = w.floorAt(c.x) - c.L * 0.16 - 8;
    if (c.y > floor) {
      c.y = floor;
      if (c.vy > 0) c.vy = 0;
    }
    if (c.y < 8) {
      c.y = 8;
      if (c.vy < 0) c.vy = 0;
    }
  }
}

export function respawn(c: Creature, w: World) {
  const def = DEFS[c.kind];
  Object.assign(c, { alive: true, state: "", stateT: 0, open: 0, aux: 0, camo: 0, target: null, hunger: 0.3, reverse: false });
  def.spawn(c, w, c.slot);
  if (!def.seabed) {
    // Swim back in from the side.
    c.dir = Math.random() < 0.5 ? 1 : -1;
    c.x = c.dir > 0 ? -c.L * 0.5 : w.width + c.L * 0.5;
    c.face = c.faceWant = c.dir;
    c.vx = c.dir * 20;
  }
}

// ── steering helpers ───────────────────────────────────────────────────

function go(c: Creature, state: string) {
  if (c.state !== state) {
    c.state = state;
    c.stateT = 0;
    c.timer = 0;
  }
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);
const fwdX = (c: Creature) => (c.face >= 0 ? 1 : -1) * Math.cos(c.pitch);
const fwdY = (c: Creature) => -Math.sin(c.pitch);
export const headX = (c: Creature) => c.x + fwdX(c) * c.L * 0.45;
export const headY = (c: Creature) => c.y + fwdY(c) * c.L * 0.45;

function seek(c: Creature, x: number, y: number, speed: number) {
  const dx = x - c.x;
  const dy = y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  const v = speed * Math.min(1, d / 40);
  c.dvx = (dx / d) * v;
  c.dvy = (dy / d) * v;
  return d;
}

function flee(c: Creature, x: number, y: number, speed: number) {
  const dx = c.x - x;
  const dy = c.y - y;
  const d = Math.hypot(dx, dy) || 1;
  c.dvx = (dx / d) * speed;
  c.dvy = (dy / d) * speed * 0.6;
  c.dir = dx > 0 ? 1 : -1;
}

/** Level cruising with a slowly drifting climb/descent. */
function cruise(c: Creature, dt: number, speed: number, climb = 0.3) {
  c.wander = clamp(c.wander + (Math.random() - 0.5) * dt * 1.4, -1, 1);
  c.dvx = c.dir * speed * Math.cos(c.wander * climb);
  c.dvy = speed * Math.sin(c.wander * climb);
}

/** Turn back once well off-screen (so animals come and go), plus the odd spontaneous turn. */
function roam(c: Creature, w: World, margin: number, dt: number, flipPerSec = 0) {
  if (c.x < -margin) c.dir = 1;
  else if (c.x > w.width + margin) c.dir = -1;
  else if (Math.random() < flipPerSec * dt) c.dir = c.dir === 1 ? -1 : 1;
}

/** Soft depth band, as fractions of the water column. */
function band(c: Creature, w: World, top: number, bottom: number, k = 0.6) {
  const fl = w.floorAt(c.x);
  const y0 = top * fl;
  const y1 = bottom * fl;
  if (c.y < y0) c.dvy += (y0 - c.y) * k;
  else if (c.y > y1) c.dvy -= (c.y - y1) * k;
}

function near(w: World, c: Creature, kinds: Kind | Kind[], r: number): Creature | null {
  let best: Creature | null = null;
  let bestD = r;
  for (const o of w.creatures) {
    if (!o.alive || o === c || (typeof kinds === "string" ? o.kind !== kinds : !kinds.includes(o.kind))) continue;
    const d = dist(c.x, c.y, o.x, o.y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

const offscreen = (c: Creature, w: World) => !c.alive || c.x < 0 || c.x > w.width;

function leader(w: World, c: Creature) {
  let best = c;
  for (const o of w.creatures) if (o.alive && o.kind === c.kind && o.slot < best.slot) best = o;
  return best;
}

/** Hold a formation slot behind and beside the leader. */
function follow(c: Creature, lead: Creature, back: number, up: number, max: number) {
  const ld = lead.vx >= 0 ? 1 : -1;
  c.dvx = lead.vx + (lead.x - ld * back - c.x) * 0.8;
  c.dvy = lead.vy + (lead.y + up - c.y) * 0.8;
  const s = Math.hypot(c.dvx, c.dvy);
  if (s > max) {
    c.dvx *= max / s;
    c.dvy *= max / s;
  }
  c.dir = ld;
}

function separate(c: Creature, w: World, r: number, k: number) {
  for (const o of w.creatures) {
    if (o === c || !o.alive || o.kind !== c.kind) continue;
    const dx = c.x - o.x;
    const dy = c.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d < r && d > 1e-3) {
      c.dvx += (dx / d) * k * (1 - d / r);
      c.dvy += (dy / d) * k * (1 - d / r);
    }
  }
}

function swimSpawn(top: number, bottom: number) {
  return (c: Creature, w: World) => {
    c.x = rand(0.08, 0.92) * w.width;
    c.y = rand(top, bottom) * w.floorAt(c.x);
    c.dir = Math.random() < 0.5 ? 1 : -1;
    c.face = c.faceWant = c.dir;
    c.vx = c.dir * 10;
  };
}

/** Pod members start beside their leader. */
function podSpawn(top: number, bottom: number) {
  const solo = swimSpawn(top, bottom);
  return (c: Creature, w: World, i: number) => {
    const lead = w.creatures.find((o) => o.kind === c.kind && o.slot === 0);
    if (i === 0 || !lead) return solo(c, w);
    c.x = lead.x - lead.dir * c.L * 0.9 * i;
    c.y = lead.y + (i % 2 ? -1 : 1) * c.L * 0.3;
    c.dir = lead.dir;
    c.face = c.faceWant = c.dir;
  };
}

/** Screen position of a character in a creature's sprite (e.g. the anglerfish's lure). */
export function spriteSpot(c: Creature, w: World, rows: string[], ch: string) {
  const width = Math.max(...rows.map((r) => r.length));
  for (let r = 0; r < rows.length; r++) {
    const k = rows[r].indexOf(ch);
    if (k < 0) continue;
    const col = c.face < 0 ? width - 1 - k : k;
    return { x: c.x + (col + 0.5 - width / 2) * w.cw, y: c.y + (r + 0.5 - rows.length / 2) * w.ch };
  }
  return { x: c.x, y: c.y };
}

// ── shape helpers ──────────────────────────────────────────────────────

function hit(out: Shape, flag: number, shade: number) {
  out.flag = flag;
  out.shade = shade;
  return true;
}

/** Lit from the surface: the back is brighter than the belly. */
const lit = (w: number, top: number, bot: number) => 0.25 + 0.6 * clamp((w + bot) / (top + bot || 1), 0, 1);

/** Half-thickness profile: rounds up to `h` at `peak`, eases down to `hEnd` at `end`; −1 past it. */
function prof(s: number, peak: number, h: number, end: number, hEnd: number, nose: number) {
  if (s < 0 || s > end) return -1;
  if (s < peak) return h * Math.pow(Math.sin(((s / peak) * Math.PI) / 2), nose);
  const k = (s - peak) / (end - peak);
  return hEnd + (h - hEnd) * (0.5 + 0.5 * Math.cos(k * Math.PI));
}

/** Horizontal tail flukes seen edge-on: a wedge widening to the tips. */
function flukes(s: number, w: number, start: number, span: number) {
  if (s < start || s > 1) return false;
  return Math.abs(w) < 0.012 + span * ((s - start) / (1 - start));
}

interface FishBody {
  thick: number;
  nose: number;
  peak: number;
  bill?: number;
  dorsal: [number, number, number, number];
  pect: [number, number, number, number];
  up: [number, number];
  low: [number, number];
  eye: [number, number, number];
  belly: number;
}

/** Sharks and swordfish: torpedo body, dorsal, pectoral, crescent tail, white belly. */
function fishShape(p: FishBody) {
  const b0 = p.bill ?? 0;
  return (s: number, w: number, c: Creature, _t: number, out: Shape) => {
    if (s < 0 || s > 1.02) return false;
    if (s < b0) {
      // Swordfish bill: long, flat, a little below the body axis.
      return Math.abs(w + 0.004) < 0.006 + 0.008 * (s / b0) ? hit(out, F_BODY, 0.8) : false;
    }
    const h = prof((s - b0) / (1 - b0), p.peak, p.thick, 0.86, 0.016, p.nose);
    const top = h;
    const bot = h * 0.92;
    if (h > 0 && w <= top && w >= -bot) {
      if (Math.abs(s - p.eye[0]) < p.eye[2] && Math.abs(w - p.eye[1]) < p.eye[2] * 1.2) return hit(out, F_EYE, 0);
      if (c.open > 0.05 && s < p.eye[0] + 0.07 && w < -bot * 0.15 && w > -bot * 0.15 - c.open * 0.06) return hit(out, F_MOUTH, 0);
      if (w < -bot * p.belly) return hit(out, F_PALE, 0.7);
      return hit(out, F_BODY, lit(w, top, bot));
    }
    const flex = 1 + 0.12 * Math.sin(c.phase);
    const [d0, d1, dt, dw] = p.dorsal;
    if (tri(s, w, d0, 0.02, d1, 0.02, dt, dw)) return hit(out, F_FIN, 0.62);
    const [q0, q1, qt, qw] = p.pect;
    if (tri(s, w, q0, -0.02, q1, -0.02, qt, qw)) return hit(out, F_FIN, 0.38);
    if (tri(s, w, 0.83, 0.012, 0.9, -0.004, p.up[0], p.up[1] * flex)) return hit(out, F_FIN, 0.5);
    if (tri(s, w, 0.83, -0.012, 0.9, 0.004, p.low[0], p.low[1] * flex)) return hit(out, F_FIN, 0.4);
    if (s > 0.83 && s < 0.92 && Math.abs(w) < 0.016) return hit(out, F_BODY, 0.5);
    return false;
  };
}

// ── the cast ───────────────────────────────────────────────────────────

export const DEFS: Record<Kind, Def> = {
  // Sperm whale: deep-diving squid hunter. Clicks to echolocate (clicks speed up into a
  // "creak" as it closes in), and sleeps hanging vertically near the surface.
  sperm: {
    name: "Sperm whale", count: 1, size: (m) => Math.max(320, m * 0.6), depth: [0.62, 0.72],
    maxPitch: 1.2, turn: 0.7, beat: [0.6, 0.012], bend: 0.025, fear: 0.25,
    ext: [-0.02, 1.02, 0.18], tint: [150, 140, 136],
    spawn: (c, w) => {
      swimSpawn(0.25, 0.45)(c, w);
      go(c, "cruising");
    },
    think(c, w, dt) {
      c.hunger = Math.min(1, c.hunger + dt * 0.012);
      c.accel = 0.6;
      c.pitchLock = c.state === "drift-sleeping upright";
      c.open = Math.max(0, c.open - dt * 0.5);
      roam(c, w, c.L * 0.7, dt);
      switch (c.state) {
        case "diving to hunt squid": {
          const sq = near(w, c, "squid", w.width * 1.5);
          const hx = headX(c);
          const hy = headY(c);
          let d = Infinity;
          if (sq) {
            seek(c, sq.x, sq.y, 46);
            d = dist(hx, hy, sq.x, sq.y);
          } else {
            c.dvx = c.dir * 30;
            c.dvy = (w.floorAt(c.x) * 0.8 - c.y) * 0.3;
          }
          c.timer -= dt;
          if (c.timer <= 0) {
            c.timer = d < 350 ? 0.22 : 0.8;
            w.emit("click", hx, hy);
          }
          if (d < c.L * 0.6) c.open = Math.min(1, c.open + dt * 2);
          if (sq && d < c.L * 0.2) {
            if (Math.random() < 0.4) {
              w.kill(sq, 30);
              w.emit("eat", sq.x, sq.y);
              c.hunger = 0;
            } else {
              go(sq, "jetting away, inked");
              w.ink(sq.x, sq.y);
            }
            go(c, "surfacing to breathe");
          }
          if (c.stateT > 35) go(c, "surfacing to breathe");
          break;
        }
        case "surfacing to breathe":
          c.dvx = c.dir * 22;
          c.dvy = -28;
          if (c.y < w.floorAt(c.x) * 0.22 || c.stateT > 18) go(c, "cruising");
          break;
        case "drift-sleeping upright":
          c.pitch += (1.45 - c.pitch) * Math.min(1, dt * 0.4);
          c.dvx = 0;
          c.dvy = Math.sin(c.stateT * 0.3) * 3;
          c.accel = 0.3;
          if (c.stateT > 20) go(c, "cruising");
          break;
        default:
          go(c, "cruising");
          cruise(c, dt, 26, 0.15);
          band(c, w, 0.18, 0.5);
          if (c.stateT > 22) go(c, c.hunger > 0.45 ? "diving to hunt squid" : "drift-sleeping upright");
      }
    },
    shape(s, w, c, _t, out) {
      if (s < 0 || s > 1) return false;
      let top: number;
      let bot: number;
      if (s < 0.36) {
        // The huge square head, with corners rounded off.
        const r = Math.min(1, Math.sqrt(s / 0.035));
        top = 0.12 * r;
        bot = 0.065 * r;
        // Narrow underslung lower jaw; it drops open on the strike.
        if (s > 0.05 && s < 0.34) {
          const jaw = -0.065 - c.open * 0.12 * ((0.34 - s) / 0.29);
          if (w < -0.065 && w > jaw) return hit(out, F_MOUTH, 0);
          if (w <= jaw && w > jaw - 0.024) return hit(out, F_PALE, 0.5);
        }
      } else {
        const h = prof(s, 0.36, 0.11, 0.87, 0.017, 1);
        top = h;
        bot = h * 0.85;
      }
      if (top > 0 && w <= top && w >= -bot) {
        if (Math.abs(s - 0.32) < 0.008 && Math.abs(w + 0.035) < 0.01) return hit(out, F_EYE, 0);
        if (s > 0.38 && hash3(Math.floor(s * 45), Math.floor(w * 35), c.id) < 0.14) return hit(out, F_MARK, 0.3);
        return hit(out, F_BODY, lit(w, top, bot));
      }
      if (tri(s, w, 0.58, 0.05, 0.7, 0.04, 0.64, 0.085)) return hit(out, F_FIN, 0.5);
      if (s > 0.7 && s < 0.84 && w > 0 && w < 0.03 + 0.012 * Math.sin(s * 140)) return hit(out, F_FIN, 0.45);
      if (tri(s, w, 0.33, -0.06, 0.38, -0.06, 0.41, -0.13)) return hit(out, F_FIN, 0.4);
      if (flukes(s, w, 0.85, 0.07)) return hit(out, F_FIN, 0.45);
      return false;
    },
  },

  // Humpback: slow glider and singer. Hunts cooperatively-famous style: dives under a
  // school, spirals up blowing a ring of bubbles that traps it, then lunges up through
  // the middle, throat pleats ballooning.
  humpback: {
    name: "Humpback whale", count: 1, size: (m) => Math.max(300, m * 0.56), depth: [0.64, 0.74],
    maxPitch: 1.3, turn: 0.8, beat: [0.6, 0.012], bend: 0.028, fear: 0.25,
    ext: [-0.02, 1.02, 0.4], tint: [120, 140, 170], pale: [215, 225, 235],
    spawn: (c, w) => {
      swimSpawn(0.2, 0.35)(c, w);
      go(c, "cruising");
    },
    think(c, w, dt) {
      c.hunger = Math.min(1, c.hunger + dt * 0.014);
      c.accel = 0.6;
      if (c.state !== "lunge feeding") c.open = Math.max(0, c.open - dt * 0.4);
      switch (c.state) {
        case "singing":
          cruise(c, dt, 12, 0.1);
          band(c, w, 0.12, 0.42);
          roam(c, w, c.L * 0.8, dt);
          c.timer -= dt;
          if (c.timer <= 0) {
            c.timer = 2.4;
            w.emit("song", c.x, c.y);
          }
          if (c.stateT > 16) go(c, "cruising");
          break;
        case "diving under a school": {
          c.timer -= dt;
          if (c.timer <= 0) {
            c.timer = 1;
            const sc = w.school(c.tx, c.ty, 260, null);
            if (sc.n > 6) {
              c.tx = sc.x;
              c.ty = sc.y;
            }
          }
          const R = c.L * 0.3;
          if (seek(c, c.tx, c.ty + R, 45) < 70) {
            c.aux = HALF_PI;
            go(c, "blowing a bubble net");
          }
          if (c.stateT > 25) go(c, "cruising");
          break;
        }
        case "blowing a bubble net": {
          const R = c.L * 0.3;
          c.aux += dt * 0.6 * c.dir;
          seek(c, c.tx + Math.cos(c.aux) * R, c.ty + Math.sin(c.aux) * R * 0.7, 95);
          c.accel = 1.5;
          c.timer -= dt;
          if (c.timer <= 0) {
            c.timer = 0.07;
            w.bubble(headX(c), headY(c));
          }
          w.herds.push({ x: c.tx, y: c.ty, r: R * 1.3 });
          if (c.stateT > TAU / 0.6) go(c, "lunge feeding");
          break;
        }
        case "lunge feeding":
          seek(c, c.tx, c.ty - c.L * 0.5, 120);
          c.accel = 2;
          c.open = Math.min(1, c.open + dt * 1.5);
          w.herds.push({ x: c.tx, y: c.ty, r: c.L * 0.3 });
          if (w.eatFish(headX(c), headY(c), c.L * 0.14, 6, null) > 0) c.hunger = Math.max(0, c.hunger - 0.08);
          if (c.stateT > 3.5) {
            c.hunger = 0;
            go(c, "cruising");
          }
          break;
        default:
          go(c, "cruising");
          cruise(c, dt, 24, 0.15);
          band(c, w, 0.12, 0.42);
          roam(c, w, c.L * 0.8, dt);
          if (c.stateT > 10 && Math.random() < dt * 0.04) go(c, "singing");
          c.timer -= dt;
          if (c.hunger > 0.5 && c.timer <= 0) {
            c.timer = 2;
            const sc = w.school(c.x, c.y, w.width * 0.6, null);
            if (sc.n > 14) {
              c.tx = sc.x;
              c.ty = sc.y;
              go(c, "diving under a school");
            }
          }
      }
    },
    shape(s, w, c, _t, out) {
      if (s < 0 || s > 1) return false;
      const h = prof(s, 0.3, 0.11, 0.87, 0.018, 0.35);
      if (h > 0) {
        const top = h * 0.9;
        const bot = h * 1.05 + (s < 0.48 ? c.open * 0.1 * Math.sin((Math.PI * s) / 0.48) : 0);
        if (w <= top && w >= -bot) {
          const mouth = 0.02 - s * 0.12;
          if (s < 0.28 && c.open > 0.05 && w < mouth && w > mouth - c.open * 0.07 * (1 - s / 0.28)) return hit(out, F_MOUTH, 0);
          if (Math.abs(s - 0.27) < 0.009 && Math.abs(w + 0.035) < 0.012) return hit(out, F_EYE, 0);
          if (s < 0.24 && w > top - 0.022 && Math.floor(s * 70) % 3 === 0) return hit(out, F_MARK, 0.3);
          if (s > 0.03 && s < 0.5 && w < mouth - 0.03 && w < -bot * 0.3) return hit(out, F_PALE, Math.floor(w * 90) % 2 ? 0.75 : 0.45);
          return hit(out, F_BODY, lit(w, top, bot));
        }
      }
      // Long white pectoral flippers, a third of the body.
      if (tri(s, w, 0.24, -0.05, 0.32, -0.06, 0.58, -0.34 + 0.03 * Math.sin(c.phase * 0.5))) return hit(out, F_PALE, 0.85);
      if (tri(s, w, 0.6, 0.05, 0.69, 0.04, 0.67, 0.085)) return hit(out, F_FIN, 0.5);
      if (flukes(s, w, 0.85, 0.08)) return hit(out, F_FIN, 0.45);
      return false;
    },
  },

  // Orca pod: travels in formation; hunts by "carousel feeding" — circling a school to
  // pack it into a tight ball, then taking turns tail-slapping into it.
  orca: {
    name: "Orca", count: 3, size: (m) => Math.max(140, m * 0.3), depth: [0.8, 0.9],
    maxPitch: 0.9, turn: 1.6, beat: [1.2, 0.02], bend: 0.03, fear: 0.7,
    ext: [-0.02, 1.02, 0.36], tint: [52, 56, 66], pale: [228, 232, 238],
    spawn: (c, w, i) => {
      podSpawn(0.25, 0.5)(c, w, i);
      go(c, "traveling as a pod");
    },
    think(c, w, dt) {
      const lead = leader(w, c);
      c.accel = 1.2;
      if (lead === c) {
        c.hunger = Math.min(1, c.hunger + dt * 0.02);
        c.modeT += dt;
        c.timer -= dt;
        if (c.mode === 0) {
          if (c.hunger > 0.5 && c.timer <= 0) {
            c.timer = 2;
            const sc = w.school(c.x, c.y, w.width * 0.7, false);
            if (sc.n > 15) {
              c.tx = sc.x;
              c.ty = sc.y;
              c.mode = 1;
              c.modeT = 0;
            }
          }
        } else {
          if (c.timer <= 0) {
            c.timer = 1.5;
            const sc = w.school(c.tx, c.ty, 300, false);
            if (sc.n > 4) {
              c.tx = sc.x;
              c.ty = sc.y;
            } else c.modeT = 99;
          }
          if (c.modeT > 22) {
            c.hunger = 0;
            c.mode = 0;
          }
        }
      }
      if (lead.mode === 0) {
        go(c, "traveling as a pod");
        if (lead === c) {
          cruise(c, dt, 55, 0.25);
          band(c, w, 0.15, 0.6);
          roam(c, w, c.L, dt);
        } else follow(c, lead, c.L * 0.9 * c.slot, (c.slot % 2 ? -1 : 1) * c.L * 0.3, 90);
      } else if (c.state === "tail-slapping the bait ball") {
        c.accel = 3;
        if (seek(c, lead.tx, lead.ty, 150) < 40 || c.stateT > 3) {
          w.emit("slap", lead.tx, lead.ty);
          w.eatFish(lead.tx, lead.ty, 70, 5, false);
          go(c, "carousel herding");
        }
      } else {
        go(c, "carousel herding");
        const R = 150;
        const a = w.time * 0.9 + (c.slot * TAU) / 3;
        seek(c, lead.tx + Math.cos(a) * R, lead.ty + Math.sin(a) * R * 0.7, 110);
        w.herds.push({ x: lead.tx, y: lead.ty, r: R * 1.4 });
        if (c.stateT > 5 && Math.random() < dt * 0.12) go(c, "tail-slapping the bait ball");
      }
      separate(c, w, c.L * 0.5, 50);
    },
    shape(s, w, c, _t, out) {
      if (s < 0 || s > 1) return false;
      const h = prof(s, 0.3, 0.125, 0.87, 0.02, 0.45);
      if (h > 0 && w <= h && w >= -h) {
        if (Math.abs(s - 0.12) < 0.01 && Math.abs(w) < 0.012) return hit(out, F_EYE, 0);
        const patch = ((s - 0.17) / 0.06) ** 2 + ((w - 0.035) / 0.022) ** 2 < 1;
        const belly = w < -h * 0.35 && s < 0.6;
        const flank = s > 0.48 && s < 0.68 && w < -0.05 + (s - 0.48) * 0.5 && w > -h * 0.9;
        if (patch || belly || flank) return hit(out, F_PALE, 0.9);
        if (s > 0.47 && s < 0.6 && w > h * 0.55) return hit(out, F_BODY, 0.8); // grey saddle
        return hit(out, F_BODY, lit(w, h, h) * 0.6);
      }
      // Bull's tall straight dorsal; the cows' are shorter and curved.
      const tall = c.slot === 0;
      if (tri(s, w, 0.38, 0.07, 0.5, 0.06, tall ? 0.42 : 0.5, tall ? 0.34 : 0.2)) return hit(out, F_FIN, 0.4);
      if (tri(s, w, 0.2, -0.07, 0.3, -0.07, 0.3, -0.22)) return hit(out, F_FIN, 0.3);
      if (flukes(s, w, 0.85, 0.07)) return hit(out, F_FIN, 0.35);
      return false;
    },
  },

  // Dolphin pod: porpoises along, rides the bow wave of passing whales, gets curious about
  // the cursor, and herds fish to hunt.
  dolphin: {
    name: "Bottlenose dolphin", count: 4, size: (m) => Math.max(90, m * 0.18), depth: [0.86, 1],
    maxPitch: 0.8, turn: 2.6, beat: [1.6, 0.03], bend: 0.035, fear: 0.8,
    ext: [-0.02, 1.02, 0.24], tint: [150, 165, 185], pale: [215, 222, 232],
    spawn: (c, w, i) => {
      podSpawn(0.15, 0.4)(c, w, i);
      go(c, "porpoising along");
    },
    think(c, w, dt) {
      const lead = leader(w, c);
      c.accel = 1.5;
      if (lead === c) {
        c.hunger = Math.min(1, c.hunger + dt * 0.03);
        c.modeT += dt;
        c.timer -= dt;
        const p = w.pointer;
        if (c.mode !== 1 && c.timer <= 0 && p.active && dist(c.x, c.y, p.x, p.y) < 450) {
          c.mode = 1;
          c.modeT = 0;
        } else if (c.mode === 1 && (!p.active || c.modeT > 14)) {
          c.mode = 0;
          c.modeT = 0;
          c.timer = 8;
        } else if (c.mode === 0 && c.modeT > 6) {
          const whale = near(w, c, ["humpback", "sperm"], 700);
          if (whale && !offscreen(whale, w) && whale.state !== "drift-sleeping upright" && Math.random() < dt * 0.3) {
            c.mode = 2;
            c.modeT = 0;
            c.target = whale;
          } else if (c.hunger > 0.6) {
            const sc = w.school(c.x, c.y, 600, false);
            if (sc.n > 8) {
              c.tx = sc.x;
              c.ty = sc.y;
              c.mode = 3;
              c.modeT = 0;
            }
          }
        } else if ((c.mode === 2 && (c.modeT > 15 || offscreen(c.target as Creature, w))) || (c.mode === 3 && c.modeT > 10)) {
          if (c.mode === 3) c.hunger = 0.1;
          c.mode = 0;
          c.modeT = 0;
        }
      }
      const n = w.creatures.filter((o) => o.kind === "dolphin").length;
      if (lead.mode === 1) {
        go(c, "playing with you (curious)");
        const p = w.pointer;
        const a = w.time * 1.4 + (c.slot * TAU) / n;
        const R = 90 + c.slot * 22;
        seek(c, p.x + Math.cos(a) * R, p.y + Math.sin(a) * R * 0.6, 140);
      } else if (lead.mode === 2 && lead.target) {
        go(c, "bow-riding the whale");
        const wh = lead.target as Creature;
        const fx = fwdX(wh);
        const tx = headX(wh) + fx * (c.L * 0.4 + c.slot * c.L * 0.6);
        const ty = headY(wh) + 30 - c.slot * 18;
        c.dvx = wh.vx + (tx - c.x) * 1.2;
        c.dvy = wh.vy + (ty - c.y) * 1.2;
      } else if (lead.mode === 3) {
        go(c, "herding fish to hunt");
        if (lead === c && c.timer <= 0) {
          c.timer = 1;
          const sc = w.school(c.tx, c.ty, 250, false);
          if (sc.n > 3) {
            c.tx = sc.x;
            c.ty = sc.y;
          }
        }
        const a = (c.slot * TAU) / n + w.time * 0.7;
        seek(c, lead.tx + Math.cos(a) * 80, lead.ty + Math.sin(a) * 60, 120);
        if (w.eatFish(headX(c), headY(c), 14, 1, false)) c.hunger = Math.max(0, c.hunger - 0.2);
      } else {
        go(c, "porpoising along");
        if (lead === c) {
          cruise(c, dt, 85, 0.2);
          band(c, w, 0.1, 0.55);
          roam(c, w, c.L * 2, dt);
        } else follow(c, lead, c.L * 1.1 * c.slot, (c.slot % 2 ? -1 : 1) * c.L * 0.5, 140);
        c.dvy += Math.sin(w.time * 2 + c.slot) * 55;
      }
      separate(c, w, c.L * 0.7, 60);
    },
    shape(s, w, _c, _t, out) {
      if (s < 0 || s > 1) return false;
      if (s < 0.07) return Math.abs(w + 0.018) < 0.016 + 0.012 * (s / 0.07) ? hit(out, w < -0.022 ? F_PALE : F_BODY, 0.6) : false;
      const h = prof((s - 0.05) / 0.95, 0.33, 0.1, 0.88, 0.016, 0.6);
      if (h > 0) {
        const top = h + (s < 0.2 ? 0.025 * Math.sin((Math.PI * (s - 0.05)) / 0.15) : 0); // melon
        const bot = h * 0.95;
        if (w <= top && w >= -bot) {
          if (Math.abs(s - 0.13) < 0.012 && Math.abs(w + 0.01) < 0.014) return hit(out, F_EYE, 0);
          if (w < -bot * 0.3) return hit(out, F_PALE, 0.8);
          return hit(out, F_BODY, lit(w, top, bot));
        }
      }
      if (tri(s, w, 0.4, 0.05, 0.55, 0.04, 0.56, 0.2)) return hit(out, F_FIN, 0.55);
      if (tri(s, w, 0.22, -0.05, 0.29, -0.05, 0.34, -0.16)) return hit(out, F_FIN, 0.4);
      if (flukes(s, w, 0.86, 0.06)) return hit(out, F_FIN, 0.45);
      return false;
    },
  },

  // Great white: patrols, stalks prey from below, then bursts up in an ambush strike.
  // Clears out when orcas show up (they do, in the wild).
  white: {
    name: "Great white shark", count: 1, size: (m) => Math.max(150, m * 0.29), depth: [0.86, 0.95],
    maxPitch: 0.9, turn: 1.4, beat: [2, 0.04], bend: 0, fear: 0.6,
    ext: [-0.02, 1.02, 0.24], tint: [150, 160, 176], pale: [222, 226, 232],
    spawn: (c, w) => {
      swimSpawn(0.35, 0.7)(c, w);
      go(c, "patrolling");
    },
    think(c, w, dt) {
      c.hunger = Math.min(1, c.hunger + dt * 0.03);
      c.accel = 1;
      c.open = Math.max(0, c.open - dt * 1.5);
      const orca = near(w, c, "orca", 480);
      if (orca) {
        go(c, "fleeing orcas!");
        flee(c, orca.x, orca.y, 130);
        c.accel = 2;
        return;
      }
      switch (c.state) {
        case "stalking from below": {
          const f = c.target as Fish | null;
          if (!f || !f.alive || c.stateT > 14) {
            go(c, "patrolling");
            break;
          }
          const d = seek(c, f.x, f.y + 110, 46);
          if (d < 70 || (Math.abs(c.x - f.x) < 60 && c.y > f.y + 50)) go(c, "ambush strike from below");
          break;
        }
        case "ambush strike from below": {
          const f = c.target as Fish | null;
          if (f && f.alive) seek(c, f.x + f.vx * 0.3, f.y + f.vy * 0.3, 175);
          c.accel = 3;
          c.open = Math.min(1, c.open + dt * 4);
          if (w.eatFish(headX(c), headY(c), 20, 2, false)) c.hunger = Math.max(0, c.hunger - 0.35);
          if (c.stateT > 2.2) go(c, "patrolling");
          break;
        }
        default:
          go(c, "patrolling");
          cruise(c, dt, 38, 0.3);
          band(c, w, 0.25, 0.8);
          roam(c, w, c.L * 0.4, dt, 0.02);
          c.timer -= dt;
          if (c.hunger > 0.45 && c.timer <= 0) {
            c.timer = 1;
            const f = w.prey(c.x, c.y, 520, false);
            if (f) {
              c.target = f;
              go(c, "stalking from below");
            }
          }
      }
    },
    shape: fishShape({
      thick: 0.105, nose: 0.55, peak: 0.22,
      dorsal: [0.36, 0.5, 0.46, 0.22], pect: [0.22, 0.32, 0.37, -0.21],
      up: [1, 0.19], low: [0.97, -0.15], eye: [0.075, 0.03, 0.012], belly: 0.2,
    }),
  },

  // Hammerheads: school in loose groups by day, then sweep the seabed with their wide
  // heads, scanning for prey buried in the sand by its electric field.
  hammer: {
    name: "Hammerhead shark", count: 2, size: (m) => Math.max(150, m * 0.3), depth: [0.76, 0.86],
    maxPitch: 0.8, turn: 1.6, beat: [2, 0.04], bend: 0, fear: 0.6,
    ext: [-0.02, 1.02, 0.28], tint: [150, 150, 136], pale: [215, 215, 205],
    spawn: (c, w, i) => {
      podSpawn(0.35, 0.6)(c, w, i);
      go(c, "schooling");
    },
    think(c, w, dt) {
      c.accel = 1;
      c.pitchLock = false;
      const orca = near(w, c, "orca", 450);
      if (orca) {
        go(c, "fleeing orcas!");
        flee(c, orca.x, orca.y, 130);
        return;
      }
      const lead = leader(w, c);
      if (lead === c) {
        c.modeT += dt;
        if (c.modeT > (c.mode ? 16 : 22)) {
          c.mode = c.mode ? 0 : 1;
          c.modeT = 0;
        }
      }
      if (lead.mode === 0) {
        go(c, "schooling");
        if (lead === c) {
          cruise(c, dt, 40, 0.25);
          band(c, w, 0.25, 0.6);
          roam(c, w, c.L * 0.5, dt);
        } else follow(c, lead, c.L * 0.8, -c.L * 0.25, 70);
      } else {
        go(c, "scanning the seabed (electroreception)");
        if (lead === c) {
          c.dvx = c.dir * 34;
          roam(c, w, c.L * 0.5, dt);
        } else c.dvx = lead.vx + (lead.x - (lead.vx >= 0 ? 1 : -1) * c.L * 1.2 - c.x) * 0.5;
        c.dvy = (w.floorAt(c.x) - c.L * 0.22 - 10 - c.y) * 0.8;
        // Head sweeping side to side like a metal detector.
        c.pitchLock = true;
        c.pitch = 0.18 * Math.sin(w.time * 2.6 + c.slot);
        w.eatFish(headX(c), headY(c), 16, 1, false);
      }
    },
    shape: fishShape({
      thick: 0.085, nose: 0.25, peak: 0.2,
      dorsal: [0.3, 0.42, 0.4, 0.27], pect: [0.2, 0.29, 0.33, -0.17],
      up: [1, 0.22], low: [0.95, -0.1], eye: [0.012, 0, 0.014], belly: 0.3,
    }),
  },

  // Swordfish: deep by day, rises to feed at night; slashes through schools with its bill
  // to stun fish, then circles back to pick them up.
  sword: {
    name: "Swordfish", count: 1, size: (m) => Math.max(140, m * 0.27), depth: [0.8, 0.9],
    maxPitch: 0.8, turn: 1.8, beat: [2.2, 0.04], bend: 0, fear: 0.6,
    ext: [-0.02, 1.02, 0.22], tint: [120, 110, 160], pale: [210, 215, 228],
    spawn: (c, w) => {
      swimSpawn(0.6, 0.8)(c, w);
      go(c, "resting in the deep by day");
    },
    think(c, w, dt) {
      c.hunger = Math.min(1, c.hunger + dt * 0.025);
      c.accel = 1.2;
      c.pitchLock = false;
      const night = w.night;
      const idle = night > 0.5 ? "feeding near the surface at night" : "resting in the deep by day";
      switch (c.state) {
        case "slashing through a school": {
          c.accel = 3;
          if (seek(c, c.tx, c.ty, 210) < 90) {
            c.pitchLock = true;
            c.pitch = 0.35 * Math.sin(w.time * 14);
            if (w.eatFish(headX(c), headY(c), 26, 3, false)) c.hunger = 0;
          }
          if (c.stateT > 3) go(c, "circling back for stunned fish");
          break;
        }
        case "circling back for stunned fish":
          seek(c, c.tx, c.ty, 60);
          w.eatFish(headX(c), headY(c), 18, 1, false);
          if (c.stateT > 4) go(c, idle);
          break;
        default: {
          go(c, idle);
          cruise(c, dt, 50, 0.25);
          roam(c, w, c.L * 0.5, dt);
          const top = 0.66 - 0.48 * night;
          band(c, w, top, top + 0.2);
          c.timer -= dt;
          if (c.hunger > 0.4 && c.timer <= 0) {
            c.timer = 1.5;
            const sc = w.school(c.x, c.y, 450, false);
            if (sc.n > 8) {
              c.tx = sc.x;
              c.ty = sc.y;
              go(c, "slashing through a school");
            }
          }
        }
      }
    },
    shape: fishShape({
      thick: 0.085, nose: 0.5, peak: 0.3, bill: 0.27,
      dorsal: [0.3, 0.4, 0.33, 0.21], pect: [0.36, 0.42, 0.46, -0.12],
      up: [1, 0.2], low: [1, -0.2], eye: [0.3, 0.015, 0.014], belly: 0.1,
    }),
  },

  // Manta ray: glides on slow wingbeats; over a krill swarm it somersaults, looping
  // backwards again and again through the food.
  manta: {
    name: "Manta ray", count: 1, size: (m) => Math.max(130, m * 0.25), depth: [0.76, 0.86],
    maxPitch: 0.7, turn: 1, beat: [1.4, 0.01], bend: 0, fear: 0.2,
    ext: [-0.02, 1.02, 0.36], tint: [70, 76, 92], pale: [220, 225, 232],
    spawn: (c, w) => {
      swimSpawn(0.2, 0.5)(c, w);
      go(c, "gliding");
    },
    think(c, w, dt) {
      c.accel = 0.8;
      if (c.state === "somersault feeding on krill") {
        c.pitchLock = c.faceLock = true;
        c.pitch += dt * 1.8;
        c.dvx = fwdX(c) * 40 + (c.tx - c.x) * 0.15;
        c.dvy = fwdY(c) * 40 + (c.ty - c.y) * 0.15;
        w.eatFish(headX(c), headY(c), 34, 2, true);
        c.timer -= dt;
        if (c.timer <= 0) {
          c.timer = 2;
          const sc = w.school(c.tx, c.ty, 200, true);
          if (sc.n > 3) {
            c.tx = sc.x;
            c.ty = sc.y;
          } else c.stateT = 99;
        }
        if (c.stateT > 14) {
          c.pitch = Math.atan2(Math.sin(c.pitch), Math.cos(c.pitch));
          c.pitchLock = c.faceLock = false;
          go(c, "gliding");
        }
        return;
      }
      go(c, "gliding");
      cruise(c, dt, 30, 0.25);
      band(c, w, 0.15, 0.6);
      roam(c, w, c.L * 0.6, dt);
      c.timer -= dt;
      if (c.timer <= 0) {
        c.timer = 2;
        const sc = w.school(c.x, c.y, 500, true);
        if (sc.n > 10) {
          c.tx = sc.x;
          c.ty = sc.y;
          go(c, "somersault feeding on krill");
        }
      }
    },
    shape(s, w, c, _t, out) {
      if (s < 0 || s > 1) return false;
      const flap = Math.sin(c.phase);
      if (Math.abs(s - 0.07) < 0.012 && Math.abs(w - 0.012) < 0.012) return hit(out, F_EYE, 0);
      if (s < 0.08 && tri(s, w, 0, -0.02, 0.07, -0.005, 0.07, -0.055)) return hit(out, F_FIN, 0.4); // cephalic fins
      if (s >= 0.04 && s <= 0.42) {
        const h = 0.04 * Math.sqrt(Math.sin((Math.PI * (s - 0.04)) / 0.38));
        if (Math.abs(w) <= h) return hit(out, w < -h * 0.2 ? F_PALE : F_BODY, lit(w, h, h));
      }
      // The near wing, swinging up and down; its white underside shows on the downstroke.
      if (tri(s, w, 0.06, 0, 0.4, 0, 0.22 - 0.04 * flap, 0.34 * flap)) return hit(out, flap < 0 ? F_PALE : F_BODY, 0.35 + 0.3 * Math.abs(flap));
      if (s > 0.42 && Math.abs(w) < 0.008) return hit(out, F_BODY, 0.4);
      return false;
    },
  },

  // Sea turtle: slow paddler, surfaces to breathe every minute or so, eats jellyfish.
  turtle: {
    name: "Sea turtle", count: 1, size: (m) => Math.max(100, m * 0.2), depth: [0.9, 1],
    maxPitch: 0.9, turn: 1.2, beat: [1.2, 0.02], bend: 0, fear: 0,
    ext: [-0.04, 0.96, 0.4], tint: [150, 140, 90], pale: [215, 200, 150],
    spawn: (c, w) => {
      swimSpawn(0.25, 0.6)(c, w);
      c.aux = rand(0.3, 1);
      go(c, "cruising");
    },
    think(c, w, dt) {
      c.accel = 0.7;
      c.aux = Math.max(0, c.aux - dt / 70);
      c.hunger = Math.min(1, c.hunger + dt * 0.02);
      switch (c.state) {
        case "surfacing to breathe":
          seek(c, c.x + c.dir * 50, 10, 28);
          if (c.y < 30) {
            c.aux = 1;
            for (let i = 0; i < 6; i++) w.bubble(headX(c), headY(c));
            go(c, "diving back down");
          }
          break;
        case "diving back down":
          c.dvx = c.dir * 20;
          c.dvy = 18;
          if (c.stateT > 7) go(c, "cruising");
          break;
        case "hunting jellyfish": {
          const j = c.target as Creature | null;
          if (!j || !j.alive || c.stateT > 20) {
            go(c, "cruising");
            break;
          }
          if (seek(c, j.x, j.y, 26) < c.L * 0.35) {
            w.kill(j, 25);
            w.emit("eat", j.x, j.y);
            c.hunger = 0;
            go(c, "munching a jellyfish");
          }
          break;
        }
        case "munching a jellyfish":
          c.dvx = c.dir * 5;
          c.dvy = 0;
          if (c.stateT > 3) go(c, "cruising");
          break;
        default:
          go(c, "cruising");
          cruise(c, dt, 20, 0.3);
          band(c, w, 0.2, 0.7);
          roam(c, w, c.L * 0.6, dt);
          if (c.aux < 0.12) go(c, "surfacing to breathe");
          else if (c.hunger > 0.5) {
            const j = near(w, c, "jelly", 500);
            if (j) {
              c.target = j;
              go(c, "hunting jellyfish");
            }
          }
      }
    },
    shape(s, w, c, _t, out) {
      if (s > 0.2 && s < 0.78) {
        const x = (s - 0.49) / 0.29;
        const top = 0.2 * Math.sqrt(Math.max(0, 1 - x * x));
        if (w <= top && w >= -0.035) {
          if (w < -0.012) return hit(out, F_PALE, 0.55); // plastron
          const seam = Math.abs(w - top * 0.5) < 0.01 || (w > 0 && Math.abs((((s - 0.2) * 9) % 1) - 0.5) > 0.44);
          return seam ? hit(out, F_MARK, 0.3) : hit(out, F_BODY, lit(w, top, 0.035));
        }
      }
      if (((s - 0.11) / 0.1) ** 2 + ((w - 0.005) / 0.045) ** 2 < 1) {
        if (((s - 0.065) / 0.016) ** 2 + ((w - 0.015) / 0.012) ** 2 < 1) return hit(out, F_EYE, 0);
        return hit(out, F_BODY, 0.55);
      }
      // Front flippers row like wings; small rear flippers steer.
      const th = 0.55 + 0.6 * Math.sin(c.phase);
      if (tri(s, w, 0.27, -0.02, 0.4, -0.02, 0.33 + 0.3 * Math.cos(th), -0.02 - 0.3 * Math.sin(th))) return hit(out, F_FIN, 0.5);
      if (tri(s, w, 0.74, -0.02, 0.8, -0.02, 0.9, -0.07)) return hit(out, F_FIN, 0.45);
      return false;
    },
  },

  // Giant squid: lurks deep, moves by jet pulses (mantle squeezes, water shoots out),
  // creeps up on prey arms-first and snaps out its two long tentacles. Inks and jets
  // when a sperm whale comes for it.
  squid: {
    name: "Giant squid", count: 1, size: (m) => Math.max(180, m * 0.38), depth: [0.8, 0.9],
    maxPitch: 1.2, turn: 2, beat: [1.4, 0.01], bend: 0, fear: 0.5,
    ext: [-0.02, 1.36, 0.16], tint: [200, 90, 80], pale: [240, 180, 170],
    spawn: (c, w) => {
      swimSpawn(0.6, 0.85)(c, w);
      go(c, "lurking in the deep");
    },
    think(c, w, dt) {
      c.hunger = Math.min(1, c.hunger + dt * 0.02);
      c.accel = 2;
      const inked = c.state === "jetting away, inked";
      const period = inked ? 0.7 : 1.6;
      c.home += dt;
      const ph = (c.home % period) / period;
      c.aux = ph < 0.3 ? Math.sin((ph / 0.3) * Math.PI) : 0;
      const whale = near(w, c, "sperm", 420);
      if (whale && !inked) {
        go(c, "jetting away, inked");
        w.ink(c.x, c.y);
      }
      switch (c.state) {
        case "jetting away, inked": {
          c.reverse = false;
          c.open = Math.max(0, c.open - dt * 3);
          const fx = whale ? whale.x : c.x - c.dir * 100;
          const fy = whale ? whale.y : c.y;
          const dx = c.x - fx;
          const dy = c.y - fy;
          const d = Math.hypot(dx, dy) || 1;
          const v = 30 + 170 * c.aux;
          c.dvx = (dx / d) * v;
          c.dvy = (dy / d) * v;
          if (!whale && c.stateT > 4) go(c, "lurking in the deep");
          break;
        }
        case "hunting (arms first)": {
          const f = c.target as Fish | null;
          c.reverse = true;
          if (!f || !f.alive || c.stateT > 10) {
            go(c, "lurking in the deep");
            break;
          }
          if (seek(c, f.x, f.y, 32) < c.L * 0.7) c.open = Math.min(1, c.open + dt * 5);
          // The tentacle clubs reach out ahead of the arms.
          const s = 0.98 + 0.35 * c.open;
          const tipX = c.x + fwdX(c) * (0.5 - s) * c.L;
          const tipY = c.y + fwdY(c) * (0.5 - s) * c.L;
          if (c.open > 0.6 && w.eatFish(tipX, tipY, 26, 1, false)) {
            c.hunger = 0;
            go(c, "lurking in the deep");
          }
          break;
        }
        default:
          go(c, "lurking in the deep");
          c.reverse = false;
          c.open = Math.max(0, c.open - dt * 2);
          roam(c, w, c.L * 0.5, dt, 0.03);
          c.wander = clamp(c.wander + (Math.random() - 0.5) * dt, -1, 1);
          c.dvx = c.dir * (10 + 70 * c.aux);
          c.dvy = c.wander * 10;
          band(c, w, 0.5, 0.88);
          if (c.hunger > 0.4 && Math.random() < dt) {
            const f = w.prey(c.x, c.y, 260, false);
            if (f) {
              c.target = f;
              go(c, "hunting (arms first)");
            }
          }
      }
    },
    shape(s, w, c, t, out) {
      if (s < 0 || s > 1 + c.open * 0.36) return false;
      if (s < 0.38) {
        const h = 0.085 * Math.pow(s / 0.38, 0.6) * (1 - 0.25 * c.aux);
        if (Math.abs(w) <= h) {
          const spot = hash3(Math.floor(s * 50), Math.floor(w * 40), Math.floor(t * 3)) < 0.1;
          return hit(out, spot ? F_MARK : F_BODY, lit(w, h, h));
        }
        if (s < 0.14 && Math.abs(w) < 0.1 * Math.sin((Math.PI * s) / 0.14) * (1 + 0.15 * Math.sin(c.phase * 2))) return hit(out, F_FIN, 0.45);
        return false;
      }
      if (s < 0.45) {
        if (((s - 0.41) / 0.022) ** 2 + ((w - 0.012) / 0.022) ** 2 < 1) return hit(out, F_EYE, 0);
        if (Math.abs(w) < 0.05) return hit(out, F_BODY, lit(w, 0.05, 0.05));
      }
      const k = (s - 0.44) / 0.32;
      if (k <= 1) {
        for (let a = 0; a < 4; a++) {
          const wa = (a - 1.5) * 0.02 * (1 + k * 1.5) + 0.014 * Math.sin(c.phase * 1.3 + s * 14 + a);
          if (Math.abs(w - wa) < 0.016 * (1 - k * 0.6)) return hit(out, F_BODY, 0.45);
        }
      }
      const end = 0.98 + c.open * 0.35;
      for (let a = 0; a < 2; a++) {
        const wa = (a ? 0.012 : -0.012) + 0.016 * Math.sin(c.phase + s * 9 + a * 2);
        if (s <= end && Math.abs(w - wa) < (s > end - 0.08 ? 0.02 : 0.009)) return hit(out, F_BODY, 0.5);
      }
      return false;
    },
  },

  // Octopus: crawls the seabed on its arms, forages, hunts crabs, camouflages when a
  // predator is near, and if one gets too close, blasts out ink and jets away.
  octopus: {
    name: "Octopus", count: 1, size: (m) => Math.max(110, m * 0.22), depth: [1, 1],
    maxPitch: 1.7, turn: 2, beat: [1, 0.02], bend: 0, fear: 0.2,
    ext: [-0.02, 1.02, 0.5], tint: [220, 100, 70], pale: [240, 190, 170], seabed: true,
    spawn: (c, w) => {
      const rock = w.rocks[w.rocks.length - 1];
      c.x = rock ? rock.x + rock.w * 0.6 : w.width * 0.3;
      c.y = w.floorAt(c.x) - c.L * 0.47;
      c.pitch = HALF_PI;
      c.dir = Math.random() < 0.5 ? 1 : -1;
      go(c, "crawling");
    },
    think(c, w, dt) {
      c.accel = 2;
      const floorY = w.floorAt(c.x) - c.L * 0.47;
      const threat = near(w, c, ["white", "hammer", "dolphin"], 300);
      const d = threat ? dist(c.x, c.y, threat.x, threat.y) : Infinity;
      const escaping = c.state === "jetting away (ink!)" || c.state === "settling back down";
      if (!escaping && d < 130) {
        go(c, "jetting away (ink!)");
        w.ink(c.x, c.y);
      }
      if (c.state !== "camouflaged") c.camo = Math.max(0, c.camo - dt * 0.6);
      switch (c.state) {
        case "jetting away (ink!)": {
          c.pitchLock = c.faceLock = false;
          c.open = Math.min(1, c.open + dt * 4);
          const away = threat ? Math.sign(c.x - threat.x) || 1 : c.dir;
          c.dvx = away * 110;
          c.dvy = -70;
          if (c.stateT > 1.4) go(c, "settling back down");
          break;
        }
        case "settling back down":
          c.open = Math.max(0, c.open - dt * 0.8);
          c.dvx = 0;
          c.dvy = 25;
          c.accel = 0.8;
          c.pitchLock = true;
          c.pitch += (HALF_PI - c.pitch) * Math.min(1, dt * 1.5);
          if (c.y >= floorY - 2) go(c, "crawling");
          break;
        case "camouflaged":
          c.dvx = 0;
          c.dvy = (floorY - c.y) * 3;
          c.camo = Math.min(1, c.camo + dt * 0.7);
          if (d > 300 && c.stateT > 4) go(c, "crawling");
          break;
        case "stalking a crab": {
          const crab = c.target as Creature | null;
          if (!crab || !crab.alive || c.stateT > 12) {
            go(c, "crawling");
            break;
          }
          c.dvx = Math.sign(crab.x - c.x) * 30;
          c.dvy = (floorY - c.y) * 3;
          if (Math.abs(crab.x - c.x) < c.L * 0.3) {
            w.kill(crab, 30);
            w.emit("eat", crab.x, crab.y);
            go(c, "eating a crab");
          }
          break;
        }
        default:
          c.pitchLock = c.faceLock = true;
          c.pitch = HALF_PI;
          c.face = c.faceWant = 1;
          c.open = Math.max(0, c.open - dt);
          c.dvy = (floorY - c.y) * 3;
          if (c.state === "crawling" || c.state === "") {
            go(c, "crawling");
            c.dvx = c.dir * 16 * (0.5 + 0.5 * Math.sin(w.time * 2.4));
            if (c.x < 60) c.dir = 1;
            else if (c.x > w.width - 60) c.dir = -1;
            if (d < 300) go(c, "camouflaged");
            else if (Math.random() < dt * 0.08) go(c, "foraging with its arms");
            else {
              const crab = near(w, c, "crab", 220);
              if (crab && crab.state !== "fleeing the octopus!") {
                c.target = crab;
                go(c, "stalking a crab");
              }
            }
          } else {
            c.dvx = 0;
            if (c.stateT > 5) go(c, "crawling");
          }
      }
    },
    shape(s, w, c, _t, out) {
      if (s < 0 || s > 1) return false;
      const st = c.open;
      const mw = 0.15 - 0.04 * st;
      if (((s - 0.2) / 0.2) ** 2 + (w / mw) ** 2 < 1) {
        if (hash3(Math.floor(s * 40), Math.floor(w * 40), c.id) < 0.18) return hit(out, F_MARK, 0.3);
        return hit(out, F_BODY, lit(w, mw, mw));
      }
      if (s > 0.34 && s < 0.46 && Math.abs(w) < 0.09) {
        if (((s - 0.4) / 0.02) ** 2 + ((w - 0.05) / 0.02) ** 2 < 1) return hit(out, F_EYE, 0);
        return hit(out, F_BODY, 0.5);
      }
      if (s >= 0.42) {
        // Five of the eight arms show from the side; splayed when crawling, trailing when jetting.
        const k = (s - 0.42) / 0.58;
        for (let a = 0; a < 5; a++) {
          const base = (a - 2) * 0.05 * (1 - st * 0.75);
          const wa = base * (1 + k * 4.2 * (1 - st)) + (0.05 - st * 0.03) * k * k * Math.sin(c.phase * 0.9 + a * 1.7 + s * 9);
          if (Math.abs(w - wa) < 0.045 * (1 - k) + 0.013) return hit(out, (Math.floor(s * 30) + a) % 3 === 0 ? F_PALE : F_BODY, 0.5);
        }
      }
      return false;
    },
  },

  // Moon jellyfish: rhythmic bell pulses, otherwise drifting with the current. Glows.
  jelly: {
    name: "Moon jellyfish", count: 6, size: (m) => Math.max(90, m * 0.21), depth: [0.7, 1],
    maxPitch: 2, turn: 1, beat: [1.2, 0.02], bend: 0, fear: 0,
    ext: [-0.02, 1.02, 0.32], tint: [180, 170, 255],
    glow: [[180, 160, 255], [120, 220, 255], [255, 160, 220]],
    spawn: (c, w) => {
      c.x = rand(0.05, 0.95) * w.width;
      c.y = rand(0.2, 0.7) * w.floorAt(c.x);
      c.pitch = HALF_PI;
      c.home = rand(0, 3);
    },
    think(c, w, dt) {
      c.faceLock = c.pitchLock = true;
      c.face = c.faceWant = 1;
      c.accel = 1.2;
      c.home += dt;
      const period = 2.4 + (c.id % 3) * 0.5;
      const ph = (c.home % period) / period;
      c.aux = ph < 0.3 ? Math.sin((ph / 0.3) * Math.PI) : 0;
      c.wander = clamp(c.wander + (Math.random() - 0.5) * dt * 0.6, -1, 1);
      const fl = w.floorAt(c.x);
      const tilt = c.y > fl * 0.75 ? 0 : c.wander * 0.5;
      c.pitch = HALF_PI - tilt;
      const thrust = c.y < fl * 0.12 ? 0 : c.aux * 42;
      const cur = w.currentAt(c.x, c.y);
      c.dvx = Math.cos(c.pitch) * thrust + cur.x * 0.35;
      c.dvy = -Math.sin(c.pitch) * thrust + cur.y * 0.35 + 7;
      go(c, c.aux > 0.05 ? "pulsing its bell" : "drifting with the current");
      if (c.x < -60) c.x = w.width + 50;
      else if (c.x > w.width + 60) c.x = -50;
    },
    shape(s, w, c, _t, out) {
      if (s < 0 || s > 1) return false;
      const ct = c.aux;
      const bh = 0.28 * (1 + 0.15 * ct);
      const R = 0.26 * (1 - 0.25 * ct);
      const aw = Math.abs(w);
      if (s < bh) {
        const x = s / bh;
        const half = R * Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)));
        if (aw > half) return false;
        // The four horseshoe gonads glow brightest.
        const gonad = ((s - bh * 0.6) / 0.04) ** 2 + ((aw - R * 0.4) / 0.05) ** 2 < 1;
        return hit(out, F_GLOW, gonad ? 1 : half - aw < 0.03 ? 0.8 : 0.4 + 0.3 * ct);
      }
      const k = (s - bh) / (1 - bh);
      if (k < 0.45 && Math.abs(w - 0.03 * Math.sin(s * 14 + c.phase)) < 0.04 * (1 - k)) return hit(out, F_GLOW, 0.65);
      for (let a = -2; a <= 2; a++) {
        const wa = a * R * 0.45 + 0.02 * Math.sin(c.phase * 0.7 + s * 10 + a);
        if (Math.abs(w - wa) < 0.02) return hit(out, F_GLOW, 0.45 * (1 - k * 0.5));
      }
      return false;
    },
  },

  // Moray eel: lives in a rock den, head out, gaping rhythmically to pump water over its
  // gills; lunges at fish that stray within reach, then pulls back in.
  moray: {
    name: "Moray eel", count: 1, size: (m) => Math.max(160, m * 0.3), depth: [1, 1],
    maxPitch: 1, turn: 1, beat: [1.6, 0], bend: 0, fear: 0.3,
    ext: [-0.02, 1.02, 0.12], tint: [140, 150, 70], seabed: true,
    spawn: (c, w) => {
      const rock = w.rocks.reduce((a, b) => (b.h > a.h ? b : a), w.rocks[0]);
      const side = Math.random() < 0.5 ? -1 : 1;
      c.homeX = rock.x + side * rock.w * 0.28;
      c.homeY = w.floorAt(c.homeX) + 14;
      c.face = c.faceWant = side;
      c.open = 0.35;
      c.pitch = 0.15;
      go(c, "peeking out (gaping to breathe)");
    },
    think(c, w, dt) {
      c.faceLock = c.pitchLock = true;
      c.vx = c.vy = c.dvx = c.dvy = 0;
      const hx = c.homeX;
      const hy = c.homeY;
      switch (c.state) {
        case "lunging at a fish!": {
          c.open = Math.min(0.95, c.open + dt * 4);
          c.aux = 1;
          const f = c.target as Fish | null;
          if (f && f.alive) c.pitch = clamp(Math.atan2(-(f.y - hy), Math.abs(f.x - hx)), -0.6, 0.9);
          if (w.eatFish(headX(c), headY(c), 20, 1, false) || c.stateT > 0.7) go(c, "pulling back into its den");
          break;
        }
        case "pulling back into its den":
          c.aux = Math.max(0, c.aux - dt * 2);
          c.open = Math.max(0.35, c.open - dt * 1.2);
          c.pitch += (0.15 - c.pitch) * dt * 2;
          if (c.open <= 0.36) go(c, "peeking out (gaping to breathe)");
          break;
        default:
          go(c, "peeking out (gaping to breathe)");
          c.open += (0.38 + 0.08 * Math.sin(w.time * 0.4) - c.open) * dt;
          c.pitch += (0.15 + 0.1 * Math.sin(w.time * 0.3) - c.pitch) * dt;
          c.timer -= dt;
          if (c.timer <= 0) {
            c.timer = 0.3;
            const reach = c.L * 0.85;
            const f = w.prey(hx + c.face * reach * 0.5, hy - reach * 0.2, reach * 0.6, false);
            if (f && (f.x - hx) * c.face > 0) {
              c.target = f;
              go(c, "lunging at a fish!");
            }
          }
      }
      // The body slides out of the den along its heading; the part still inside is hidden.
      const fx = c.face * Math.cos(c.pitch);
      const fy = -Math.sin(c.pitch);
      c.x = hx + fx * c.open * c.L - fx * c.L * 0.5;
      c.y = hy + fy * c.open * c.L - fy * c.L * 0.5;
    },
    shape(s, w, c, _t, out) {
      if (s < 0 || s > c.open) return false;
      const ww = w - 0.02 * Math.sin(s * 12 - c.phase) * Math.min(1, s / 0.1);
      const h = s < 0.12 ? 0.055 + 0.014 * Math.sin((s / 0.12) * Math.PI) : 0.055;
      const gape = (0.5 + 0.5 * Math.sin(c.phase * 0.6)) * 0.02 + c.aux * 0.035;
      if (s < 0.1 && ww < 0 && ww > -gape * (1 - s / 0.1) - 0.004) return hit(out, F_MOUTH, 0);
      if (s > 0.03 && s < 0.05 && ww > 0.012 && ww < 0.028) return hit(out, F_EYE, 0);
      if (s > 0.12 && ww > h && ww < h + 0.014) return hit(out, F_FIN, 0.45);
      if (Math.abs(ww) <= h) {
        if (hash3(Math.floor(s * 60), Math.floor(ww * 50), c.id) < 0.22) return hit(out, F_MARK, 0.3);
        return hit(out, F_BODY, lit(ww, h, h));
      }
      return false;
    },
  },

  // Anglerfish: hangs almost motionless in the dark, dangling a glowing lure from its
  // forehead; small fish drift in toward the light and get gulped.
  angler: {
    name: "Anglerfish", count: 1, size: () => 13, depth: [0.95, 1],
    maxPitch: 0.3, turn: 1, beat: [1, 0], bend: 0, fear: 0,
    ext: [0, 1, 0.3], tint: [120, 96, 86],
    glow: [[120, 255, 220]],
    colors: { o: [235, 235, 210], v: [235, 230, 215], "^": [235, 230, 215] },
    spawn: (c, w) => {
      c.x = rand(0.15, 0.85) * w.width;
      c.homeY = c.y = w.floorAt(c.x) * 0.86;
      c.face = c.faceWant = Math.random() < 0.5 ? 1 : -1;
      go(c, "luring with its glowing esca");
    },
    think(c, w, dt) {
      c.accel = 0.5;
      c.faceLock = true;
      c.wander = clamp(c.wander + (Math.random() - 0.5) * dt * 0.5, -1, 1);
      if (c.x < 60) c.wander = Math.abs(c.wander);
      else if (c.x > w.width - 60) c.wander = -Math.abs(c.wander);
      c.dvx = c.wander * 6;
      c.dvy = (c.homeY - c.y) * 0.3 + Math.sin(w.time * 0.6 + c.id) * 3;
      c.aux = Math.max(0, c.aux - dt);
      if (c.state === "digesting") {
        if (c.stateT > 8) go(c, "luring with its glowing esca");
        return;
      }
      const rows = DEFS.angler.sprite!(c, w.time);
      const lure = spriteSpot(c, w, rows, "*");
      w.lures.push({ x: lure.x, y: lure.y + w.ch, r: 170 });
      const mouth = spriteSpot(c, w, rows, "v");
      if (w.eatFish(mouth.x, mouth.y, 26, 1, null)) {
        c.aux = 0.5;
        go(c, "digesting");
      }
    },
    sprite: (c) =>
      c.aux > 0
        ? [String.raw`       .-*`, String.raw`      /`, String.raw`  .-''''-. /vv`, String.raw`<(  o   (`, String.raw`  '-.___(  \^^`]
        : [String.raw`       .-*`, String.raw`      /`, String.raw`  .-''''-.`, String.raw`<(  o   (vvv`, String.raw`  '-.___(^^^`],
  },

  // Seahorse: grips kelp with its tail and sways; now and then swims slowly upright to
  // another stalk, fluttering its dorsal fin. Pairs perform a synchronised courtship dance.
  seahorse: {
    name: "Seahorse", count: 2, size: () => 8, depth: [1, 1],
    maxPitch: 0, turn: 1, beat: [2, 0], bend: 0, fear: 0,
    ext: [0, 1, 0.5], tint: [235, 170, 70], seabed: true,
    colors: { o: [30, 20, 10] },
    spawn: (c, w, i) => {
      // Neighbouring stalks (kelp is sorted by x), so a pair can find each other.
      c.home = w.kelp.length ? (Math.floor(w.kelp.length / 2) + i) % w.kelp.length : 0;
      c.aux = rand(0.25, 0.5);
      c.face = c.faceWant = i % 2 ? -1 : 1;
      const k = w.kelp[c.home];
      if (k) {
        const p = w.kelpPoint(k, c.aux, { x: 0, y: 0 });
        c.x = p.x;
        c.y = p.y;
      }
      go(c, "tail anchored to kelp");
    },
    think(c, w, dt) {
      c.faceLock = true;
      c.accel = 1.5;
      const k = w.kelp[c.home];
      if (!k) return;
      switch (c.state) {
        case "swimming to another kelp": {
          const p = w.kelpPoint(k, c.aux, { x: 0, y: 0 });
          const tx = p.x + c.face * w.cw * 2;
          if (seek(c, tx, p.y, 9) < 4) go(c, "tail anchored to kelp");
          c.dvy += Math.sin(w.time * 3) * 4;
          if (Math.abs(tx - c.x) > 6) c.face = c.faceWant = tx > c.x ? 1 : -1;
          break;
        }
        case "courtship dance": {
          const mate = c.target as Creature | null;
          if (!mate || mate.state !== "courtship dance" || c.stateT > 16) {
            go(c, "swimming to another kelp");
            break;
          }
          seek(c, c.tx, c.ty + Math.sin(w.time * 1.7) * 14, 14);
          c.face = c.faceWant = mate.x > c.x ? 1 : -1;
          break;
        }
        default: {
          const p = w.kelpPoint(k, c.aux, { x: 0, y: 0 });
          c.x = p.x + c.face * w.cw * 2;
          c.y = p.y;
          c.vx = c.vy = c.dvx = c.dvy = 0;
          if (c.stateT > 8 && Math.random() < dt * 0.05) {
            const mate = near(w, c, "seahorse", 480);
            if (mate && mate.state === "tail anchored to kelp") {
              const mx = (c.x + mate.x) / 2;
              const my = (c.y + mate.y) / 2;
              for (const [a, b] of [[c, mate], [mate, c]]) {
                go(a, "courtship dance");
                a.target = b;
                a.tx = mx + (a.x < b.x ? -1 : 1) * w.cw * 3.5;
                a.ty = my;
              }
              break;
            }
          }
          if (c.stateT > 25 && Math.random() < dt * 0.05 && w.kelp.length > 1) {
            c.home = clamp(c.home + (Math.random() < 0.5 ? -1 : 1), 0, w.kelp.length - 1);
            c.aux = rand(0.25, 0.5);
            go(c, "swimming to another kelp");
          }
        }
      }
    },
    sprite: (c, t) => {
      const fin = Math.floor(t * (c.state === "tail anchored to kelp" ? 2 : 8)) % 2 ? "{" : "(";
      return [String.raw`  _,`, String.raw` (o \__=`, String.raw`  )  /`, fin + String.raw`(  (`, String.raw`  )  )`, String.raw` (  /`, String.raw`  \_@`];
    },
  },

  // Crab: scuttles sideways along the seabed, picks at the sand, scavenges scraps that
  // sink from feeding frenzies above, and runs from the octopus.
  crab: {
    name: "Crab", count: 3, size: () => 11, depth: [1, 1],
    maxPitch: 0, turn: 10, beat: [1, 0], bend: 0, fear: 0,
    ext: [0, 1, 0.3], tint: [225, 95, 60], seabed: true,
    colors: { o: [250, 245, 220] },
    spawn: (c, w) => {
      c.dir = Math.random() < 0.5 ? 1 : -1;
      c.x = w.time > 1 ? (c.dir > 0 ? -20 : w.width + 20) : rand(0.1, 0.9) * w.width;
      c.y = w.floorAt(c.x) - w.ch * 1.6;
      go(c, "scuttling sideways");
    },
    think(c, w, dt) {
      c.faceLock = true;
      c.accel = 4;
      c.y = w.floorAt(c.x) - w.ch * 1.6;
      c.vy = c.dvy = 0;
      const octo = near(w, c, "octopus", 170);
      if (octo && octo.state === "stalking a crab") {
        go(c, "fleeing the octopus!");
        c.dvx = Math.sign(c.x - octo.x || 1) * 70;
        return;
      }
      switch (c.state) {
        case "scavenging food scraps":
          c.dvx = Math.sign(c.tx - c.x) * 26;
          if (Math.abs(c.tx - c.x) < 6) {
            w.eatCrumb(c.tx);
            go(c, "picking at the sand");
          }
          if (c.stateT > 15) go(c, "scuttling sideways");
          break;
        case "picking at the sand":
          c.dvx = 0;
          if (c.stateT > 3) go(c, "scuttling sideways");
          break;
        default:
          go(c, "scuttling sideways");
          c.dvx = c.dir * 24 * (0.6 + 0.4 * Math.sin(w.time * 5 + c.id));
          if (c.x < 30) c.dir = 1;
          else if (c.x > w.width - 30) c.dir = -1;
          else if (Math.random() < dt * 0.1) c.dir = c.dir === 1 ? -1 : 1;
          if (Math.random() < dt * 0.08) go(c, "picking at the sand");
          c.timer -= dt;
          if (c.timer <= 0) {
            c.timer = 1;
            const cx = w.restingCrumb(c.x, 400);
            if (cx !== null) {
              c.tx = cx;
              go(c, "scavenging food scraps");
            }
          }
      }
    },
    sprite: (c, t) => {
      const picking = c.state === "picking at the sand";
      const claws = picking && Math.floor(t * 3) % 2 ? String.raw`(||)   (||)` : String.raw`(\/)   (\/)`;
      const legs = !picking && Math.floor(t * 8 + c.id) % 2 ? String.raw`  |\| |/| ` : String.raw`  /|/ \|\ `;
      return [claws, String.raw`  \ o o /`, String.raw`  (_____)`, legs];
    },
  },
};

export const KINDS = Object.keys(DEFS) as Kind[];
