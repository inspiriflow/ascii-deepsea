/**
 * Deep-ocean artificial life.
 *
 * Fish: Reynolds boids (separation / alignment / cohesion) in Couzin-style
 * zones with a blind spot behind each fish. Alarm spreads through a school
 * like a wave, fleeing fish break sideways around a predator's path (the
 * fountain effect), and each species holds a preferred depth that shifts
 * between day and night (diel vertical migration).
 *
 * Larger animals live in creatures.ts. The world gives them a seabed, kelp,
 * a day/night cycle, and the shared signals they react to: threats fish flee
 * from, herding points that pack fish into bait balls, anglerfish lures, ink,
 * bubbles and food scraps that sink to the scavengers below.
 */
import { angleDiff, clamp, current, lerp, noise1, rand, randInt, TAU } from "./math";
import { KRILL, pickSpecies, SPECIES } from "./species";
import { DEFS, integrate, KINDS, makeCreature, respawn, type Creature } from "./creatures";

export interface Fish {
  x: number;
  y: number;
  vx: number;
  vy: number;
  species: number;
  /** 0 calm → 1 panicking. Spreads to neighbours. */
  alarm: number;
  alive: boolean;
  respawnAt: number;
  phase: number;
  /** Smoothed angular velocity (rad/s); hard turns flash silver. */
  turn: number;
  /** 0.55 far → 1 near. */
  depth: number;
  millDir: 1 | -1;
  /** This school's offset from the species' preferred depth. */
  band: number;
}

export interface WorldEvent {
  kind: "eat" | "splash" | "click" | "song" | "ink" | "slap";
  x: number;
  y: number;
}

/** 0 marine snow, 1 bubble, 2 food scrap sinking to the seabed. */
export interface Particle {
  kind: 0 | 1 | 2;
  x: number;
  y: number;
  v: number;
  life: number;
}

export interface Kelp {
  x: number;
  h: number;
  phase: number;
}

export interface Rock {
  x: number;
  w: number;
  h: number;
}

export interface Spot {
  x: number;
  y: number;
  r: number;
}

interface Threat {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
  fx: number;
  fy: number;
}

/** Seconds for a full day → night → day cycle. */
const DAY_LENGTH = 150;

const FISH_SEPARATION_K = 420;
const FISH_ALIGN_K = 1.4;
const FISH_COHESION_K = 1;
const FISH_FLEE_K = 1100;
const BLIND_COS = -0.6;

export class World {
  width = 0;
  height = 0;
  time = 0;
  cw = 10;
  ch = 15;
  fish: Fish[] = [];
  creatures: Creature[] = [];
  events: WorldEvent[] = [];
  particles: Particle[] = [];
  kelp: Kelp[] = [];
  rocks: Rock[] = [];
  /** Rebuilt every step by the animals that set them. */
  herds: Spot[] = [];
  lures: Spot[] = [];
  /** Bumps whenever the seabed is rebuilt, so the renderer repaints it. */
  version = 0;
  pointer = { x: 0, y: 0, active: false };

  private threats: Threat[] = [];
  private perception = 60;
  private sepX: number[] = [];
  private sepY: number[] = [];
  private foreignSep = 40;
  private bucketCols = 0;
  private bucketRows = 0;
  private bucketHead = new Int32Array(0);
  private bucketCount = new Uint16Array(0);
  private bucketNext = new Int32Array(0);
  private floorPx = new Float32Array(2);
  private basePx = new Float32Array(2);
  private lastSpawn = 0;
  private cur = { x: 0, y: 0 };
  private cur2 = { x: 0, y: 0 };
  private schoolOut = { x: 0, y: 0, n: 0 };

  /** `only` limits the animals to these kinds (fish always swim). */
  constructor(private only?: string[]) {}

  /** 0 midday → 1 midnight. */
  get night() {
    return 0.5 - 0.5 * Math.cos((this.time / DAY_LENGTH) * TAU);
  }

  resize(width: number, height: number, cellW: number, cellH: number) {
    this.width = width;
    this.height = height;
    this.cw = cellW;
    this.ch = cellH;
    // Spacing is set in grid cells so every fish lands in its own cell.
    this.sepX = SPECIES.map((sp) => sp.spacing[0] * cellW);
    this.sepY = SPECIES.map((sp) => sp.spacing[1] * cellH);
    this.perception = Math.max(cellH * 3, cellW * 5.5);
    this.foreignSep = cellW * 3;
    // ponytail: a resize re-seeds everything; keep state across resizes if that ever bothers anyone.
    this.seed();
  }

  seed() {
    const { width: W, height: H } = this;
    this.version++;
    this.buildSeabed();

    const total = clamp(Math.round((W * H) / 4200), 90, 360);
    this.fish = [];
    while (this.fish.length < total) {
      const species = pickSpecies();
      const sp = SPECIES[species];
      const size = Math.min(randInt(sp.schoolSize[0], sp.schoolSize[1]), total - this.fish.length);
      const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const band = rand(-0.1, 0.1);
      const cx = rand(W * 0.06, W * 0.94);
      const cy = clamp(sp.day + band, 0.05, 0.9) * this.floorAt(cx);
      const dir = (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.5, 0.5);
      for (let k = 0; k < size; k++) {
        this.fish.push({
          x: cx + rand(-1, 1) * this.sepX[species] * Math.sqrt(size),
          y: cy + rand(-1, 1) * this.sepY[species] * Math.sqrt(size) * 0.6,
          vx: Math.cos(dir) * sp.cruise,
          vy: Math.sin(dir) * sp.cruise,
          species, alarm: 0, alive: true, respawnAt: 0, phase: rand(0, TAU), turn: 0,
          depth: rand(0.55, 1), millDir, band,
        });
      }
    }
    this.bucketNext = new Int32Array(this.fish.length);

    this.creatures = [];
    for (const kind of KINDS) {
      if (this.only && !this.only.includes(kind)) continue;
      const def = DEFS[kind];
      for (let i = 0; i < def.count; i++) {
        const c = makeCreature(kind, this.creatures.length, i);
        c.L = def.sprite ? def.size(0) * this.cw : def.size(Math.min(W, H));
        c.depth = rand(def.depth[0], def.depth[1]);
        def.spawn(c, this, i);
        this.creatures.push(c);
      }
    }

    this.particles = [];
    const snow = clamp(Math.round((W * H) / 6000), 60, 300);
    for (let i = 0; i < snow; i++) {
      this.particles.push({ kind: 0, x: rand(0, W), y: rand(0, H), v: rand(5, 14), life: rand(0.3, 1) });
    }
  }

  // ── seabed ──────────────────────────────────────────────────────────

  private buildSeabed() {
    const { width: W, height: H } = this;
    const n = Math.ceil(W / 4) + 2;
    this.floorPx = new Float32Array(n);
    this.basePx = new Float32Array(n);
    const base = H - clamp(H * 0.08, 40, 90);
    this.rocks = [];
    const rockCount = W > 1000 ? 3 : 2;
    for (let i = 0; i < rockCount; i++) {
      this.rocks.push({ x: (W * (i + 0.5)) / rockCount + rand(-W * 0.07, W * 0.07), w: rand(130, 220), h: rand(50, 100) });
    }
    for (let i = 0; i < n; i++) {
      const x = i * 4;
      const y0 = base - noise1(x / 110, 3) * H * 0.04 - noise1(x / 27, 9) * 7;
      let y = y0;
      for (const r of this.rocks) {
        const d = (x - r.x) / (r.w / 2);
        if (Math.abs(d) < 1) y = Math.min(y, y0 - r.h * Math.pow(1 - d * d, 0.6) * (0.8 + 0.2 * noise1(x / 11, 5)));
      }
      this.basePx[i] = y0;
      this.floorPx[i] = y;
    }
    this.kelp = [];
    const kelpCount = Math.max(4, Math.round(W / 170));
    for (let tries = 0; this.kelp.length < kelpCount && tries < 200; tries++) {
      const x = rand(20, W - 20);
      if (this.rocks.some((r) => Math.abs(x - r.x) < r.w * 0.55)) continue;
      if (this.kelp.some((k) => Math.abs(k.x - x) < 40)) continue;
      this.kelp.push({ x, h: rand(0.2, 0.42) * H, phase: rand(0, TAU) });
    }
    this.kelp.sort((a, b) => a.x - b.x);
  }

  floorAt(x: number) {
    return this.sampleRow(this.floorPx, x);
  }

  /** The sand line under the rocks. */
  baseAt(x: number) {
    return this.sampleRow(this.basePx, x);
  }

  private sampleRow(row: Float32Array, x: number) {
    const f = clamp(x / 4, 0, row.length - 1.001);
    const i = f | 0;
    return lerp(row[i], row[i + 1], f - i);
  }

  /** A point `frac` of the way up a swaying kelp stalk. */
  kelpPoint(k: Kelp, frac: number, out: { x: number; y: number }) {
    const t = this.time;
    out.x = k.x + Math.sin(t * 0.6 + k.phase + frac * 2.2) * k.h * 0.06 * frac + Math.sin(t * 0.23 + k.phase) * 10 * frac;
    out.y = this.floorAt(k.x) - k.h * frac;
    return out;
  }

  currentAt(x: number, y: number) {
    return current(x, y, this.time, this.cur2);
  }

  // ── signals animals use ─────────────────────────────────────────────

  emit(kind: WorldEvent["kind"], x: number, y: number) {
    this.events.push({ kind, x, y });
  }

  ink(x: number, y: number) {
    this.emit("ink", x, y);
    // Ink blinds: everything nearby loses track for a moment.
    for (const f of this.fish) {
      if (f.alive && Math.hypot(f.x - x, f.y - y) < 120) f.alarm = 1;
    }
  }

  bubble(x: number, y: number) {
    if (this.particles.length < 700) this.particles.push({ kind: 1, x, y, v: rand(15, 30), life: Math.random() });
  }

  kill(c: Creature, respawnIn: number) {
    c.alive = false;
    c.respawnAt = this.time + respawnIn;
  }

  /** Eat up to `max` fish within r; krill: true only krill, false no krill, null either. */
  eatFish(x: number, y: number, r: number, max: number, krill: boolean | null) {
    let n = 0;
    for (const f of this.fish) {
      if (n >= max) break;
      if (!f.alive || (krill !== null && (f.species === KRILL) !== krill)) continue;
      if ((f.x - x) ** 2 + (f.y - y) ** 2 > r * r) continue;
      f.alive = false;
      f.respawnAt = this.time + rand(3, 8);
      this.emit("eat", f.x, f.y);
      if (Math.random() < 0.35) this.particles.push({ kind: 2, x: f.x, y: f.y, v: rand(10, 18), life: 25 });
      n++;
    }
    return n;
  }

  /** Nearest catchable fish, preferring stragglers: dense schools confuse predators. */
  prey(x: number, y: number, range: number, krill: boolean | null): Fish | null {
    let best: Fish | null = null;
    let bestScore = Infinity;
    for (const f of this.fish) {
      if (!f.alive || (krill !== null && (f.species === KRILL) !== krill)) continue;
      const d = Math.hypot(f.x - x, f.y - y);
      if (d > range) continue;
      const score = d * (1 + this.bucketCount[this.bucketOf(f.x, f.y)] * 0.07);
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    return best;
  }

  /** Centre and size of the fish within range (shared object; copy what you need). */
  school(x: number, y: number, range: number, krill: boolean | null) {
    const out = this.schoolOut;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const f of this.fish) {
      if (!f.alive || (krill !== null && (f.species === KRILL) !== krill)) continue;
      if ((f.x - x) ** 2 + (f.y - y) ** 2 > range * range) continue;
      sx += f.x;
      sy += f.y;
      n++;
    }
    out.n = n;
    out.x = n ? sx / n : x;
    out.y = n ? sy / n : y;
    return out;
  }

  /** x of the nearest food scrap resting on the seabed, or null. */
  restingCrumb(x: number, range: number) {
    let best: number | null = null;
    let bestD = range;
    for (const p of this.particles) {
      if (p.kind !== 2 || p.y < this.floorAt(p.x) - 3) continue;
      const d = Math.abs(p.x - x);
      if (d < bestD) {
        bestD = d;
        best = p.x;
      }
    }
    return best;
  }

  eatCrumb(x: number) {
    for (const p of this.particles) {
      if (p.kind === 2 && Math.abs(p.x - x) < 10) {
        p.y = this.floorAt(p.x);
        p.life = 0;
        return;
      }
    }
  }

  splash(x: number, y: number) {
    this.emit("splash", x, y);
    const r = 240;
    for (const f of this.fish) {
      if (!f.alive) continue;
      const dx = f.x - x;
      const dy = f.y - y;
      const d = Math.hypot(dx, dy);
      if (d > r || d < 1e-3) continue;
      // Flash expansion: everybody nearby bolts straight out.
      const k = (1 - d / r) * 260;
      f.vx += (dx / d) * k;
      f.vy += (dy / d) * k;
      f.alarm = 1;
    }
    // A sudden disturbance makes an octopus ink and bolt.
    for (const c of this.creatures) {
      if (c.alive && c.kind === "octopus" && Math.hypot(c.x - x, c.y - y) < 160 && c.state !== "jetting away (ink!)") {
        c.state = "jetting away (ink!)";
        c.stateT = 0;
        this.ink(c.x, c.y);
      }
    }
  }

  // ── simulation ──────────────────────────────────────────────────────

  step(dt: number) {
    this.time += dt;
    this.rebuildHash();
    this.stepCreatures(dt);
    this.stepFish(dt);
    this.stepParticles(dt);
    this.respawnFish();
  }

  private stepCreatures(dt: number) {
    this.herds.length = 0;
    this.lures.length = 0;
    this.threats.length = 0;
    for (const c of this.creatures) {
      if (!c.alive) {
        if (this.time >= c.respawnAt) respawn(c, this);
        continue;
      }
      const def = DEFS[c.kind];
      c.stateT += dt;
      def.think(c, this, dt);
      integrate(c, def, this, dt);
      if (def.fear > 0) {
        const fx = (c.face >= 0 ? 1 : -1) * Math.cos(c.pitch);
        const fy = -Math.sin(c.pitch);
        const half = c.L * 0.45;
        this.threats.push({ x0: c.x + fx * half, y0: c.y + fy * half, x1: c.x - fx * half, y1: c.y - fy * half, r: def.fear * c.L + 40, fx, fy });
      }
    }
  }

  private rebuildHash() {
    const size = this.perception;
    const pad = 2;
    this.bucketCols = Math.ceil(this.width / size) + pad * 2;
    this.bucketRows = Math.ceil(this.height / size) + pad * 2;
    const n = this.bucketCols * this.bucketRows;
    if (this.bucketHead.length !== n) {
      this.bucketHead = new Int32Array(n);
      this.bucketCount = new Uint16Array(n);
    }
    this.bucketHead.fill(-1);
    this.bucketCount.fill(0);
    if (this.bucketNext.length !== this.fish.length) this.bucketNext = new Int32Array(this.fish.length);
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i];
      if (!f.alive) continue;
      const b = this.bucketOf(f.x, f.y);
      this.bucketNext[i] = this.bucketHead[b];
      this.bucketHead[b] = i;
      this.bucketCount[b]++;
    }
  }

  private bucketOf(x: number, y: number) {
    const size = this.perception;
    const c = clamp(Math.floor(x / size) + 2, 0, this.bucketCols - 1);
    const r = clamp(Math.floor(y / size) + 2, 0, this.bucketRows - 1);
    return r * this.bucketCols + c;
  }

  private stepFish(dt: number) {
    const { fish, threats, herds, lures, pointer, width: W, height: H, time } = this;
    const R = this.perception;
    const R2 = R * R;
    const foreignSep = this.foreignSep;
    const size = this.perception;
    const cols = this.bucketCols;
    const rows = this.bucketRows;
    const head = this.bucketHead;
    const next = this.bucketNext;
    const cur = this.cur;
    const calmDecay = Math.exp(-dt * 0.7);
    const contagion = Math.min(1, dt * 6);
    const night = this.night;

    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (!f.alive) continue;
      const sp = SPECIES[f.species];
      const spread = 1 + 1.8 * f.alarm;
      const sepX = this.sepX[f.species] * spread;
      const sepY = this.sepY[f.species] * spread;

      const speed = Math.hypot(f.vx, f.vy) || 1;
      const hx = f.vx / speed;
      const hy = f.vy / speed;

      let ax = 0;
      let ay = 0;
      let sx = 0;
      let sy = 0;
      let avx = 0;
      let avy = 0;
      let cx = 0;
      let cy = 0;
      let n = 0;
      let neighbourAlarm = 0;

      const bc = clamp(Math.floor(f.x / size) + 2, 0, cols - 1);
      const br = clamp(Math.floor(f.y / size) + 2, 0, rows - 1);
      for (let r = Math.max(0, br - 1); r <= Math.min(rows - 1, br + 1); r++) {
        for (let c = Math.max(0, bc - 1); c <= Math.min(cols - 1, bc + 1); c++) {
          let j = head[r * cols + c];
          while (j !== -1) {
            if (j !== i) {
              const o = fish[j];
              const dx = o.x - f.x;
              const dy = o.y - f.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < R2 && d2 > 1e-6) {
                const d = Math.sqrt(d2);
                if ((dx * hx + dy * hy) / d > BLIND_COS) {
                  const qx = dx / sepX;
                  const qy = dy / sepY;
                  const q2 = qx * qx + qy * qy;
                  if (q2 < 1) {
                    const q = Math.sqrt(q2) || 1e-3;
                    const k = (1 - q) / q;
                    sx -= qx * k;
                    sy -= qy * k;
                  }
                  if (o.species === f.species) {
                    avx += o.vx;
                    avy += o.vy;
                    cx += dx;
                    cy += dy;
                    n++;
                  } else if (d < foreignSep) {
                    const k = ((1 - d / foreignSep) / d) * 0.6;
                    sx -= dx * k;
                    sy -= dy * k;
                  }
                  if (o.alarm > neighbourAlarm) neighbourAlarm = o.alarm;
                }
              }
            }
            j = next[j];
          }
        }
      }

      ax += sx * FISH_SEPARATION_K;
      ay += sy * FISH_SEPARATION_K;
      if (n > 0) {
        const alignK = FISH_ALIGN_K * sp.align;
        const cohesionK = FISH_COHESION_K * sp.cohesion * (1 - 0.8 * f.alarm);
        ax += (avx / n - f.vx) * alignK + (cx / n) * cohesionK;
        ay += (avy / n - f.vy) * alignK + (cy / n) * cohesionK;
        if (sp.mill > 0) {
          const cl = Math.hypot(cx, cy) || 1;
          ax += (-cy / cl) * f.millDir * sp.mill * (1 - f.alarm);
          ay += (cx / cl) * f.millDir * sp.mill * (1 - f.alarm);
        }
      }

      // Predators: distance to the nearest point on each animal's head-to-tail line.
      let fear = 0;
      for (const th of threats) {
        const segX = th.x1 - th.x0;
        const segY = th.y1 - th.y0;
        const u = clamp(((f.x - th.x0) * segX + (f.y - th.y0) * segY) / (segX * segX + segY * segY || 1), 0, 1);
        const dx = f.x - (th.x0 + segX * u);
        const dy = f.y - (th.y0 + segY * u);
        const d = Math.hypot(dx, dy);
        if (d >= th.r || d < 1e-3) continue;
        let w = 1 - d / th.r;
        w *= w;
        // Fountain effect: break to whichever side of the predator's path you're on.
        const side = th.fx * (f.y - th.y0) - th.fy * (f.x - th.x0) >= 0 ? 1 : -1;
        ax += ((dx / d) * 0.7 - th.fy * side * 0.9) * FISH_FLEE_K * w;
        ay += ((dy / d) * 0.7 + th.fx * side * 0.9) * FISH_FLEE_K * w;
        fear = Math.max(fear, Math.sqrt(w));
      }

      // Herding (orca carousel, bubble net): fish are driven into a tight ball.
      for (const h of herds) {
        const dx = h.x - f.x;
        const dy = h.y - f.y;
        const d = Math.hypot(dx, dy);
        if (d < h.r && d > 1) {
          ax += (dx / d) * 260 * (d / h.r);
          ay += (dy / d) * 260 * (d / h.r);
        }
      }

      // Calm fish drift toward an anglerfish's glowing lure.
      if (f.alarm < 0.3) {
        for (const l of lures) {
          const dx = l.x - f.x;
          const dy = l.y - f.y;
          const d = Math.hypot(dx, dy);
          if (d < l.r && d > 1) {
            ax += (dx / d) * 110 * (1 - d / l.r);
            ay += (dy / d) * 110 * (1 - d / l.r);
          }
        }
      }

      if (pointer.active) {
        const pr = 130;
        const dx = f.x - pointer.x;
        const dy = f.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < pr && d > 1e-3) {
          const w = (1 - d / pr) ** 2;
          ax += (dx / d) * FISH_FLEE_K * w;
          ay += (dy / d) * FISH_FLEE_K * w;
          fear = Math.max(fear, Math.sqrt(w) * 0.8);
        }
      }

      let alarm = Math.max(f.alarm * calmDecay, fear);
      const relayed = neighbourAlarm * 0.86;
      if (relayed > alarm) alarm += (relayed - alarm) * contagion;
      f.alarm = alarm;

      // Preferred depth for this time of day.
      const floor = this.floorAt(f.x);
      const pref = (lerp(sp.day, sp.night, night) + f.band) * floor;
      const slack = H * 0.07;
      const off = pref - f.y;
      if (off > slack) ay += (off - slack) * 0.9;
      else if (off < -slack) ay += (off + slack) * 0.9;

      // Soft walls: surface, sides, seabed.
      const m = 36;
      if (f.x < m) ax += (m - f.x) * 7;
      else if (f.x > W - m) ax -= (f.x - (W - m)) * 7;
      if (f.y < m) ay += (m - f.y) * 7;
      else if (f.y > floor - 24) ay -= (f.y - (floor - 24)) * 12;

      current(f.x, f.y, time, cur);
      ax += cur.x * 0.5 + (Math.random() - 0.5) * sp.jitter;
      ay += cur.y * 0.5 + (Math.random() - 0.5) * sp.jitter;
      ay -= f.vy * sp.verticalDrag * (1 - 0.7 * f.alarm);

      const preferred = sp.cruise * (1 + 1.3 * f.alarm);
      ax += (preferred - speed) * hx * 1.6;
      ay += (preferred - speed) * hy * 1.6;

      const before = Math.atan2(f.vy, f.vx);
      f.vx += ax * dt;
      f.vy += ay * dt;
      const maxSpeed = sp.maxSpeed * (1 + 1.8 * f.alarm);
      const s = Math.hypot(f.vx, f.vy);
      if (s > maxSpeed) {
        f.vx *= maxSpeed / s;
        f.vy *= maxSpeed / s;
      } else if (s < sp.minSpeed && s > 1e-3) {
        f.vx *= sp.minSpeed / s;
        f.vy *= sp.minSpeed / s;
      }
      f.turn += (angleDiff(before, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 8);
      f.phase += dt * (7 + Math.hypot(f.vx, f.vy) * 0.12);
      f.x = clamp(f.x + f.vx * dt, -60, W + 60);
      f.y = clamp(f.y + f.vy * dt, -60, H + 60);
    }
  }

  private stepParticles(dt: number) {
    const { particles: ps, width: W, time } = this;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      if (p.kind === 0) {
        p.y += p.v * dt;
        p.x += Math.sin(time * 0.3 + p.v) * 4 * dt;
        if (p.y > this.floorAt(p.x)) {
          p.y = -4;
          p.x = rand(0, W);
        }
      } else if (p.kind === 1) {
        p.y -= p.v * dt;
        p.v = Math.min(80, p.v + 40 * dt);
        p.x += Math.sin(time * 4 + p.life * 20) * 12 * dt;
        if (p.y < -5) ps.splice(i, 1);
      } else {
        const fl = this.floorAt(p.x) - 2;
        if (p.y < fl) p.y = Math.min(fl, p.y + p.v * dt);
        else {
          p.life -= dt;
          if (p.life <= 0) ps.splice(i, 1);
        }
      }
    }
  }

  private respawnFish() {
    const { time, width: W } = this;
    const due: Fish[] = [];
    for (const f of this.fish) if (!f.alive && f.respawnAt <= time) due.push(f);
    if (due.length === 0) return;
    if (due.length < 6 && time - this.lastSpawn < 9) return;
    this.lastSpawn = time;

    // A new school swims in from one side, at its species' depth.
    const left = Math.random() < 0.5;
    const species = pickSpecies();
    const sp = SPECIES[species];
    const band = rand(-0.1, 0.1);
    const x = left ? -20 : W + 20;
    const y = clamp(lerp(sp.day, sp.night, this.night) + band, 0.05, 0.9) * this.floorAt(x);
    const inward = (left ? 0 : Math.PI) + rand(-0.3, 0.3);
    const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    for (const f of due.slice(0, sp.schoolSize[1])) {
      Object.assign(f, {
        alive: true, species, alarm: 0, turn: 0, millDir, band,
        x: x + rand(-1, 1) * this.perception,
        y: y + rand(-1, 1) * this.perception,
        vx: Math.cos(inward) * sp.cruise * 1.4,
        vy: Math.sin(inward) * sp.cruise * 1.4,
      });
    }
  }
}
