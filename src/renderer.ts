/**
 * Draws the deep-ocean World as a grid of ASCII cells, back to front:
 *   water gradient + sun shafts (they fade at night) → faint cell grid → marine snow,
 *   bubbles, food scraps → cyan wake and sonar/song ripples → kelp → seabed → fish
 *   glyphs → animals → ink clouds → feeding flashes → HUD and hover label.
 *
 * Animals are rasterised cell by cell from their side-view shape functions with
 * supersampled edges (the technique the original sharks used), or stamped from
 * small ASCII sprites, mirrored when they face left.
 */
import { clamp, hash3 } from "./math";
import { DEFS, F_EDGE, F_EYE, F_FIN, F_GLOW, F_MARK, F_MOUTH, F_PALE, F_SPRITE, type Creature, type Def, type Shape } from "./creatures";
import { SPECIES } from "./species";
import type { World } from "./world";

const ACCENTS = ["#e0892c", "#e03a32", "#b44ae0", "#33c8cc", "#3cb54a", "#3150e8", "#d9c14a"];
// Sparse glyphs on bright skin, dense glyphs in shadow, so the texture reinforces the shading.
const SKIN_RAMP = ":;t%SX8#@";
const FIN_GLYPHS = "%;tS:";
const MARK_GLYPHS = "#%@";
const PALE_GLYPHS = ".:'`";
const EDGE_HEAVY = ":;";
const EDGE_LIGHT = ".',`";
const GLOW_RAMP = ".:-=+*#";
const WAKE_LEVELS = 6;
// Sub-cell sample offsets for anti-aliased silhouettes.
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "/": "\\", "\\": "/", "<": ">", ">": "<", "{": "}", "}": "{", "[": "]", "]": "[", "`": "'", "'": "`" };
const DEFAULT_PALE: [number, number, number] = [225, 230, 238];

const rgb = (r: number, g: number, b: number) => `rgb(${Math.min(255, r) | 0},${Math.min(255, g) | 0},${Math.min(255, b) | 0})`;

function mirrorLine(s: string) {
  let o = "";
  for (let i = s.length - 1; i >= 0; i--) o += MIRROR[s[i]] ?? s[i];
  return o;
}

/** Faint cell grid, snapped to device pixels. */
export function paintGrid(g: CanvasRenderingContext2D, W: number, H: number, cw: number, ch: number, dpr: number, alpha = 0.055) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = `rgba(255,255,255,${alpha})`;
  g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c <= Math.ceil(W / cw); c++) {
    const x = Math.round(c * cw * dpr) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, H * dpr);
  }
  for (let r = 0; r <= Math.ceil(H / ch); r++) {
    const y = Math.round(r * ch * dpr) + 0.5;
    g.moveTo(0, y);
    g.lineTo(W * dpr, y);
  }
  g.stroke();
}

interface Ring {
  x: number;
  y: number;
  r: number;
  v: number;
  max: number;
  a: number;
}

export class AsciiRenderer {
  private ctx: CanvasRenderingContext2D;
  private grid: HTMLCanvasElement;
  private floor: HTMLCanvasElement;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private cw = 12;
  private ch = 18;
  private cols = 0;
  private rows = 0;
  private fontFamily = "ui-monospace, Menlo, monospace";
  private floorVersion = -1;

  private energy = new Float32Array(0);
  private energyTmp = new Float32Array(0);
  private ink = new Float32Array(0);
  private inkTmp = new Float32Array(0);
  private heat = new Float32Array(0);
  private rings: Ring[] = [];
  private wakeBuckets: number[][] = Array.from({ length: WAKE_LEVELS }, () => []);
  private wakeStyles = Array.from({ length: WAKE_LEVELS }, (_, l) => `rgba(110,230,255,${((l + 1) / WAKE_LEVELS).toFixed(3)})`);

  /** Per cell: what's drawn there this frame. Owner is creature index + 1. */
  private cFlag = new Uint8Array(0);
  private cShade = new Float32Array(0);
  private cKey = new Uint32Array(0);
  private cOwner = new Int16Array(0);
  private cChar = new Uint16Array(0);
  private fishStamp = new Uint32Array(0);
  private fishOwner = new Int32Array(0);
  private frameId = 0;
  private order: Creature[] = [];
  private out: Shape = { flag: 0, shade: 0 };
  private hs = 0;
  private hw = 0;
  private pt = { x: 0, y: 0 };
  private pt2 = { x: 0, y: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.grid = document.createElement("canvas");
    this.floor = document.createElement("canvas");
  }

  get cellWidth() {
    return this.cw;
  }

  get cellHeight() {
    return this.ch;
  }

  setFontFamily(family: string) {
    if (family) this.fontFamily = family;
  }

  resize(width: number, height: number, dpr: number) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.cw = clamp(Math.round(width / 160), 7, 11);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(width / this.cw);
    this.rows = Math.ceil(height / this.ch);
    for (const c of [this.canvas, this.grid, this.floor]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    const n = this.cols * this.rows;
    this.energy = new Float32Array(n);
    this.energyTmp = new Float32Array(n);
    this.ink = new Float32Array(n);
    this.inkTmp = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.cFlag = new Uint8Array(n);
    this.cShade = new Float32Array(n);
    this.cKey = new Uint32Array(n);
    this.cOwner = new Int16Array(n);
    this.cChar = new Uint16Array(n);
    this.fishStamp = new Uint32Array(n);
    this.fishOwner = new Int32Array(n);
    const g = this.grid.getContext("2d");
    if (g) paintGrid(g, width, height, this.cw, this.ch, dpr, 0.03);
    this.floorVersion = -1;
  }

  private get font() {
    return `600 ${Math.round(this.ch * 0.74)}px ${this.fontFamily}`;
  }

  render(world: World, dt: number) {
    const { ctx, dpr, cols } = this;
    if (cols === 0) return;
    const t = world.time;
    if (this.floorVersion !== world.version) {
      this.paintFloor(world);
      this.floorVersion = world.version;
    }

    this.consumeEvents(world);
    this.stepRings(dt);
    this.rasterize(world, t);
    this.depositWake(world);
    this.diffuse(dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paintWater(world, t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.grid, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawParticles(world);

    ctx.font = this.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.drawWake();
    this.drawKelp(world);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.floor, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawFish(world);
    this.drawCreatures(world, t);
    this.drawInk();
    this.drawHeat();
    this.drawHud(world);
  }

  // ── fields ──────────────────────────────────────────────────────────

  private cellIndex(x: number, y: number) {
    const c = Math.floor(x / this.cw);
    const r = Math.floor(y / this.ch);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  private stamp(field: Float32Array, x: number, y: number, radius: number, amount: number) {
    const c0 = Math.floor(x / this.cw);
    const r0 = Math.floor(y / this.ch);
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const d = Math.hypot(c - c0, (r - r0) * 1.4);
        if (d > radius + 0.5) continue;
        const i = r * this.cols + c;
        field[i] = Math.min(1.6, field[i] + amount * (1 - d / (radius + 1)));
      }
    }
  }

  private consumeEvents(world: World) {
    for (const e of world.events) {
      switch (e.kind) {
        case "eat":
          this.stamp(this.heat, e.x, e.y, 2, 1);
          this.stamp(this.energy, e.x, e.y, 3, 0.9);
          break;
        case "splash":
          this.stamp(this.energy, e.x, e.y, 6, 1.4);
          break;
        case "click": // echolocation: a quick, tight sonar ping
          this.rings.push({ x: e.x, y: e.y, r: 4, v: 420, max: 260, a: 0.7 });
          break;
        case "song": // whale song: a slow, wide pulse
          this.rings.push({ x: e.x, y: e.y, r: 10, v: 90, max: 520, a: 0.5 });
          break;
        case "slap":
          this.stamp(this.energy, e.x, e.y, 4, 1.2);
          this.rings.push({ x: e.x, y: e.y, r: 4, v: 260, max: 140, a: 0.8 });
          break;
        case "ink":
          this.stamp(this.ink, e.x, e.y, 5, 1.8);
          break;
      }
    }
    world.events.length = 0;
  }

  private stepRings(dt: number) {
    const { rings, energy, cw } = this;
    for (let k = rings.length - 1; k >= 0; k--) {
      const ring = rings[k];
      ring.r += ring.v * dt;
      if (ring.r > ring.max) {
        rings.splice(k, 1);
        continue;
      }
      const level = 0.46 + ring.a * (1 - ring.r / ring.max);
      const steps = Math.max(8, Math.ceil((ring.r * Math.PI * 2) / cw));
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const i = this.cellIndex(ring.x + Math.cos(a) * ring.r, ring.y + Math.sin(a) * ring.r * 0.8);
        if (i >= 0 && energy[i] < level) energy[i] = level;
      }
    }
  }

  private depositWake(world: World) {
    const { energy } = this;
    for (const f of world.fish) {
      if (!f.alive) continue;
      const i = this.cellIndex(f.x, f.y);
      if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.012 + f.alarm * 0.03);
    }
    for (const c of world.creatures) {
      if (!c.alive || DEFS[c.kind].sprite) continue;
      const speed = Math.hypot(c.vx, c.vy);
      if (speed < 8) continue;
      // The tail sweeps the most water.
      const fx = (c.face >= 0 ? 1 : -1) * Math.cos(c.pitch);
      const fy = -Math.sin(c.pitch);
      const i = this.cellIndex(c.x - fx * c.L * 0.45, c.y - fy * c.L * 0.45);
      if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.05 + speed * 0.0015);
    }
    if (world.pointer.active) this.stamp(energy, world.pointer.x, world.pointer.y, 1, 0.08);
  }

  /** Blur + decay, so wakes spread like ripples and ink billows out and slowly clears. */
  private diffuse(dt: number) {
    [this.energy, this.energyTmp] = [this.blur(this.energy, this.energyTmp, Math.exp(-dt * 1.5)), this.energy];
    [this.ink, this.inkTmp] = [this.blur(this.ink, this.inkTmp, Math.exp(-dt * 0.35)), this.ink];
    const heatDecay = Math.exp(-dt * 2.2);
    for (let i = 0; i < this.heat.length; i++) this.heat[i] *= heatDecay;
  }

  /** Writes the blurred field into dst and returns it. */
  private blur(src: Float32Array, dst: Float32Array<ArrayBuffer>, decay: number) {
    const { cols, rows } = this;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const l = c > 0 ? src[i - 1] : src[i];
        const rt = c < cols - 1 ? src[i + 1] : src[i];
        const u = r > 0 ? src[i - cols] : src[i];
        const d = r < rows - 1 ? src[i + cols] : src[i];
        dst[i] = (src[i] * 4 + l + rt + u + d) * 0.125 * decay;
      }
    }
    return dst;
  }

  // ── animals → cells ─────────────────────────────────────────────────

  private rasterize(world: World, t: number) {
    const { cFlag, cOwner, order } = this;
    cFlag.fill(0);
    cOwner.fill(0);
    order.length = 0;
    for (const c of world.creatures) if (c.alive) order.push(c);
    // Far (dim) animals first so near ones swim over them.
    order.sort((a, b) => a.depth - b.depth);
    for (const c of order) {
      const def = DEFS[c.kind];
      if (def.sprite) this.stampSprite(c, def, t);
      else this.rasterizeBody(c, def, t);
    }
  }

  private rasterizeBody(c: Creature, def: Def, t: number) {
    const { cFlag, cShade, cKey, cOwner, cw, ch, cols, rows, out } = this;
    const shape = def.shape!;
    const L = c.L;
    const sgn = c.face >= 0 ? 1 : -1;
    // Mid-turn the body is seen nose-on, so it foreshortens.
    const fs = Math.max(0.15, Math.abs(c.face));
    const cp = Math.cos(c.pitch);
    const sp = Math.sin(c.pitch);
    const fx = sgn * cp;
    const fy = -sp;
    const ux = -sgn * sp;
    const uy = -cp;
    const [s0, s1, wm] = def.ext;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of [s0, s1]) {
      for (const wv of [-wm, wm]) {
        const a = (0.5 - s) * L * fs;
        const b = wv * L;
        const px = c.x + fx * a + ux * b;
        const py = c.y + fy * a + uy * b;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
    }
    const c0 = Math.max(0, Math.floor(minX / cw));
    const c1 = Math.min(cols - 1, Math.floor(maxX / cw));
    const r0 = Math.max(0, Math.floor(minY / ch));
    const r1 = Math.min(rows - 1, Math.floor(maxY / ch));
    if (c0 > c1 || r0 > r1) return;

    const bend = def.bend;
    const sample = (px: number, py: number) => {
      const dx = px - c.x;
      const dy = py - c.y;
      const s = 0.5 - (dx * fx + dy * fy) / (fs * L);
      let wv = (dx * ux + dy * uy) / L;
      // Whales and dolphins beat their flukes up and down.
      if (bend) wv -= bend * Math.pow(Math.max(0, s), 2.2) * Math.sin(c.phase - s * 3.5);
      this.hs = s;
      this.hw = wv;
      return shape(s, wv, c, t, out);
    };

    const owner = c.id + 1;
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const x = col * cw;
        const y = r * ch;
        const centerHit = sample(x + cw / 2, y + ch / 2);
        const flag = out.flag;
        const shade = out.shade;
        const s = this.hs;
        const wv = this.hw;
        let hits = centerHit ? 1 : 0;
        for (let k = 0; k < SUBSAMPLES.length; k += 2) {
          if (sample(x + SUBSAMPLES[k] * cw, y + SUBSAMPLES[k + 1] * ch)) hits++;
        }
        if (hits === 0) continue;
        const i = r * cols + col;
        // Body-anchored key so each glyph rides along with the skin.
        cKey[i] = (hash3(Math.round(s * 60), Math.round(wv * 45), c.id) * 4294967295) >>> 0;
        cOwner[i] = owner;
        if (centerHit && hits >= 3) {
          cFlag[i] = flag;
          cShade[i] = clamp(shade + (hash3(col, r, Math.floor(t * 6)) - 0.5) * 0.06, 0, 1);
        } else {
          cFlag[i] = F_EDGE;
          cShade[i] = hits / 5;
        }
      }
    }
  }

  private stampSprite(c: Creature, def: Def, t: number) {
    const { cFlag, cChar, cOwner, cKey, cw, ch, cols, rows } = this;
    const lines = def.sprite!(c, t);
    const width = Math.max(...lines.map((l) => l.length));
    const col0 = Math.round(c.x / cw - width / 2);
    const row0 = Math.round(c.y / ch - lines.length / 2);
    for (let r = 0; r < lines.length; r++) {
      const line = c.face < 0 ? mirrorLine(lines[r].padEnd(width)) : lines[r];
      const row = row0 + r;
      if (row < 0 || row >= rows) continue;
      for (let k = 0; k < line.length; k++) {
        const chr = line[k];
        const col = col0 + k;
        if (chr === " " || col < 0 || col >= cols) continue;
        const i = row * cols + col;
        cFlag[i] = F_SPRITE;
        cChar[i] = chr.charCodeAt(0);
        cOwner[i] = c.id + 1;
        cKey[i] = (hash3(k, r, c.id) * 4294967295) >>> 0;
      }
    }
  }

  // ── painting ────────────────────────────────────────────────────────

  private paintWater(world: World, t: number) {
    const { ctx, width: W, height: H } = this;
    const n = world.night;
    const mix = (a: number, b: number) => Math.round(a + (b - a) * n);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `rgb(${mix(16, 3)},${mix(64, 12)},${mix(104, 28)})`);
    g.addColorStop(0.45, `rgb(${mix(4, 1)},${mix(22, 6)},${mix(44, 16)})`);
    g.addColorStop(1, "rgb(0,2,6)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Sun shafts slanting down from the surface; gone by night.
    const a = 0.07 * (1 - n);
    if (a < 0.004) return;
    const depth = H * 0.75;
    const shaft = ctx.createLinearGradient(0, 0, 0, depth);
    shaft.addColorStop(0, `rgba(150,210,255,${a.toFixed(3)})`);
    shaft.addColorStop(1, "rgba(150,210,255,0)");
    ctx.fillStyle = shaft;
    for (let i = 0; i < 5; i++) {
      const x0 = W * (0.1 + i * 0.21) + Math.sin(t * 0.07 + i * 1.7) * W * 0.03;
      const half = 18 + 12 * Math.sin(i * 3.1);
      const slant = W * 0.12;
      ctx.beginPath();
      ctx.moveTo(x0 - half, 0);
      ctx.lineTo(x0 + half, 0);
      ctx.lineTo(x0 + half * 3 + slant, depth);
      ctx.lineTo(x0 - half * 1.5 + slant, depth);
      ctx.fill();
    }
  }

  private paintFloor(world: World) {
    const g = this.floor.getContext("2d");
    if (!g) return;
    const { width: W, height: H, dpr, cw, ch, cols, rows } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.floor.width, this.floor.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W + 4; x += 4) g.lineTo(x, world.floorAt(x));
    g.lineTo(W, H);
    g.closePath();
    const grad = g.createLinearGradient(0, H * 0.75, 0, H);
    grad.addColorStop(0, "rgb(14,16,20)");
    grad.addColorStop(1, "rgb(4,5,7)");
    g.fillStyle = grad;
    g.fill();

    g.font = this.font;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cw;
      const fy = world.floorAt(x);
      const sand = world.baseAt(x);
      const r0 = Math.floor(fy / ch);
      const slope = world.floorAt(x + cw) - world.floorAt(x - cw);
      for (let r = r0; r < rows; r++) {
        const y = (r + 0.5) * ch;
        const rock = y < sand - 4;
        const h = hash3(c, r, 77);
        let glyph: string;
        let color: string;
        if (r === r0) {
          const steep = Math.abs(slope) > ch * 0.45;
          glyph = steep ? (slope < 0 ? "/" : "\\") : rock ? "^" : h < 0.5 ? "_" : h < 0.8 ? "." : ",";
          color = rock ? "rgb(120,124,132)" : "rgb(150,138,112)";
        } else if (rock) {
          glyph = "#%&8@"[Math.floor(h * 5)];
          const v = 46 + h * 30;
          color = rgb(v, v + 2, v + 8);
        } else {
          if (h > 0.45) continue;
          glyph = ".,:;'"[Math.floor(h * 11) % 5];
          color = `rgba(130,118,96,${Math.max(0.12, 0.5 * (1 - (r - r0) / 8)).toFixed(2)})`;
        }
        g.fillStyle = color;
        g.fillText(glyph, x, y + 1);
      }
    }
    // The moray's den: a dark hole in the rock.
    for (const c of world.creatures) {
      if (c.kind !== "moray") continue;
      g.fillStyle = "rgb(2,2,4)";
      g.beginPath();
      g.ellipse(c.homeX, c.homeY - 4, cw * 1.6, ch * 0.9, 0, 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawParticles(world: World) {
    const { ctx } = this;
    const dim = 1 - 0.4 * world.night;
    for (const p of world.particles) {
      if (p.kind === 0) {
        ctx.fillStyle = `rgba(200,225,255,${(0.35 * p.life * dim).toFixed(3)})`;
        ctx.fillRect(p.x, p.y, 1.6, 1.6);
      } else if (p.kind === 1) {
        ctx.strokeStyle = "rgba(190,235,255,0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5 + p.life * 2.5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = "rgba(255,170,90,0.85)";
        ctx.fillRect(p.x - 1, p.y - 1, 2.5, 2.5);
      }
    }
  }

  private drawWake() {
    const { ctx, energy, cFlag, cols, cw, ch, wakeBuckets } = this;
    for (const b of wakeBuckets) b.length = 0;
    for (let i = 0; i < energy.length; i++) {
      const e = energy[i];
      if (e < 0.45 || cFlag[i]) continue;
      wakeBuckets[clamp(Math.floor((e - 0.45) * 5), 0, WAKE_LEVELS - 1)].push(i);
    }
    const size = Math.max(2, Math.round(cw * 0.19)) + 1;
    for (let l = 0; l < WAKE_LEVELS; l++) {
      ctx.fillStyle = this.wakeStyles[l];
      for (const i of wakeBuckets[l]) {
        ctx.fillRect(Math.round((i % cols) * cw + cw * 0.66 - size / 2), Math.round(((i / cols) | 0) * ch + ch * 0.64 - size / 2), size, size);
      }
    }
  }

  private drawKelp(world: World) {
    const { ctx, cw, ch, pt: p, pt2: q } = this;
    const alpha = (0.85 - 0.3 * world.night).toFixed(2);
    for (const k of world.kelp) {
      const steps = Math.max(2, Math.ceil(k.h / (ch * 0.9)));
      for (let j = 0; j <= steps; j++) {
        world.kelpPoint(k, j / steps, p);
        world.kelpPoint(k, Math.min(1, (j + 1) / steps), q);
        const dx = q.x - p.x;
        const glyph = dx > cw * 0.35 ? "/" : dx < -cw * 0.35 ? "\\" : j % 2 ? "(" : ")";
        const col = Math.floor(p.x / cw);
        const row = Math.floor(p.y / ch);
        ctx.fillStyle = `rgba(40,${(90 + 70 * (j / steps)) | 0},70,${alpha})`;
        ctx.fillText(glyph, col * cw + cw / 2, row * ch + ch / 2 + 1);
        if (j % 3 === 1 && j < steps) {
          const side = ((j / 3) | 0) % 2 ? 1 : -1;
          ctx.fillText("~", (col + side) * cw + cw / 2, row * ch + ch / 2 + 1);
        }
      }
    }
  }

  /** Fish: one glyph per cell. Nearer fish are brighter, panicking or turning fish glint, lanternfish glow. */
  private drawFish(world: World) {
    const { ctx, cw, ch, cols, fishStamp, fishOwner, cFlag } = this;
    const frame = ++this.frameId;
    const night = world.night;
    const t = world.time;
    for (let n = 0; n < world.fish.length; n++) {
      const f = world.fish[n];
      if (!f.alive) continue;
      const i = this.cellIndex(f.x, f.y);
      if (i < 0 || fishStamp[i] === frame || cFlag[i]) continue;
      fishStamp[i] = frame;
      fishOwner[i] = n;
      const sp = SPECIES[f.species];
      const glint = clamp(Math.abs(f.turn) / 3.5, 0, 1);
      let v = 0.35 + (0.4 * (f.depth - 0.55)) / 0.45 + 0.3 * Math.max(glint, f.alarm);
      if (sp.glow) v = (0.55 + 0.45 * Math.sin(t * 3 + f.phase)) * (0.6 + 0.6 * night);
      else v *= 1 - 0.35 * night;
      const [r, g, b] = sp.rgb;
      ctx.fillStyle = `rgba(${r},${g},${b},${clamp(v, 0.1, 1).toFixed(2)})`;
      ctx.fillText(sp.glyph, (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
  }

  private drawCreatures(world: World, t: number) {
    const { ctx, cols, cw, ch, cFlag, cShade, cKey, cOwner, cChar } = this;
    const night = world.night;
    for (let i = 0; i < cFlag.length; i++) {
      const flag = cFlag[i];
      if (!flag) continue;
      const c = world.creatures[cOwner[i] - 1];
      const def = DEFS[c.kind];
      const x = (i % cols) * cw;
      const y = ((i / cols) | 0) * ch;
      const cx = x + cw / 2;
      const cy = y + ch / 2 + 1;
      const key = cKey[i];
      const shade = cShade[i];
      // Depth haze, the dark of night, and an octopus's camouflage all dim the skin.
      const dim = (0.55 + 0.45 * c.depth) * (1 - 0.3 * night) * (1 - 0.82 * c.camo);
      const [tr, tg, tb] = def.tint;
      const glowRgb = def.glow?.[c.slot % def.glow.length];

      if (flag === F_SPRITE) {
        const chr = String.fromCharCode(cChar[i]);
        if (chr === "*" && glowRgb) {
          const pulse = c.state === "digesting" ? 0.25 : 0.7 + 0.3 * Math.sin(t * 5);
          ctx.fillStyle = `rgba(${glowRgb[0]},${glowRgb[1]},${glowRgb[2]},0.18)`;
          ctx.beginPath();
          ctx.arc(cx, cy - 1, cw * 1.6 * pulse, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = rgb(glowRgb[0] * pulse + 40, glowRgb[1] * pulse + 40, glowRgb[2] * pulse + 40);
        } else {
          const col = def.colors?.[chr];
          const k = col ? 1 : dim;
          const [r, g, b] = col ?? def.tint;
          ctx.fillStyle = rgb(r * k, g * k, b * k);
        }
        ctx.fillText(chr, cx, cy);
        continue;
      }

      if (flag === F_GLOW || (flag === F_EDGE && glowRgb && !def.sprite)) {
        // Bioluminescence: no skin block, just light — brighter at night and on each pulse.
        const [gr, gg, gb] = glowRgb ?? def.tint;
        const pulse = 0.75 + 0.25 * Math.sin(t * 2 + c.id) + c.aux * 0.4;
        const v = (flag === F_EDGE ? shade * 0.45 : 0.35 + shade * 0.75) * pulse * (0.95 + 0.4 * night) * (0.6 + 0.4 * c.depth);
        ctx.fillStyle = `rgba(${gr},${gg},${gb},${Math.min(0.4, v * 0.22).toFixed(3)})`;
        ctx.fillRect(x, y, cw, ch);
        ctx.fillStyle = rgb(gr * v, gg * v, gb * v);
        ctx.fillText(flag === F_EDGE ? "." : GLOW_RAMP[clamp(Math.floor(shade * 6.99), 0, 6)], cx, cy);
        continue;
      }

      const tick = Math.floor(t * 2.4 + (key % 997) / 97);
      const roll = hash3(key, tick, 7);

      if (flag === F_EDGE) {
        // Soft, anti-aliased silhouette: no block, just a light glyph.
        const set = shade >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT;
        const k = (0.25 + shade * 0.35) * dim;
        const kb = shade * 0.32 * dim;
        ctx.fillStyle = rgb(tr * kb, tg * kb, tb * kb);
        ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
        ctx.fillStyle = roll < 0.05 ? ACCENTS[key % ACCENTS.length] : rgb(tr * k, tg * k, tb * k);
        ctx.fillText(set[(key >>> 8) % set.length], cx, cy);
        continue;
      }

      let block: string;
      let ink: string;
      let glyph: string;
      if (flag === F_EYE) {
        block = "rgb(10,10,12)";
        ink = "#c8ccd6";
        glyph = "o";
      } else if (flag === F_MOUTH) {
        block = "rgb(16,5,7)";
        ink = "rgb(90,30,34)";
        glyph = "-";
      } else if (flag === F_PALE) {
        const [pr, pg, pb] = def.pale ?? DEFAULT_PALE;
        const k = (0.5 + 0.5 * shade) * dim;
        block = rgb(pr * k, pg * k, pb * k);
        ink = rgb(pr * k * 0.55, pg * k * 0.55, pb * k * 0.55);
        glyph = PALE_GLYPHS[(key >>> 8) % PALE_GLYPHS.length];
      } else if (flag === F_MARK) {
        const k = (0.14 + shade * 0.12) * dim;
        block = rgb(tr * k, tg * k, tb * k);
        ink = rgb(tr * k * 2.2, tg * k * 2.2, tb * k * 2.2);
        glyph = MARK_GLYPHS[(key >>> 8) % MARK_GLYPHS.length];
      } else {
        const fin = flag === F_FIN;
        const k = (fin ? 0.18 + 0.6 * shade : 0.22 + 0.78 * shade) * dim;
        block = rgb(tr * k, tg * k, tb * k);
        ink = roll < 0.05 ? ACCENTS[key % ACCENTS.length] : rgb(tr * k * 0.32, tg * k * 0.32, tb * k * 0.32);
        if (fin) glyph = FIN_GLYPHS[(key >>> 8) % FIN_GLYPHS.length];
        else {
          const jitter = ((key >>> 4) % 3) - 1;
          glyph = SKIN_RAMP[clamp(Math.floor((1 - shade) * 8.99) + jitter, 0, SKIN_RAMP.length - 1)];
        }
      }
      ctx.fillStyle = block;
      ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
      ctx.fillStyle = ink;
      ctx.fillText(glyph, cx, cy);
    }
  }

  private drawInk() {
    const { ctx, ink, cols, cw, ch } = this;
    for (let i = 0; i < ink.length; i++) {
      const v = ink[i];
      if (v < 0.06) continue;
      const a = Math.min(0.94, v * 1.4);
      const x = (i % cols) * cw;
      const y = ((i / cols) | 0) * ch;
      ctx.fillStyle = `rgba(6,3,12,${a.toFixed(2)})`;
      ctx.fillRect(x, y, cw, ch);
      ctx.fillStyle = `rgba(80,50,100,${(a * 0.7).toFixed(2)})`;
      ctx.fillText("%&@"[i % 3], x + cw / 2, y + ch / 2 + 1);
    }
  }

  private drawHeat() {
    const { ctx, heat, cols, cw, ch } = this;
    for (let i = 0; i < heat.length; i++) {
      const h = heat[i];
      if (h < 0.08) continue;
      ctx.fillStyle = h > 0.5 ? `rgba(255,120,60,${h.toFixed(2)})` : `rgba(220,40,40,${(h * 1.6).toFixed(2)})`;
      ctx.fillText(h > 0.6 ? "*" : "·", (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
  }

  /** Corner caption, plus a label naming whatever the pointer is over and what it's doing. */
  private drawHud(world: World) {
    const { ctx, cw, ch, cols, rows, cOwner, fishStamp, fishOwner, frameId } = this;
    const size = Math.max(11, Math.round(ch * 0.66));
    ctx.font = `600 ${size}px ${this.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const n = world.night;
    const time = n < 0.25 ? "day" : n > 0.75 ? "night" : world.time % 150 < 75 ? "dusk" : "dawn";
    ctx.fillStyle = "rgba(170,205,235,0.6)";
    ctx.fillText(`DEEP OCEAN · ${time}`, 16, 14);
    ctx.fillStyle = "rgba(170,205,235,0.35)";
    ctx.fillText("hover an animal to see what it's doing · click to startle", 16, 14 + size * 1.5);

    const p = world.pointer;
    if (!p.active) return;
    const pc = Math.floor(p.x / cw);
    const pr = Math.floor(p.y / ch);
    let label = "";
    for (let d = 0; d <= 1 && !label; d++) {
      for (let r = pr - d; r <= pr + d && !label; r++) {
        for (let c = pc - d; c <= pc + d && !label; c++) {
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
          const i = r * cols + c;
          if (cOwner[i]) {
            const cr = world.creatures[cOwner[i] - 1];
            label = `${DEFS[cr.kind].name} · ${cr.state}`;
          } else if (fishStamp[i] === frameId) {
            const f = world.fish[fishOwner[i]];
            const sp = SPECIES[f.species];
            label = `${sp.name} · ${f.alarm > 0.5 ? "fleeing" : sp.glow || sp.name === "Krill" ? "migrating with the light" : "schooling"}`;
          }
        }
      }
    }
    if (!label) return;
    const w = ctx.measureText(label).width + 16;
    const lx = Math.min(p.x + 14, this.width - w - 8);
    const ly = Math.max(8, p.y - size * 2.2);
    ctx.fillStyle = "rgba(0,8,16,0.82)";
    ctx.fillRect(lx, ly, w, size * 1.7);
    ctx.strokeStyle = "rgba(110,230,255,0.35)";
    ctx.strokeRect(lx + 0.5, ly + 0.5, w - 1, size * 1.7 - 1);
    ctx.fillStyle = "rgba(225,240,255,0.95)";
    ctx.fillText(label, lx + 8, ly + size * 0.35);
  }
}
