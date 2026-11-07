/**
 * Headless check: run the ocean for a few simulated minutes, assert nothing goes NaN or
 * escapes, and print which behaviours each animal actually got to. `npm run check`
 */
import { World } from "./src/world";

declare const process: { argv: string[] };
const SECONDS = Number(process.argv[2] ?? 400);
const w = new World();
w.resize(1440, 900, 9, 13);
const seen = new Map<string, Set<string>>();

for (let i = 0; i < SECONDS * 60; i++) {
  w.step(1 / 60);
  w.events.length = 0; // normally drained by the renderer
  if (i % 20) continue;
  for (const c of w.creatures) {
    if (!c.alive) continue;
    for (const v of [c.x, c.y, c.vx, c.vy, c.pitch, c.face]) {
      if (!Number.isFinite(v)) throw new Error(`${c.kind} has a non-finite value in state "${c.state}"`);
    }
    if (c.x < -c.L * 3 || c.x > w.width + c.L * 3 || c.y < -c.L || c.y > w.height + c.L) {
      throw new Error(`${c.kind} escaped to (${c.x | 0}, ${c.y | 0}) in state "${c.state}"`);
    }
    if (!seen.has(c.kind)) seen.set(c.kind, new Set());
    seen.get(c.kind)!.add(c.state);
  }
  for (const f of w.fish) if (f.alive && !Number.isFinite(f.x + f.y)) throw new Error("fish went NaN");
}

// Hold the cursor next to the dolphins: they should come over to play.
const pod = w.creatures.filter((c) => c.kind === "dolphin");
w.pointer = { x: pod[0].x + 100, y: pod[0].y, active: true };
for (let i = 0; i < 60 * 10; i++) w.step(1 / 60);
if (!pod.every((c) => c.state === "playing with you (curious)")) throw new Error(`dolphins ignored the cursor: ${pod.map((c) => c.state)}`);
seen.get("dolphin")!.add(pod[0].state);
w.pointer.active = false;

for (const [kind, states] of seen) console.log(kind.padEnd(9), [...states].join(" | "));
const alive = w.fish.filter((f) => f.alive).length;
console.log(`\n${SECONDS}s simulated, ${alive}/${w.fish.length} fish alive, ${w.creatures.length} animals`);
if (seen.size !== 16) throw new Error(`only ${seen.size}/16 animal kinds stayed alive and active`);
