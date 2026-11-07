export interface Species {
  name: string;
  cruise: number;
  maxSpeed: number;
  minSpeed: number;
  /** Relative odds of a new school being this species. */
  weight: number;
  schoolSize: [number, number];
  /** Personal space in grid cells (x, y), so every fish gets its own glyph. */
  spacing: [number, number];
  // Behaviour weights. Different mixes produce different collective shapes
  // (Couzin et al. 2002): strong alignment gives polarised schools and
  // ribbons, low alignment gives swarms, and a tangential pull gives a mill.
  align: number;
  cohesion: number;
  jitter: number;
  /** Tangential pull around the local centre: >0 makes a rotating bait ball. */
  mill: number;
  /** Damps vertical speed; real fish mostly cruise level. */
  verticalDrag: number;
  glyph: string;
  rgb: [number, number, number];
  /** Bioluminescent: pulses, and shines brighter at night. */
  glow: boolean;
  /**
   * Preferred depth as a fraction of the water column (0 surface → 1 seabed), by day
   * and by night. Lanternfish and krill make the diel vertical migration: deep by day,
   * up near the surface at night — the largest daily migration on Earth.
   */
  day: number;
  night: number;
}

export const SPECIES: Species[] = [
  {
    name: "Sardine",
    cruise: 36, maxSpeed: 64, minSpeed: 18, weight: 3,
    schoolSize: [18, 28], spacing: [1.8, 1.1],
    align: 1.6, cohesion: 1.6, jitter: 40, mill: 70, verticalDrag: 0.5,
    glyph: "-", rgb: [220, 232, 255], glow: false, day: 0.3, night: 0.24,
  },
  {
    name: "Anchovy",
    cruise: 46, maxSpeed: 78, minSpeed: 22, weight: 3,
    schoolSize: [20, 32], spacing: [1.5, 1],
    align: 3.2, cohesion: 0.45, jitter: 30, mill: 0, verticalDrag: 1.4,
    glyph: "-", rgb: [196, 214, 236], glow: false, day: 0.4, night: 0.32,
  },
  {
    name: "Lanternfish",
    cruise: 30, maxSpeed: 60, minSpeed: 12, weight: 2,
    schoolSize: [12, 18], spacing: [1.7, 1.2],
    align: 1.8, cohesion: 1, jitter: 40, mill: 0, verticalDrag: 0.8,
    glyph: "-", rgb: [90, 230, 255], glow: true, day: 0.84, night: 0.26,
  },
  {
    name: "Krill",
    cruise: 12, maxSpeed: 34, minSpeed: 4, weight: 2,
    schoolSize: [30, 44], spacing: [1.1, 0.9],
    align: 0.3, cohesion: 1.8, jitter: 60, mill: 0, verticalDrag: 0.4,
    glyph: "·", rgb: [255, 150, 120], glow: false, day: 0.7, night: 0.22,
  },
];

export const KRILL = SPECIES.findIndex((s) => s.name === "Krill");

const TOTAL_WEIGHT = SPECIES.reduce((sum, s) => sum + s.weight, 0);

export function pickSpecies() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (let i = 0; i < SPECIES.length; i++) {
    r -= SPECIES[i].weight;
    if (r <= 0) return i;
  }
  return 0;
}
