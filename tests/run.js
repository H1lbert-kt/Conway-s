#!/usr/bin/env node
// Validation suite for Conway's Game of Life (B3/S23, WebGL2).
// Stages covered: 1 (scaffold/context) and 2 (GPU simulation core).
// Run: pnpm test   (requires Node 18+ and a Chromium binary; see findChromium).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const SIZE = 64;
const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* not installed */ }
  throw new Error('No Chromium found. Set CHROMIUM_BIN or install one.');
}

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// CPU reference (independent implementation, GL coordinates: y up).
function cpuStep(grid, size) {
  const next = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          n += grid[((y + dy + size) % size) * size + ((x + dx + size) % size)];
        }
      }
      const self = grid[y * size + x];
      next[y * size + x] = (n === 3 || (self && n === 2)) ? 1 : 0;
    }
  }
  return next;
}

// Stage 7: 32-bit cell hash, bit-for-bit mirror of hashCell() in sim.frag.glsl.
// GLSL uint multiply wraps mod 2^32 == Math.imul low bits; >> on uint == >>>.
function hashCell(x, y, g, s) {
  let h = s >>> 0;
  h = (h ^ Math.imul(x >>> 0, 374761393)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ Math.imul(y >>> 0, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
  h = (h ^ Math.imul(g >>> 0, 3266489917)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 3266489917) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

// Stage 7: CPU reference over the full RGBA byte layout (masks + hash inheritance).
// state: Uint8Array size*size*4; gen = generation this step computes from; seed = hash seed.
function cpuStepGenome(state, size, gen, seed) {
  const next = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      const living = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const qx = (x + dx + size) % size;
          const qy = (y + dy + size) % size;
          const i = (qy * size + qx) * 4;
          if (state[i] & 1) {
            n++;
            living.push((state[i + 1] | (state[i + 2] << 8) | ((state[i + 3] & 3) << 16)) >>> 0);
          }
        }
      }
      const si = (y * size + x) * 4;
      const r = state[si];
      const g = state[si + 1];
      const b = state[si + 2];
      const a = state[si + 3];
      const selfAlive = (r & 1) === 1;
      let alive;
      if (n === 8) {
        alive = selfAlive ? ((a & 2) !== 0) : ((a & 1) !== 0);
      } else {
        alive = selfAlive ? (((b >> n) & 1) !== 0) : (((g >> n) & 1) !== 0);
      }
      let outR = 0;
      let outG = g;
      let outB = b;
      let outA = a;
      if (alive) {
        let age = r >> 1;
        if (age < 127) age += 1;
        outR = (age << 1) | 1;
        if (!selfAlive) {
          let genome;
          if (living.length > 0) {
            genome = living[hashCell(x, y, gen, seed) % living.length];
          } else {
            genome = (g | (b << 8) | ((a & 3) << 16)) >>> 0;
          }
          outG = genome & 0xFF;
          outB = (genome >> 8) & 0xFF;
          outA = (a & 0xFC) | ((genome >> 16) & 3);
        }
      }
      next[si] = outR;
      next[si + 1] = outG;
      next[si + 2] = outB;
      next[si + 3] = outA;
    }
  }
  return next;
}

// Stage 8: CPU reference with mutation + full 24-bit lineage inheritance
// (mirror of sim.frag; mutBp = ?mut= in basis points, 0 = stage-7 behavior).
// Stage 14 (#15): exp argument (default 0 = plain game) mirrors ?exp= presets:
//   2 virus — dead-cell pack rewrite by adjacent lineage-63 (VIRUS_DIST rule
//             distance) + mutation lids capped at 62;
//   4 replication — birth veto unless the selected donor's pack occurs
//             REPLICATION_MIN times among the living neighbors.
//   1 border is stamping-only (expScenario); 3 physics has NO CPU mirror —
//   covered by determinism + bounds + a sum/count crosscheck (plan decision).
function cpuStepGenomeMut(state, size, gen, seed, mutBp, exp = 0) {
  const next = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      const living = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const qx = (x + dx + size) % size;
          const qy = (y + dy + size) % size;
          const i = (qy * size + qx) * 4;
          if (state[i] & 1) {
            n++;
            living.push((state[i + 1] | (state[i + 2] << 8) | (state[i + 3] << 16)) >>> 0);
          }
        }
      }
      const si = (y * size + x) * 4;
      const r = state[si];
      const g = state[si + 1];
      const b = state[si + 2];
      const a = state[si + 3];
      const selfAlive = (r & 1) === 1;
      let alive;
      if (n === 8) {
        alive = selfAlive ? ((a & 2) !== 0) : ((a & 1) !== 0);
      } else {
        alive = selfAlive ? (((b >> n) & 1) !== 0) : (((g >> n) & 1) !== 0);
      }
      let outR = 0;
      let outG = g;
      let outB = b;
      let outA = a;
      if (alive) {
        let age = r >> 1;
        if (age < 127) age += 1;
        outR = (age << 1) | 1;
        if (!selfAlive) {
          const h = hashCell(x, y, gen, seed);
          let genome = living.length > 0
            ? living[h % living.length]
            : (g | (b << 8) | (a << 16)) >>> 0;
          let veto = false;
          if (exp === EXP_PRESETS.replication) {
            let copies = 0;
            for (let i = 0; i < living.length; i++) {
              if (living[i] === genome) copies++;
            }
            if (copies < REPLICATION_MIN) veto = true;
          }
          if (veto) {
            alive = false;
            outR = 0;
          } else if (mutBp > 0 && (h % 10000) < mutBp) {
            const bit = Math.floor(h / 10000) % 18;
            genome = (genome ^ (1 << bit)) >>> 0;
            const lid = 1 + ((h >>> 9) % (exp === EXP_PRESETS.virus ? 62 : 63));
            outG = genome & 0xFF;
            outB = (genome >>> 8) & 0xFF;
            outA = ((genome >>> 16) & 0x03) | (lid << 2);
          } else {
            outG = genome & 0xFF;
            outB = (genome >>> 8) & 0xFF;
            outA = (genome >>> 16) & 0xFF;
          }
        }
      }
      if (exp === EXP_PRESETS.virus && !alive) {
        // Contagion (stage 14): first living virus in scan order whose rule
        // distance to this cell's STORED rule is < VIRUS_DIST rewrites it.
        for (let i = 0; i < living.length; i++) {
          const lp = living[i];
          if (((lp >>> 18) & 63) === 63) {
            const vr = lp & 0x3FFFF;
            const mr = g | (b << 8) | ((a & 3) << 16);
            if (popcount18(vr ^ mr) < VIRUS_DIST) {
              outG = lp & 0xFF;
              outB = (lp >>> 8) & 0xFF;
              outA = ((lp >>> 16) & 0x03) | (63 << 2);
              break;
            }
          }
        }
      }
      next[si] = outR;
      next[si + 1] = outG;
      next[si + 2] = outB;
      next[si + 3] = outA;
    }
  }
  return next;
}

// Stage 10: constants mirrored from sim.frag.glsl / eco.frag.glsl / main.js.
// Stage 13 (#14): AGE ramp gentler (evidence: stage-10 ramp starved worlds
// past ~1800 gens); NICHE_DECAY_T = new scar-decay period in eco.frag.
const ECO = {
  FREQ_SIM_DIST: 4,
  FREQ_PENALTY_T: 4,
  ENERGY_E0: 8,
  ENERGY_B_MIN: 4,
  NICH_T: 48,
  NICHE_DECAY_T: 8,
  GIVE_T: 8,
  RCV_T: 4,
  AGE_Y_MIN: 1,
  AGE_DEATH_START: 127,
  AGE_DEATH_STEP_BP: 10,
};

// Stage 14 (#15): ?exp= preset values + sim.frag constants (mirrored in
// main.js EXP_PRESETS and shaders/sim.frag.glsl).
const EXP_PRESETS = { border: 1, virus: 2, physics: 3, replication: 4 };
const VIRUS_DIST = 6;
const REPLICATION_MIN = 2;

function popcount18(v) {
  let c = 0;
  v = v >>> 0;
  for (let i = 0; i < 18; i++) {
    c += v & 1;
    v >>>= 1;
  }
  return c;
}

// Stage 10: CPU reference for the ecology flags — sim pass mirrors sim.frag
// (freq/age/niche/energy branches + mutation), eco pass mirrors eco.frag
// (births/deaths diffed from old/new main, pool split/merge, spatial flow
// GIVE_T->RCV_T rich->poor flow on pre-event values; niche B is +1 on death
// with no birth write, and since stage 13 decays 1 per NICHE_DECAY_T no-death
// gens via the eco A-channel timer — see eco.frag header).
// opts = { freq, energy, niche, age, mutBp }; returns { state, eco }.
function cpuStepEco(state, eco, size, gen, seed, opts) {
  const freq = opts.freq ? 1 : 0;
  const energy = opts.energy ? 1 : 0;
  const niche = opts.niche ? 1 : 0;
  const age = opts.age ? 1 : 0;
  const mutBp = opts.mutBp | 0;
  const next = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4;
      const r = state[si];
      const g = state[si + 1];
      const b = state[si + 2];
      const a = state[si + 3];
      const selfAlive = (r & 1) === 1;
      const selfPack18 = (g | (b << 8) | ((a & 3) << 16)) >>> 0;
      let n = 0;
      const living = [];
      const livingAges = [];
      let similarCount = 0;
      let nicheRich = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const qx = (x + dx + size) % size;
          const qy = (y + dy + size) % size;
          const i = (qy * size + qx) * 4;
          if (state[i] & 1) {
            n++;
            const tg = state[i + 1];
            const tb = state[i + 2];
            const ta = state[i + 3];
            living.push((tg | (tb << 8) | (ta << 16)) >>> 0);
            livingAges.push(state[i] >> 1);
            if (freq) {
              const pack18 = (tg | (tb << 8) | ((ta & 3) << 16)) >>> 0;
              if (popcount18(selfPack18 ^ pack18) <= ECO.FREQ_SIM_DIST) similarCount++;
            }
            if (niche && eco[i + 2] >= ECO.NICH_T) nicheRich = true;
          }
        }
      }
      let alive;
      if (n === 8) {
        alive = selfAlive ? ((a & 2) !== 0) : ((a & 1) !== 0);
      } else {
        alive = selfAlive ? (((b >> n) & 1) !== 0) : (((g >> n) & 1) !== 0);
      }
      if (niche && selfAlive && !alive && n === 4 && nicheRich) alive = true;
      if (alive && selfAlive && freq && similarCount >= ECO.FREQ_PENALTY_T) alive = false;
      if (alive && selfAlive && age) {
        const curAge = r >> 1;
        if (curAge >= ECO.AGE_DEATH_START) {
          const h = hashCell(x, y, gen, seed);
          const thr = Math.min(10000, (curAge - ECO.AGE_DEATH_START + 1) * ECO.AGE_DEATH_STEP_BP);
          if ((h % 10000) < thr) alive = false;
        }
      }
      let outR = 0;
      let outG = g;
      let outB = b;
      let outA = a;
      if (alive) {
        let curAge = r >> 1;
        if (curAge < 127) curAge += 1;
        outR = (curAge << 1) | 1;
        if (!selfAlive) {
          let genome;
          let donorAge = 0;
          let h = 0;
          if (living.length > 0) {
            h = hashCell(x, y, gen, seed);
            const idx = h % living.length;
            genome = living[idx];
            donorAge = livingAges[idx];
          } else {
            genome = (g | (b << 8) | (a << 16)) >>> 0;
          }
          let veto = false;
          if (age && living.length > 0 && donorAge < ECO.AGE_Y_MIN) veto = true;
          if (energy && eco[si + 1] < ECO.ENERGY_B_MIN) veto = true;
          if (veto) {
            outR = 0;
          } else {
            if (living.length === 0) h = hashCell(x, y, gen, seed);
            if (mutBp > 0 && (h % 10000) < mutBp) {
              const bit = Math.floor(h / 10000) % 18;
              genome = (genome ^ (1 << bit)) >>> 0;
              const lid = 1 + ((h >>> 9) % 63);
              outG = genome & 0xFF;
              outB = (genome >>> 8) & 0xFF;
              outA = ((genome >>> 16) & 0x03) | (lid << 2);
            } else {
              outG = genome & 0xFF;
              outB = (genome >>> 8) & 0xFF;
              outA = (genome >>> 16) & 0xFF;
            }
          }
        }
      }
      next[si] = outR;
      next[si + 1] = outG;
      next[si + 2] = outB;
      next[si + 3] = outA;
    }
  }
  const nextEco = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const si = i * 4;
    const x = i % size;
    const y = (i / size) | 0;
    const oldAlive = state[si] & 1;
    const newAlive = next[si] & 1;
    let er = eco[si];
    let eg = eco[si + 1];
    let eb = eco[si + 2];
    let ea = eco[si + 3];
    const gPre = eco[si + 1];
    const bornSelf = !oldAlive && newAlive;
    const diedSelf = oldAlive && !newAlive;
    if (!oldAlive && newAlive) {
      const part = eg >> 1;
      er = part;
      eg = eg - part;
    } else if (oldAlive && !newAlive) {
      eg = eg + er;
      er = 0;
      eb = eb < 255 ? eb + 1 : eb;
    }
    // Spatial flow (mirrors eco.frag): pre-event self/neighbor pools; a
    // non-birthing rich texel (>= GIVE_T) gives 1 to each poor neighbor
    // (< RCV_T), a poor texel takes 1 from each non-birthing rich neighbor.
    // Pair-symmetric => exact.
    let flow = 0;
    if (!bornSelf && gPre >= ECO.GIVE_T) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const qi = (((y + dy + size) % size) * size + ((x + dx + size) % size)) * 4;
          if (eco[qi + 1] < ECO.RCV_T) flow -= 1;
        }
      }
    } else if (gPre < ECO.RCV_T) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const qi = (((y + dy + size) % size) * size + ((x + dx + size) % size)) * 4;
          if (eco[qi + 1] >= ECO.GIVE_T) {
            const qBorn = !(state[qi] & 1) && (next[qi] & 1);
            if (!qBorn) flow += 1;
          }
        }
      }
    }
    eg = eg + flow;
    // Niche scar decay timer (stage 13, mirrors eco.frag): death resets,
    // quiescence decays B by 1 every NICHE_DECAY_T generations.
    if (diedSelf) {
      ea = 0;
    } else if (ea >= ECO.NICHE_DECAY_T) {
      eb = eb > 0 ? eb - 1 : 0;
      ea = 0;
    } else {
      ea = ea + 1;
    }
    nextEco[si] = er;
    nextEco[si + 1] = eg;
    nextEco[si + 2] = eb;
    nextEco[si + 3] = ea;
  }
  return { state: next, eco: nextEco };
}

function toRgba(grid) {
  const buf = new Uint8Array(grid.length * 4);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i]) buf[i * 4] = 255;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function gpuGrid(page) {
  return page.evaluate(() => {
    const L = window.__life;
    const buf = L.read(0, 0, L.size, L.size);
    const g = new Uint8Array(L.size * L.size);
    for (let i = 0; i < g.length; i++) g[i] = buf[i * 4] > 127 ? 1 : 0;
    return Array.from(g);
  }).then((a) => Uint8Array.from(a));
}

async function seedGrid(page, cells) {
  const grid = new Uint8Array(SIZE * SIZE);
  for (const [x, y] of cells) grid[y * SIZE + x] = 1;
  await page.evaluate((rgba) => {
    window.__life.seed(window.__life.size, window.__life.size, new Uint8Array(rgba));
  }, Array.from(toRgba(grid)));
  return grid;
}

function countDiff(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

const popOf = (grid) => { let p = 0; for (let i = 0; i < grid.length; i++) p += grid[i]; return p; };
const wantFromCoords = (coords, size) => {
  const g = new Uint8Array(size * size);
  for (const [x, y] of coords) {
    g[(((y % size) + size) % size) * size + (((x % size) + size) % size)] = 1;
  }
  return g;
};
const shifted = (grid, dx, dy) => {
  const g = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (grid[y * SIZE + x]) g[((y + dy) % SIZE) * SIZE + ((x + dx) % SIZE)] = 1;
    }
  }
  return g;
};
const CELLS = {
  lwss: [[1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [4, 1], [4, 2], [0, 3], [3, 3]],
  mwss: [[2, 0], [0, 1], [4, 1], [5, 2], [0, 3], [5, 3], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4]],
  pulsar: [
    [2, 0], [3, 0], [4, 0], [8, 0], [9, 0], [10, 0],
    [0, 2], [5, 2], [7, 2], [12, 2],
    [0, 3], [5, 3], [7, 3], [12, 3],
    [0, 4], [5, 4], [7, 4], [12, 4],
    [2, 5], [3, 5], [4, 5], [8, 5], [9, 5], [10, 5],
    [2, 7], [3, 7], [4, 7], [8, 7], [9, 7], [10, 7],
    [0, 8], [5, 8], [7, 8], [12, 8],
    [0, 9], [5, 9], [7, 9], [12, 9],
    [0, 10], [5, 10], [7, 10], [12, 10],
    [2, 12], [3, 12], [4, 12], [8, 12], [9, 12], [10, 12],
  ],
  penta: [
    [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0],
    [1, 1], [8, 1],
    [0, 2], [9, 2],
    [1, 3], [8, 3],
    [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4],
  ],
  acorn: [[1, 0], [3, 1], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2]],
  diehard: [[6, 0], [0, 1], [1, 1], [1, 2], [5, 2], [6, 2], [7, 2]],
};
const GUN_CELLS = [
  [24, 0], [22, 1], [24, 1],
  [12, 2], [13, 2], [20, 2], [21, 2], [34, 2], [35, 2],
  [11, 3], [15, 3], [20, 3], [21, 3], [34, 3], [35, 3],
  [0, 4], [1, 4], [10, 4], [16, 4], [20, 4], [21, 4],
  [0, 5], [1, 5], [10, 5], [14, 5], [16, 5], [17, 5], [22, 5], [24, 5],
  [10, 6], [16, 6], [24, 6], [11, 7], [15, 7], [12, 8], [13, 8],
];
const SCENE_PARTS = {
  duel: GUN_CELLS.concat(GUN_CELLS.map(([x, y]) => [83 - x, y])),
  fleet: GUN_CELLS
    .concat(CELLS.lwss.map(([x, y]) => [x + 45, y + 12]))
    .concat(CELLS.lwss.map(([x, y]) => [x + 53, y + 17]))
    .concat(CELLS.lwss.map(([x, y]) => [x + 45, y + 22])),
};

// Stage 14: mirror of main.js applyExpScenario (same size-relative bounds and
// masks) — RGBA state in GL byte layout, used to validate the boot stamp and
// to run the CPU reference from the exact same initial state.
function expScenario(size, exp) {
  const st = new Uint8Array(size * size * 4);
  const half = size >> 1;
  const set = (x, y) => {
    const wx = ((x % size) + size) % size;
    const wy = ((y % size) + size) % size;
    const i = (wy * size + wx) * 4;
    st[i] = 1;
    st[i + 1] = wx >= half ? 0x48 : 0x08;
    st[i + 2] = 0x0c;
    st[i + 3] = 0;
  };
  if (exp === EXP_PRESETS.border) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        st[i + 1] = x >= half ? 0x48 : 0x08;
        st[i + 2] = 0x0c;
      }
    }
    const rings = [[-1, -1], [0, -1], [1, -1], [-1, 1], [0, 1], [1, 1]];
    for (const cx of [Math.floor(size / 4), Math.floor((3 * size) / 4)]) {
      for (const d of rings) set(cx + d[0], half + d[1]);
    }
    const glider = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
    for (const d of glider) set(half - 6 + d[0], 4 + d[1]);
  } else if (exp === EXP_PRESETS.virus) {
    const pA = size >> 3;
    const pB = size >> 2;
    const pC = half + (size >> 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const soup = ((x * 3 + y * 5) % 7) < 3;
        if (x < pB) {
          st[i] = soup ? 1 : 0;
          st[i + 1] = 0x08;
          st[i + 2] = 0x0c;
          st[i + 3] = x >= pA ? 63 << 2 : 0;
        } else if (x < pC) {
          st[i + 1] = 0;
          st[i + 2] = 0;
        } else {
          st[i] = soup ? 1 : 0;
          st[i + 1] = 0xf8;
          st[i + 2] = 0xfc;
          st[i + 3] = 0x03;
        }
      }
    }
  } else if (exp === EXP_PRESETS.physics) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const heavy = ((x + y) & 1) === 0;
        st[i] = ((x * 3 + y * 5) % 7) < 3 ? 1 : 0;
        st[i + 1] = heavy ? 0xf8 : 0x08;
        st[i + 2] = heavy ? 0xfc : 0x0c;
        st[i + 3] = heavy ? 0x03 : 0;
      }
    }
  } else if (exp === EXP_PRESETS.replication) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const rare = ((x * 7 + y * 3) % 11) === 0;
        st[i] = ((x * 3 + y * 5) % 7) < 3 ? 1 : 0;
        st[i + 1] = rare ? 0x0a : 0x08;
        st[i + 2] = 0x0c;
        st[i + 3] = 0;
      }
    }
  }
  return st;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
  });

  const console_ = [];
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  page.on('console', (m) => console_.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => {
    window.__counters = { textures: 0, framebuffers: 0, readPixels: 0, drawArrays: 0 };
    const W2 = WebGL2RenderingContext.prototype;
    for (const [name, key] of [['createTexture', 'textures'], ['createFramebuffer', 'framebuffers']]) {
      const orig = W2[name];
      W2[name] = function () { window.__counters[key]++; return orig.apply(this, arguments); };
    }
    const origRead = W2.readPixels;
    W2.readPixels = function () { window.__counters.readPixels++; return origRead.apply(this, arguments); };
    const origDraw = W2.drawArrays;
    W2.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
  });

  // ---- Stage 1 ----
  await page.goto(`${base}?size=${SIZE}&sps=0.0001`);
  await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
  const errEl = await page.evaluate(() => document.getElementById('error')?.textContent ?? null);
  record('stage1: webgl2 context + shaders load', !errEl && pageErrors.length === 0 && !console_.some((c) => c.startsWith('[error]')), errEl || console_.filter((c) => c.startsWith('[error]')).join('; ') || undefined);
  await page.evaluate(() => window.__life.setAuto(false));

  const box = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
  });
  record('stage1: canvas covers viewport', box.w === box.iw && box.h === box.ih, JSON.stringify(box));

  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(300);
  const box2 = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
  });
  record('stage1: canvas follows resize', box2.w === box2.iw && box2.h === box2.ih, JSON.stringify(box2));

  const countersA = await page.evaluate(() => window.__counters);
  await page.waitForTimeout(500);
  const countersB = await page.evaluate(() => window.__counters);
  record('stage1: sim targets allocated once', countersB.textures === 2 && countersB.framebuffers === 2, JSON.stringify(countersB));
  record('stage1: render loop advances', countersB.drawArrays > countersA.drawArrays, `${countersA.drawArrays} -> ${countersB.drawArrays}`);

  // ---- Stage 2 ----
  const L = await page.evaluate(() => ({ size: window.__life.size }));
  record('stage2: grid size honored', L.size === SIZE, `size=${L.size}`);

  await page.evaluate(() => window.__life.step(5));
  const empty = await gpuGrid(page);
  record('stage2: empty grid stays empty', empty.every((v) => v === 0));

  await seedGrid(page, [[32, 32]]);
  await page.evaluate(() => window.__life.step(1));
  const single = await gpuGrid(page);
  record('stage2: single cell dies', single.every((v) => v === 0));

  const blockCells = [[10, 10], [11, 10], [10, 11], [11, 11]];
  await seedGrid(page, blockCells);
  await page.evaluate(() => window.__life.step(10));
  const block = await gpuGrid(page);
  const blockWant = new Uint8Array(SIZE * SIZE);
  for (const [x, y] of blockCells) blockWant[y * SIZE + x] = 1;
  record('stage2: block still-life stable', countDiff(block, blockWant) === 0);

  await seedGrid(page, [[20, 30], [21, 30], [22, 30]]);
  await page.evaluate(() => window.__life.step(1));
  const blinkerV = await gpuGrid(page);
  const vWant = new Uint8Array(SIZE * SIZE);
  for (const [x, y] of [[21, 29], [21, 30], [21, 31]]) vWant[y * SIZE + x] = 1;
  record('stage2: blinker -> vertical', countDiff(blinkerV, vWant) === 0);
  await page.evaluate(() => window.__life.step(1));
  const blinkerH = await gpuGrid(page);
  const hWant = new Uint8Array(SIZE * SIZE);
  for (const [x, y] of [[20, 30], [21, 30], [22, 30]]) hWant[y * SIZE + x] = 1;
  record('stage2: blinker period 2', countDiff(blinkerH, hWant) === 0);

  // glider vs CPU reference (interior)
  const GLIDER = [[1, 2], [2, 1], [0, 0], [1, 0], [2, 0]];
  {
    let ref = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GLIDER) ref[(10 + y) * SIZE + (10 + x)] = 1;
    await seedGrid(page, GLIDER.map(([x, y]) => [10 + x, 10 + y]));
    const checkpoints = [1, 2, 4, 8, 20];
    let worst = 0;
    for (let g = 1; g <= 20; g++) {
      ref = cpuStep(ref, SIZE);
      await page.evaluate(() => window.__life.step(1));
      if (checkpoints.includes(g)) {
        const got = await gpuGrid(page);
        worst = Math.max(worst, countDiff(ref, got));
      }
    }
    record('stage2: glider matches CPU reference (interior)', worst === 0, `max mismatches=${worst}`);
  }

  // glider vs CPU reference (crossing the wrap edge)
  {
    let ref = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GLIDER) ref[((SIZE - 2 + y) % SIZE) * SIZE + ((SIZE - 2 + x) % SIZE)] = 1;
    await seedGrid(page, GLIDER.map(([x, y]) => [(SIZE - 2 + x) % SIZE, (SIZE - 2 + y) % SIZE]));
    const checkpoints = [1, 4, 8, 16, 40];
    let worst = 0;
    for (let g = 1; g <= 40; g++) {
      ref = cpuStep(ref, SIZE);
      await page.evaluate(() => window.__life.step(1));
      if (checkpoints.includes(g)) {
        const got = await gpuGrid(page);
        worst = Math.max(worst, countDiff(ref, got));
      }
    }
    record('stage2: glider wraps toroidally (matches CPU)', worst === 0, `max mismatches=${worst}`);
  }

  // glider translates (+1,+1) every 4 generations
  {
    const CELLS = [[1, 2], [0, 1], [0, 0], [1, 0], [2, 0]];
    const ref = await seedGrid(page, CELLS.map(([x, y]) => [10 + x, 10 + y]));
    await page.evaluate(() => window.__life.step(4));
    const after = await gpuGrid(page);
    let ok = true;
    for (let y = 0; y < SIZE && ok; y++) {
      for (let x = 0; x < SIZE && ok; x++) {
        if (after[y * SIZE + x] !== ref[((y + 1) % SIZE) * SIZE + ((x + 1) % SIZE)]) ok = false;
      }
    }
    record('stage2: glider moves (+1,+1) per 4 generations', ok);
  }

  // ---- Stage 3: display + camera ----
  {
    const ALIVE = [235, 240, 255];
    const DEAD = [11, 11, 16];
    const near = (got, want) => Math.abs(got[0] - want[0]) <= 8 && Math.abs(got[1] - want[1]) <= 8 && Math.abs(got[2] - want[2]) <= 8;

    const screenAt = (p, wx, wy) => p.evaluate(([wx, wy]) => {
      const L = window.__life;
      const c = document.querySelector('canvas');
      const v = L.view();
      const px = Math.floor((wx - v[0]) / v[2] * c.width);
      const py = Math.floor((wy - v[1]) / v[3] * c.height);
      const b = L.readScreen(px, py, 1, 1);
      return [b[0], b[1], b[2]];
    }, [wx, wy]);

    await seedGrid(page, [[10, 10], [11, 10], [10, 11], [11, 11]]);
    const alivePx = await screenAt(page, 10.5, 10.5);
    const deadPx = await screenAt(page, 30.5, 30.5);
    record('stage3: grid visible, cells distinguishable', near(alivePx, ALIVE) && near(deadPx, DEAD), `alive=${alivePx} dead=${deadPx}`);

    // zoom-to-cursor: the world point under the cursor must not move
    await page.mouse.move(200, 150);
    const worldUnder = () => page.evaluate(() => {
      const L = window.__life;
      const c = document.querySelector('canvas');
      const v = L.view();
      const ux = 200 / c.clientWidth;
      const uy = 1 - 150 / c.clientHeight;
      return { wx: v[0] + ux * v[2], wy: v[1] + uy * v[3], cellsX: v[2] };
    });
    const before = await worldUnder();
    await page.mouse.wheel(0, -240);
    const after = await worldUnder();
    record(
      'stage3: zoom-to-cursor keeps world point fixed',
      Math.abs(after.wx - before.wx) < 1e-6 && Math.abs(after.wy - before.wy) < 1e-6 && after.cellsX < before.cellsX,
      `cellsX ${before.cellsX.toFixed(2)} -> ${after.cellsX.toFixed(2)}`,
    );

    // zoom grows the on-screen width of a seeded column
    const bar = [];
    for (let y = 0; y < SIZE; y++) bar.push([32, y]);
    await seedGrid(page, bar);
    const runLength = () => page.evaluate(() => {
      const L = window.__life;
      const c = document.querySelector('canvas');
      const b = L.readScreen(0, Math.floor(c.height / 2), c.width, 1);
      let min = -1;
      let max = -1;
      for (let i = 0; i < c.width; i++) {
        if (b[i * 4] > 128) {
          if (min < 0) min = i;
          max = i;
        }
      }
      return max >= 0 ? max - min + 1 : 0;
    });
    const runBefore = await runLength();
    await page.mouse.wheel(0, -240);
    const runAfter = await runLength();
    record('stage3: zoom-in widens cells on screen', runAfter > runBefore, `${runBefore}px -> ${runAfter}px`);

    // pan: drag (400,300) -> (450,320) must move the origin by the expected delta
    const v0 = await page.evaluate(() => window.__life.view());
    const dims = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return [c.clientWidth, c.clientHeight];
    });
    await page.mouse.move(400, 300);
    await page.mouse.down();
    await page.mouse.move(450, 320);
    await page.mouse.up();
    const v1 = await page.evaluate(() => window.__life.view());
    const expX = v0[0] - (50 / dims[0]) * v0[2];
    const expY = v0[1] + (20 / dims[1]) * v0[3];
    record(
      'stage3: drag pan moves camera by expected delta',
      Math.abs(v1[0] - expX) < 1e-4 && Math.abs(v1[1] - expY) < 1e-4,
      `origin (${v0[0].toFixed(2)},${v0[1].toFixed(2)}) -> (${v1[0].toFixed(2)},${v1[1].toFixed(2)})`,
    );

    // resize after interaction keeps the camera
    const camBefore = await page.evaluate(() => window.__life.view());
    await page.setViewportSize({ width: 900, height: 500 });
    await page.waitForTimeout(200);
    const camAfter = await page.evaluate(() => window.__life.view());
    record('stage3: resize keeps camera after interaction', [0, 1, 2].every((i) => Math.abs(camBefore[i] - camAfter[i]) < 1e-9));

    // resize while untouched refits the view
    const page4 = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    await page4.goto(`${base}?size=${SIZE}&sps=0.0001`);
    await page4.waitForFunction(() => !!window.__life);
    await page4.setViewportSize({ width: 640, height: 480 });
    await page4.waitForTimeout(200);
    const vRefit = await page4.evaluate(() => window.__life.view());
    const refitOk = Math.abs(vRefit[2] - SIZE) < 1e-6 && Math.abs(vRefit[0]) < 1e-6 && Math.abs(vRefit[1] - (SIZE / 2 - vRefit[3] / 2)) < 1e-6;
    record('stage3: resize refits while untouched', refitOk, JSON.stringify(vRefit.map((n) => +n.toFixed(3))));
    await page4.close();

    // 4096 display-only smoke: FPS must stay in the same class as a tiny grid.
    // Absolute FPS under software GL (SwiftShader) is environment-dependent and
    // is measured properly in Stage 5; here we assert 4096 does not tank vs 64.
    const measureFps = async (size) => {
      const p = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
      await p.addInitScript(() => {
        window.__counters = { drawArrays: 0 };
        const origDraw = WebGL2RenderingContext.prototype.drawArrays;
        WebGL2RenderingContext.prototype.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
      });
      await p.goto(`${base}?size=${size}&sps=0.0001`);
      await p.waitForFunction(() => !!window.__life);
      await p.waitForTimeout(400);
      const d0 = await p.evaluate(() => window.__counters.drawArrays);
      await p.waitForTimeout(2000);
      const d1 = await p.evaluate(() => window.__counters.drawArrays);
      await p.close();
      return (d1 - d0) / 2;
    };
    const fpsBase = await measureFps(64);
    const fps4k = await measureFps(4096);
    record(
      'stage3: 4096 display FPS in same class as small grid',
      fps4k >= fpsBase * 0.6,
      `fps@64=${fpsBase.toFixed(1)} fps@4096=${fps4k.toFixed(1)}`,
    );
  }

  // ---- Stage 4: interaction, patterns, controls ----
  {
    await page.evaluate(() => {
      window.__uploads = { texSubImage2D: 0, texImage2D: 0, deleteTexture: 0 };
      const P = WebGL2RenderingContext.prototype;
      for (const [name, key] of [['texSubImage2D', 'texSubImage2D'], ['texImage2D', 'texImage2D'], ['deleteTexture', 'deleteTexture']]) {
        const orig = P[name];
        P[name] = function () { window.__uploads[key]++; return orig.apply(this, arguments); };
      }
    });
    const uploads = () => page.evaluate(() => window.__uploads);
    const gen = () => page.evaluate(() => window.__life.generation());
    const expectedTexel = (mx, my) => page.evaluate(([x, y]) => {
      const c = document.querySelector('canvas');
      const v = window.__life.view();
      return [Math.floor(v[0] + (x / c.clientWidth) * v[2]), Math.floor(v[1] + (1 - y / c.clientHeight) * v[3])];
    }, [mx, my]);
    const wrapIdx = (x, y) => (((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE);

    // clear: single GPU upload, empty grid
    await page.click('#btn-clear');
    const upClear = await uploads();
    const gridClear = await gpuGrid(page);
    record('stage4: clear = 1 GPU upload, grid empty',
      upClear.texSubImage2D === 1 && upClear.texImage2D === 0 && gridClear.every((v) => v === 0),
      JSON.stringify(upClear));

    // randomize: single GPU upload, mixed state
    await page.click('#btn-random');
    const upRand = await uploads();
    const gridRand = await gpuGrid(page);
    let alive0 = 0;
    for (let i = 0; i < gridRand.length; i++) alive0 += gridRand[i];
    const ratio = alive0 / gridRand.length;
    record('stage4: randomize = 1 GPU upload, mixed state',
      upRand.texSubImage2D === 2 && upRand.texImage2D === 0 && ratio > 0.3 && ratio < 0.7,
      `uploads=${upRand.texSubImage2D} ratio=${ratio.toFixed(2)}`);

    // step button (paused): generation +1, exact CPU match
    const beforeStep = await gpuGrid(page);
    const refStep = cpuStep(beforeStep, SIZE);
    const g0 = await gen();
    await page.click('#btn-step');
    const g1 = await gen();
    const afterStep = await gpuGrid(page);
    record('stage4: step button = 1 exact generation',
      g1 === g0 + 1 && countDiff(refStep, afterStep) === 0, `gen ${g0} -> ${g1}`);

    // speed slider + play/pause drive stepping
    await page.evaluate(() => {
      const s = document.getElementById('speed');
      s.value = '40';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const draws0 = await page.evaluate(() => window.__counters.drawArrays);
    const gA = await gen();
    await page.click('#btn-play');
    await page.waitForTimeout(800);
    const gB = await gen();
    await page.click('#btn-play');
    const draws1 = await page.evaluate(() => window.__counters.drawArrays);
    const playLabel = await page.textContent('#btn-play');
    record('stage4: speed slider + play/pause drive stepping',
      gB - gA >= 5 && draws1 > draws0 && playLabel === 'Play',
      `${gB - gA} gens/0.8s, label=${playLabel}`);

    // paint via DOM at current camera (position A)
    await page.click('#btn-clear');
    await page.click('#btn-paint');
    const posA = [320, 240];
    const texA = await expectedTexel(posA[0], posA[1]);
    await page.mouse.move(posA[0], posA[1]);
    await page.mouse.down();
    await page.mouse.up();
    const gridA = await gpuGrid(page);
    let okA = true;
    for (let dy = -2; dy <= 2 && okA; dy++) {
      for (let dx = -2; dx <= 2 && okA; dx++) {
        if (gridA[wrapIdx(texA[0] + dx, texA[1] + dy)] !== 1) okA = false;
      }
    }
    okA = okA && gridA[wrapIdx(texA[0] + 3, texA[1])] === 0 && gridA[wrapIdx(texA[0], texA[1] + 3)] === 0;
    record('stage4: drag paints at camera position (DOM)', okA, `texel=(${texA[0]},${texA[1]})`);

    // change camera (pan + zoom), paint at position B, cell A stays
    await page.click('#btn-paint');
    await page.mouse.move(500, 350);
    await page.mouse.wheel(0, -200);
    await page.mouse.down();
    await page.mouse.move(560, 380);
    await page.mouse.up();
    await page.click('#btn-paint');
    const posB = [640, 300];
    const texB = await expectedTexel(posB[0], posB[1]);
    await page.mouse.move(posB[0], posB[1]);
    await page.mouse.down();
    await page.mouse.up();
    const gridB = await gpuGrid(page);
    let okB = true;
    for (let dy = -2; dy <= 2 && okB; dy++) {
      for (let dx = -2; dx <= 2 && okB; dx++) {
        if (gridB[wrapIdx(texB[0] + dx, texB[1] + dy)] !== 1) okB = false;
      }
    }
    okB = okB && gridB[wrapIdx(texA[0], texA[1])] === 1;
    record('stage4: paint follows new zoom/pan, earlier paint intact', okB, `texelB=(${texB[0]},${texB[1]})`);

    // brush across the torus seam
    await page.click('#btn-paint');
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampBrush(window.__life.size - 1, 10, 2);
    });
    const seam = await gpuGrid(page);
    let seamOk = true;
    for (let dy = -2; dy <= 2 && seamOk; dy++) {
      for (let dx = -2; dx <= 2 && seamOk; dx++) {
        if (seam[wrapIdx(SIZE - 1 + dx, 10 + dy)] !== 1) seamOk = false;
      }
    }
    seamOk = seamOk && seam[10 * SIZE + SIZE - 4] === 0 && seam[10 * SIZE + 3] === 0;
    record('stage4: brush wraps across torus seam', seamOk);

    // brush across both seams at a corner
    await page.evaluate(() => {
      const s = window.__life.size;
      window.__life.clear();
      window.__life.stampBrush(s - 2, s - 2, 2);
    });
    const corner = await gpuGrid(page);
    let cornerOk = true;
    for (let dy = -2; dy <= 2 && cornerOk; dy++) {
      for (let dx = -2; dx <= 2 && cornerOk; dx++) {
        if (corner[wrapIdx(SIZE - 2 + dx, SIZE - 2 + dy)] !== 1) cornerOk = false;
      }
    }
    cornerOk = cornerOk
      && corner[wrapIdx(0, 0)] === 1
      && corner[wrapIdx(SIZE - 1, 0)] === 1
      && corner[wrapIdx(0, SIZE - 1)] === 1
      && corner[wrapIdx(1, 1)] === 0
      && corner[wrapIdx(2, SIZE - 2)] === 0;
    record('stage4: brush wraps across both seams (corner)', cornerOk,
      `alive=${corner.reduce((a, b) => a + b, 0)}/25`);

    // glider pattern stamped exactly
    const GLIDER_CELLS = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 2]];
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('glider', 7, 9);
    });
    const gliderGrid = await gpuGrid(page);
    const gliderWant = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GLIDER_CELLS) gliderWant[(9 + y) * SIZE + (7 + x)] = 1;
    record('stage4: glider pattern stamped exactly', countDiff(gliderGrid, gliderWant) === 0);

    // blinker stamps and evolves one generation exactly
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('blinker', 20, 30);
    });
    const blinkBefore = await gpuGrid(page);
    const blinkRef = cpuStep(blinkBefore, SIZE);
    await page.evaluate(() => window.__life.step(1));
    const blinkAfter = await gpuGrid(page);
    record('stage4: blinker stamps and evolves correctly', countDiff(blinkRef, blinkAfter) === 0);

    // Gosper gun: fingerprint, CPU-exact evolution, population growth (emission)
    const GUN_CELLS = [
      [24, 0], [22, 1], [24, 1],
      [12, 2], [13, 2], [20, 2], [21, 2], [34, 2], [35, 2],
      [11, 3], [15, 3], [20, 3], [21, 3], [34, 3], [35, 3],
      [0, 4], [1, 4], [10, 4], [16, 4], [20, 4], [21, 4],
      [0, 5], [1, 5], [10, 5], [14, 5], [16, 5], [17, 5], [22, 5], [24, 5],
      [10, 6], [16, 6], [24, 6], [11, 7], [15, 7], [12, 8], [13, 8],
    ];
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('gun', 4, 4);
    });
    const gunStamped = await gpuGrid(page);
    const rowWant = [1, 2, 6, 6, 6, 8, 3, 2, 2];
    let rowsOk = true;
    for (let r = 0; r < 9; r++) {
      let c = 0;
      for (let x = 0; x < 36; x++) c += gunStamped[(4 + r) * SIZE + (4 + x)];
      if (c !== rowWant[r]) rowsOk = false;
    }
    record('stage4: Gosper gun fingerprint (36 cells, canonical rows)', rowsOk);

    let refGun = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GUN_CELLS) refGun[(4 + y) * SIZE + (4 + x)] = 1;
    let gunExact = true;
    for (let g = 1; g <= 60; g++) {
      refGun = cpuStep(refGun, SIZE);
      await page.evaluate(() => window.__life.step(1));
      if (g === 10 || g === 30 || g === 60) {
        const got = await gpuGrid(page);
        if (countDiff(refGun, got) !== 0) gunExact = false;
      }
    }
    const gunFinal = await gpuGrid(page);
    let pop60 = 0;
    for (let i = 0; i < gunFinal.length; i++) pop60 += gunFinal[i];
    record('stage4: gun matches CPU for 60 generations', gunExact);
    record('stage4: gun emits gliders (population grows)', pop60 > 41, `pop@60=${pop60}`);

    // pattern stamped via toolbar (DOM)
    await page.click('#btn-clear');
    await page.selectOption('#pattern', 'glider');
    await page.click('#btn-paint');
    const posP = [400, 260];
    const texP = await expectedTexel(posP[0], posP[1]);
    await page.mouse.move(posP[0], posP[1]);
    await page.mouse.down();
    await page.mouse.up();
    const domPattern = await gpuGrid(page);
    const domWant = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GLIDER_CELLS) domWant[wrapIdx(texP[0] + x, texP[1] + y)] = 1;
    record('stage4: pattern stamp via toolbar (DOM)', countDiff(domPattern, domWant) === 0, `texel=(${texP[0]},${texP[1]})`);
    await page.selectOption('#pattern', 'brush');
    await page.click('#btn-paint');

    // grid switch to 2048: reallocated once, rule still exact
    await page.selectOption('#grid-size', '2048');
    await page.waitForTimeout(100);
    const s2048 = await page.evaluate(() => window.__life.size);
    const noErr2048 = await page.evaluate(() => !document.getElementById('error'));
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('blinker', 100, 100);
    });
    const b2048 = await gpuGrid(page);
    const ref2048 = cpuStep(b2048, 2048);
    await page.evaluate(() => window.__life.step(1));
    const a2048 = await gpuGrid(page);
    const up2048 = await uploads();
    record('stage4: grid switch to 2048 keeps rule correct',
      s2048 === 2048 && noErr2048 && countDiff(ref2048, a2048) === 0
      && up2048.texImage2D === 2 && up2048.deleteTexture === 2,
      `texImage2D=${up2048.texImage2D} deleteTexture=${up2048.deleteTexture}`);

    // grid switch to 4096: works, blinker flips correctly
    await page.selectOption('#grid-size', '4096');
    const s4096 = await page.evaluate(() => window.__life.size);
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('blinker', 500, 500);
    });
    const g4096a = await gen();
    await page.evaluate(() => window.__life.step(1));
    const g4096b = await gen();
    const regRaw = await page.evaluate(() => Array.from(window.__life.read(499, 499, 3, 3)));
    const reg = [];
    for (let i = 0; i < 9; i++) reg.push(regRaw[i * 4] > 127 ? 1 : 0);
    const regWant = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    const up4096 = await uploads();
    record('stage4: grid switch to 4096 works, rule correct',
      s4096 === 4096 && g4096b === g4096a + 1 && reg.every((v, i) => v === regWant[i])
      && up4096.texImage2D === 4 && up4096.deleteTexture === 4,
      `size=${s4096} gens=${g4096a}->${g4096b} texImage2D=${up4096.texImage2D} `
      + `deleteTexture=${up4096.deleteTexture} reg=${JSON.stringify(reg)}`);

    // grid options sanity
    const opts = await page.evaluate(() => Array.from(document.getElementById('grid-size').options).map((o) => Number(o.value)));
    record('stage4: grid options are powers of two <= 4096',
      opts.every((v) => v > 0 && (v & (v - 1)) === 0 && v <= 4096), JSON.stringify(opts));
  }

  // ---- Stage 5: validation goldens, HUD, seed, perf ----
  {
    // Gosper gun golden checkpoints (canonical populations + emitted-glider offsets).
    // Offsets derived from the B3/S23 CPU reference with the canonical gun at (10,10)
    // on a 128^2 grid: gun activity stays inside x 10..45, y 10..18; gliders leave it.
    const GUN_OX = 10;
    const GUN_OY = 10;
    const GUN_OUT30 = [[33, 19], [34, 20], [35, 20], [33, 21], [34, 21]];
    const GUN_OUT60 = [[33, 19], [34, 20], [35, 20], [33, 21], [34, 21], [40, 27], [42, 27], [41, 28], [42, 28], [41, 29]];
    const popOf = (grid) => { let p = 0; for (let i = 0; i < grid.length; i++) p += grid[i]; return p; };
    const outsideCells = (grid, n) => {
      const cells = [];
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (!grid[y * n + x]) continue;
          if (x >= GUN_OX && x <= GUN_OX + 35 && y >= GUN_OY && y <= GUN_OY + 8) continue;
          cells.push([x, y]);
        }
      }
      return cells;
    };

    const gunPage = await browser.newPage({ viewport: { width: 400, height: 300 } });
    const gunErrs = [];
    gunPage.on('pageerror', (e) => gunErrs.push(String(e)));
    await gunPage.goto(`${base}?size=128&sps=0.0001`, { timeout: 60000 });
    await gunPage.waitForFunction(() => !!window.__life);
    await gunPage.evaluate(() => {
      window.__life.setAuto(false);
      window.__life.clear();
      window.__life.stampPattern('gun', 10, 10);
    });
    const gun0 = await gpuGrid(gunPage);
    const out0 = outsideCells(gun0, 128);
    await gunPage.evaluate(() => window.__life.step(30));
    const gun30 = await gpuGrid(gunPage);
    const out30 = outsideCells(gun30, 128);
    await gunPage.evaluate(() => window.__life.step(30));
    const gun60 = await gpuGrid(gunPage);
    const out60 = outsideCells(gun60, 128);
    const gunErrFree = gunErrs.length === 0 && (await gunPage.evaluate(() => !document.getElementById('error')));
    await gunPage.close();
    record('stage5: gun golden populations (36/41/46 at gen 0/30/60)',
      popOf(gun0) === 36 && popOf(gun30) === 41 && popOf(gun60) === 46 && gunErrFree,
      `pops=${popOf(gun0)}/${popOf(gun30)}/${popOf(gun60)}`);
    record('stage5: gun golden emitted-glider offsets',
      JSON.stringify(out0) === '[]'
      && JSON.stringify(out30) === JSON.stringify(GUN_OUT30)
      && JSON.stringify(out60) === JSON.stringify(GUN_OUT60),
      `out30=${JSON.stringify(out30)} out60=${JSON.stringify(out60)}`);

    // HUD: present, correct format, ~1 Hz cadence (measured display-only so frames
    // are fast enough for a bounded window), then gen advances while auto is on.
    const gen = () => page.evaluate(() => window.__life.generation());
    const hudExists = await page.evaluate(() => !!document.getElementById('hud'));
    const hudCadence = await page.evaluate(() => new Promise((resolve) => {
      const hud = document.getElementById('hud');
      let changes = 0;
      const obs = new MutationObserver(() => { changes++; });
      obs.observe(hud, { childList: true, characterData: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve({ changes, text: hud.textContent });
      }, 1200);
    }));
    const hudMatch = /^(\d+) fps \| (\d+) gen\/s \| gen (\d+)/.exec(hudCadence.text);
    record('stage5: HUD present, ~1 Hz cadence, format fps|gen/s|gen',
      hudExists && !!hudMatch && hudCadence.changes >= 1 && hudCadence.changes <= 3,
      `changes=${hudCadence.changes} text="${hudCadence.text}"`);

    const genBeforeHud = await gen();
    await page.click('#btn-play');
    await page.waitForTimeout(3500);
    const genAfterHud = await gen();
    await page.click('#btn-play');
    const hudPlaying = await page.textContent('#hud');
    const hudGen = /gen (\d+)/.exec(hudPlaying);
    record('stage5: HUD tracks simulation while running',
      genAfterHud > genBeforeHud && !!hudGen && Number(hudGen[1]) > 0,
      `gen ${genBeforeHud} -> ${genAfterHud}, hud="${hudPlaying}"`);

    // ?seed= determinism: same seed twice identical, different seeds differ, default empty
    const loadSeed = async (query) => {
      const p = await browser.newPage({ viewport: { width: 220, height: 160 } });
      await p.addInitScript(() => {
        window.__up = { texSubImage2D: 0 };
        const orig = WebGL2RenderingContext.prototype.texSubImage2D;
        WebGL2RenderingContext.prototype.texSubImage2D = function () { window.__up.texSubImage2D++; return orig.apply(this, arguments); };
      });
      await p.goto(`${base}?size=64&sps=0.0001${query ? '&' + query : ''}`, { timeout: 60000 });
      await p.waitForFunction(() => !!window.__life);
      const grid = await gpuGrid(p);
      const ups = await p.evaluate(() => window.__up.texSubImage2D);
      await p.close();
      return { grid, ups };
    };
    const seedA = await loadSeed('seed=demo');
    const seedB = await loadSeed('seed=demo');
    const seedC = await loadSeed('seed=1');
    const seedDefault = await loadSeed('');
    const gridsEq = (x, y) => countDiff(x, y) === 0;
    const aliveA = seedA.grid.reduce((a, b) => a + b, 0);
    record('stage5: ?seed=demo deterministic across loads (single upload)',
      gridsEq(seedA.grid, seedB.grid) && seedA.ups === 1 && seedB.ups === 1 && aliveA > 0,
      `alive=${aliveA} uploads=${seedA.ups}/${seedB.ups}`);
    record('stage5: different seeds differ; default load stays empty',
      !gridsEq(seedA.grid, seedC.grid) && gridsEq(seedDefault.grid, new Uint8Array(SIZE * SIZE))
      && seedC.ups === 1 && seedDefault.ups === 0,
      `seed1ups=${seedC.ups} defaultups=${seedDefault.ups}`);

    // MAX_TEXTURE_SIZE exposed; selector caps at min(4096, MAX_TEXTURE_SIZE)
    const capInfo = await page.evaluate(() => ({
      visible: Array.from(document.getElementById('grid-size').options)
        .filter((o) => !o.hidden).map((o) => Number(o.value)),
      max: window.__life.maxTextureSize,
    }));
    record('stage5: selector caps at min(4096, MAX_TEXTURE_SIZE)',
      capInfo.max >= 1024 && capInfo.visible.length > 0
      && capInfo.visible.every((v) => v <= Math.min(4096, capInfo.max)),
      `max=${capInfo.max} visible=${JSON.stringify(capInfo.visible)}`);

    // 4096^2 with the sim running every frame: profiled for the README (software
    // GL makes the O(size^2) sim shader the bottleneck — see issue #5 plan adjustment).
    const measureSimFps = async (gridSize) => {
      const p = await browser.newPage({ viewport: { width: 512, height: 512 } });
      await p.addInitScript(() => {
        window.__counters = { drawArrays: 0 };
        const origDraw = WebGL2RenderingContext.prototype.drawArrays;
        WebGL2RenderingContext.prototype.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
      });
      await p.goto(`${base}?size=${gridSize}&sps=120`, { timeout: 60000 });
      await p.waitForFunction(() => !!window.__life);
      await p.waitForTimeout(500);
      const d0 = await p.evaluate(() => window.__counters.drawArrays);
      const g0 = await p.evaluate(() => window.__life.generation());
      await p.waitForTimeout(2000);
      let elapsed = 2;
      let d1 = await p.evaluate(() => window.__counters.drawArrays);
      let g1 = await p.evaluate(() => window.__life.generation());
      // Under heavy system load a single 4096^2 software-GL frame can outlast the
      // base window; poll in 1 s slices until a generation completes (bounded at +8 s).
      for (let extra = 0; extra < 8 && g1 === g0; extra++) {
        await p.waitForTimeout(1000);
        elapsed += 1;
        d1 = await p.evaluate(() => window.__counters.drawArrays);
        g1 = await p.evaluate(() => window.__life.generation());
      }
      const err = await p.evaluate(() => !!document.getElementById('error'));
      await p.close();
      return { fps: (d1 - d0) / elapsed, genDelta: g1 - g0, err };
    };
    const sim64 = await measureSimFps(64);
    const sim4k = await measureSimFps(4096);
    record('stage5: 4096^2 sim+display runs and advances generations (profiled)',
      !sim4k.err && !sim64.err && sim4k.genDelta > 0 && sim64.genDelta > 0,
      `sim+display fps@64=${sim64.fps.toFixed(1)} (gen+${sim64.genDelta}), `
      + `fps@4096=${sim4k.fps.toFixed(1)} (gen+${sim4k.genDelta})`);
  }

  // ---- Stage 6: RGBA8 byte layout, age, raw readback ----
  {
    const raw1 = (p, x, y) => p.evaluate(
      (coords) => Array.from(window.__life.readRaw(coords[0], coords[1], 1, 1)), [x, y],
    );
    await page.evaluate(() => { window.__life.setAuto(false); window.__life.clear(); });
    const rawDead = await raw1(page, 5, 5);
    await page.evaluate(() => window.__life.stampBrush(10, 10, 0));
    const rawAlive = await raw1(page, 10, 10);
    record('stage6: RGBA8 byte layout via normalized round-trip (dead=(0,8,12,0), alive=(1,8,12,0))',
      rawDead.join() === '0,8,12,0' && rawAlive.join() === '1,8,12,0',
      `dead=[${rawDead}] alive=[${rawAlive}]`);

    // Age: a seeded block (still life) ages 1 per gen, saturating at 127 (R=255).
    const seedBlock = () => page.evaluate(() => {
      window.__life.clear();
      const d = new Uint8Array(64 * 64 * 4);
      for (const c of [[30, 30], [31, 30], [30, 31], [31, 31]]) {
        d[(c[1] * 64 + c[0]) * 4] = 255;
        d[(c[1] * 64 + c[0]) * 4 + 3] = 255;
      }
      window.__life.seed(64, 64, d);
      window.__life.step(1);
    });
    await seedBlock();
    const age1 = await raw1(page, 30, 30);
    await page.evaluate(() => window.__life.step(129));
    const ageSat = await raw1(page, 30, 30);
    const blockAlive = await page.evaluate(() => window.__life.read(30, 30, 1, 1)[0] === 255);
    record('stage6: age increments (R=3) then saturates at 127 (R=255); still life stable',
      age1.join() === '3,8,12,0' && ageSat.join() === '255,8,12,0' && blockAlive,
      `age1=[${age1}] age130=[${ageSat}]`);

    // Death resets age to 0 but keeps the stored Conway masks.
    await page.evaluate(() => {
      window.__life.clear();
      const d = new Uint8Array(64 * 64 * 4);
      for (const c of [[29, 30], [30, 30], [31, 30]]) {
        d[(c[1] * 64 + c[0]) * 4] = 255;
        d[(c[1] * 64 + c[0]) * 4 + 3] = 255;
      }
      window.__life.seed(64, 64, d);
      window.__life.step(1);
    });
    const diedCell = await raw1(page, 29, 30);
    record('stage6: death resets age to 0 and keeps Conway masks',
      diedCell.join() === '0,8,12,0', `died=[${diedCell}]`);
  }

  // ---- Stage 7: per-cell genomes, mask consumption, deterministic inheritance ----
  {
    // Stage 4 left the shared page on a 4096² grid; reload at SIZE so the torus
    // wrap matches the 64² CPU references below.
    await page.goto(`${base}?size=${SIZE}&sps=0.0001`);
    await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
    await page.evaluate(() => window.__life.setAuto(false));
    const raw1 = (p, x, y) => p.evaluate(
      (coords) => Array.from(window.__life.readRaw(coords[0], coords[1], 1, 1)), [x, y],
    );

    // Stamp with HighLife selected: readRaw shows G=0b01001000 (B36), B=0b00001100 (S23).
    // Then back to Conway: stamp shows G=0x08.
    await page.evaluate(() => {
      window.__life.setAuto(false);
      window.__life.setGenome('highlife');
      window.__life.clear();
      window.__life.stampBrush(10, 10, 0);
    });
    const hlStamp = await raw1(page, 10, 10);
    await page.evaluate(() => {
      window.__life.setGenome('conway');
      window.__life.clear();
      window.__life.stampBrush(11, 11, 0);
    });
    const cwStamp = await raw1(page, 11, 11);
    record('stage7: brush stamping uses selected genome (HighLife G=0x48/B=0x0C, Conway G=0x08)',
      hlStamp.join() === '1,72,12,0' && cwStamp.join() === '1,8,12,0',
      `highlife=[${hlStamp}] conway=[${cwStamp}]`);

    // Inheritance: blinker of HighLife cells; the cell above the center is born with
    // n==3 from three living HighLife neighbors and must inherit G=0x48/B=0x0C.
    await page.evaluate(() => {
      window.__life.setGenome('highlife');
      window.__life.clear();
      window.__life.stampPattern('blinker', 20, 30);
      window.__life.step(1);
    });
    const inherited = await raw1(page, 21, 31);
    record('stage7: newborn inherits HighLife genome from living neighbors',
      inherited.join() === '3,72,12,0', `inherited=[${inherited}]`);

    // n==8 corner: 3x3 solid block — center has n==8 and must die (A bit1 = 0 for
    // Conway/HighLife), matching cpuStepGenome which takes the same A-bits path.
    await page.evaluate(() => {
      window.__life.setGenome('conway');
      window.__life.clear();
      for (let y = 9; y <= 11; y++) {
        for (let x = 9; x <= 11; x++) window.__life.stampBrush(x, y, 0);
      }
    });
    const n8State0 = await page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    await page.evaluate(() => window.__life.step(1));
    const n8Gpu = await page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    const n8Cpu = cpuStepGenome(Uint8Array.from(n8State0), 64, 0, 0);
    let n8Mismatch = 0;
    for (let i = 0; i < n8Cpu.length; i++) if (n8Cpu[i] !== n8Gpu[i]) n8Mismatch++;
    const centerAfter = await raw1(page, 10, 10);
    record('stage7: n==8 indexes A bits (center of 3x3 solid dies; GPU matches CPU)',
      n8Mismatch === 0 && centerAfter.join() === '0,8,12,0',
      `mismatches=${n8Mismatch} center=[${centerAfter}]`);

    // Mixed-genome equivalence: half Conway / half HighLife + crossing gliders;
    // GPU vs cpuStepGenome — full uvec4 grids equal after 50 gens (hash parity).
    await page.evaluate(() => {
      window.__life.setGenome('conway');
      window.__life.clear();
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const left = x < 32;
          const alive = left ? ((x * 3 + y * 5) % 7 < 3) : ((x * 5 + y * 3) % 11 < 4);
          if (alive) {
            window.__life.setGenome(left ? 'conway' : 'highlife');
            window.__life.stampBrush(x, y, 0);
          }
        }
      }
      window.__life.setGenome('conway');
      window.__life.stampPattern('glider', 28, 28);
      window.__life.setGenome('highlife');
      window.__life.stampPattern('glider', 36, 24);
      window.__life.setGenome('conway');
    });
    const mixed0 = await page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    const mixedGen0 = await page.evaluate(() => window.__life.generation());
    await page.evaluate(() => window.__life.step(50));
    const mixedGpu = await page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    let mixedCpu = Uint8Array.from(mixed0);
    for (let g = 0; g < 50; g++) mixedCpu = cpuStepGenome(mixedCpu, 64, mixedGen0 + g, 0);
    let mixedMismatch = 0;
    let firstBad = -1;
    for (let i = 0; i < mixedCpu.length; i++) {
      if (mixedCpu[i] !== mixedGpu[i]) {
        mixedMismatch++;
        if (firstBad < 0) firstBad = i;
      }
    }
    record('stage7: mixed Conway/HighLife grid matches CPU reference for 50 gens (hash parity)',
      mixedMismatch === 0,
      mixedMismatch
        ? `${mixedMismatch} byte mismatches, first @${firstBad}: cpu=[${mixedCpu.slice(firstBad, firstBad + 4)}] gpu=[${mixedGpu.slice(firstBad, firstBad + 4)}]`
        : 'bit-exact over 50 gens');
  }

  // ---- Stage 8: mutation, lineages, lineage color, HUD count ----
  {
    const hsl2rgbRef = (lid) => {
      const h = ((lid * 0.6180339887) % 1) * 360;
      const s = 0.65;
      const l = 0.55;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const hp = h / 60;
      const x = c * (1 - Math.abs((hp % 2) - 1));
      let rgb;
      if (hp < 1) rgb = [c, x, 0];
      else if (hp < 2) rgb = [x, c, 0];
      else if (hp < 3) rgb = [0, c, x];
      else if (hp < 4) rgb = [0, x, c];
      else if (hp < 5) rgb = [x, 0, c];
      else rgb = [c, 0, x];
      const m = l - c * 0.5;
      return rgb.map((v) => Math.round((v + m) * 255));
    };
    const near8 = (got, want) => Math.abs(got[0] - want[0]) <= 8 && Math.abs(got[1] - want[1]) <= 8 && Math.abs(got[2] - want[2]) <= 8;
    const stampMixed = () => page.evaluate(() => {
      window.__life.setAuto(false);
      window.__life.setGenome('conway');
      window.__life.clear();
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const left = x < 32;
          const alive = left ? ((x * 3 + y * 5) % 7 < 3) : ((x * 5 + y * 3) % 11 < 4);
          if (alive) {
            window.__life.setGenome(left ? 'conway' : 'highlife');
            window.__life.stampBrush(x, y, 0);
          }
        }
      }
      window.__life.setGenome('conway');
    });
    const readRaw64 = () => page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    const countIds = (buf) => {
      const seen = new Set();
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i] & 1) seen.add(buf[i + 3] >> 2);
      }
      return seen;
    };

    // mut absent: rule stays stage-7 bit-exact (vs the stage-7 CPU ref chain)
    // and every lineage id stays 0.
    await page.goto(`${base}?size=${SIZE}&sps=0.0001`);
    await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
    await stampMixed();
    const m0s0 = Uint8Array.from(await readRaw64());
    const m0gen = await page.evaluate(() => window.__life.generation());
    await page.evaluate(() => window.__life.step(30));
    const m0gpu = Uint8Array.from(await readRaw64());
    let m0cpu = m0s0;
    for (let g = 0; g < 30; g++) m0cpu = cpuStepGenomeMut(m0cpu, 64, m0gen + g, 0, 0);
    let m0Mismatch = 0;
    for (let i = 0; i < m0cpu.length; i++) if (m0cpu[i] !== m0gpu[i]) m0Mismatch++;
    const m0Ids = countIds(m0gpu);
    record('stage8: mut absent/0 keeps stage-7 bit-exact and all lineage ids 0',
      m0Mismatch === 0 && [...m0Ids].every((id) => id === 0),
      `mismatches=${m0Mismatch} ids=${[...m0Ids].join('/')}`);

    // HUD on a pure Conway world (paused): lineages: 1.
    await page.evaluate(() => {
      window.__life.setGenome('conway');
      window.__life.clear();
      window.__life.stampPattern('blinker', 20, 30);
      window.__life.setAuto(false);
    });
    await page.waitForTimeout(1500);
    const hudPure = await page.evaluate(() => document.getElementById('hud').textContent);
    const hudPureN = /lineages: (\d+)/.exec(hudPure);
    record('stage8: HUD shows lineages count (pure Conway world = 1)',
      !!hudPureN && Number(hudPureN[1]) === 1, `hud="${hudPure}"`);

    // mut=0.15: births mutate — lineage ids appear in A bits2-7; GPU matches
    // the mutation+lineage CPU ref bit-exactly for 50 gens; paused HUD counts
    // the distinct living lineages (>= 2 after mutations).
    await page.goto(`${base}?size=${SIZE}&sps=0.0001&mut=0.15`);
    await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
    await stampMixed();
    const m1s0 = Uint8Array.from(await readRaw64());
    const m1gen = await page.evaluate(() => window.__life.generation());
    await page.evaluate(() => window.__life.step(5));
    const m1early = Uint8Array.from(await readRaw64());

    // Color probe while the page is still at the snapshot generation (later
    // gens extinguish lid0 and move the cells): a lineage-0 alive cell keeps
    // the classic color; a mutated cell matches the golden-angle HSL ref.
    // Camera-constrained search — only cells inside the fitted view are probed.
    const v8 = await page.evaluate(() => window.__life.view());
    const yMin = Math.max(0, Math.ceil(v8[1]));
    const yMax = Math.min(63, Math.floor(v8[1] + v8[3]));
    const xMin = Math.max(0, Math.ceil(v8[0]));
    const xMax = Math.min(63, Math.floor(v8[0] + v8[2]));
    let cell0 = -1;
    let cellMut = -1;
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const i = (y * 64 + x) * 4;
        if (!(m1early[i] & 1)) continue;
        const lid = m1early[i + 3] >> 2;
        if (lid === 0 && cell0 < 0) cell0 = y * 64 + x;
        if (lid !== 0 && cellMut < 0) cellMut = y * 64 + x;
      }
    }
    const screenAt = (wx, wy) => page.evaluate(([wx, wy]) => {
      const L = window.__life;
      const c = document.querySelector('canvas');
      const v = L.view();
      const px = Math.floor((wx - v[0]) / v[2] * c.width);
      const py = Math.floor((wy - v[1]) / v[3] * c.height);
      const b = L.readScreen(px, py, 1, 1);
      return [b[0], b[1], b[2]];
    }, [wx, wy]);
    if (cell0 >= 0 && cellMut >= 0) {
      const px0 = await screenAt((cell0 % 64) + 0.5, Math.floor(cell0 / 64) + 0.5);
      const lidMut = m1early[cellMut * 4 + 3] >> 2;
      const pxMut = await screenAt((cellMut % 64) + 0.5, Math.floor(cellMut / 64) + 0.5);
      const refMut = hsl2rgbRef(lidMut);
      record('stage8: lineage 0 keeps classic color; mutated lineage matches HSL ref',
        near8(px0, [235, 240, 255]) && near8(pxMut, refMut) && !near8(pxMut, [235, 240, 255]),
        `lid0=${px0} lid${lidMut}=${pxMut} ref=${refMut}`);
    } else {
      record('stage8: lineage 0 keeps classic color; mutated lineage matches HSL ref',
        false, `cells not found: lid0=${cell0} mut=${cellMut}`);
    }

    await page.evaluate(() => window.__life.step(45));
    const m1gpu = Uint8Array.from(await readRaw64());
    let m1cpu = m1s0;
    for (let g = 0; g < 50; g++) m1cpu = cpuStepGenomeMut(m1cpu, 64, m1gen + g, 0, 1500);
    let m1Mismatch = 0;
    for (let i = 0; i < m1cpu.length; i++) if (m1cpu[i] !== m1gpu[i]) m1Mismatch++;
    const m1Ids = countIds(m1gpu);
    await page.waitForTimeout(1500);
    const hudMut = await page.evaluate(() => document.getElementById('hud').textContent);
    const hudMutN = /lineages: (\d+)/.exec(hudMut);
    record('stage8: mut>0 produces lineage ids; GPU matches CPU ref for 50 gens',
      m1Mismatch === 0 && m1Ids.size >= 2 && !!hudMutN && Number(hudMutN[1]) >= 2,
      `mismatches=${m1Mismatch} distinctIds=${m1Ids.size} hud="${hudMut}"`);

    // Determinism: same ?seed=+?mut= twice -> identical grids; different mut
    // diverges. Initial fill + hash both come from ?seed=.
    const loadMut = async (query) => {
      const p = await browser.newPage({ viewport: { width: 220, height: 160 } });
      await p.goto(`${base}?size=64&sps=0.0001&${query}`);
      await p.waitForFunction(() => !!window.__life);
      await p.evaluate(() => window.__life.setAuto(false));
      await p.evaluate(() => window.__life.step(15));
      const grid = Uint8Array.from(await p.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64))));
      await p.close();
      return grid;
    };
    const eqBuf = (x, y) => {
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return true;
    };
    const detA = await loadMut('seed=7&mut=0.1');
    const detB = await loadMut('seed=7&mut=0.1');
    const detC = await loadMut('seed=7&mut=0.2');
    record('stage8: ?seed=+?mut= deterministic across loads; different mut diverges',
      eqBuf(detA, detB) && !eqBuf(detA, detC),
      `A==B ${eqBuf(detA, detB)}, A!=C ${!eqBuf(detA, detC)}`);
  }

  // ---- Loop hygiene with auto stepping on (second page) ----
  {
    const page2 = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page2.addInitScript(() => {
      window.__counters = { textures: 0, framebuffers: 0, readPixels: 0, drawArrays: 0 };
      const W2 = WebGL2RenderingContext.prototype;
      for (const [name, key] of [['createTexture', 'textures'], ['createFramebuffer', 'framebuffers']]) {
        const orig = W2[name];
        W2[name] = function () { window.__counters[key]++; return orig.apply(this, arguments); };
      }
      const origRead = W2.readPixels;
      W2.readPixels = function () { window.__counters.readPixels++; return origRead.apply(this, arguments); };
      const origDraw = W2.drawArrays;
      W2.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
    });
    await page2.goto(`${base}?size=${SIZE}&sps=10`);
    await page2.waitForFunction(() => !!window.__life);
    await page2.waitForTimeout(1200);
    const c = await page2.evaluate(() => window.__counters);
    record('loop: no GPU readback while running', c.readPixels === 0, `readPixels=${c.readPixels}`);
    record('loop: no extra allocations while running', c.textures === 2 && c.framebuffers === 2, JSON.stringify(c));
    await page2.close();
  }

  // ---- Stage 9: novelty explorer (unit + determinism + smoke) ----
  {
    const explore = require(path.join(ROOT, 'tools', 'explore.js'));
    const ffmpegHere = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

    // Unit: boring filters classify die / freeze / noise correctly.
    const frozenM = {
      vec: {
        activityMean: 0.01, activityStd: 0, spatialEntropy: 0.2, compressibility: 0.1,
        movingComponents: 0, persistence: 1, lineageDiversity: 0, stability: 1,
      },
      finalPop: 100, maxPop: 100,
    };
    const diedM = { vec: frozenM.vec, finalPop: 0, maxPop: 100 };
    const noiseM = {
      vec: { ...frozenM.vec, activityMean: 0.5, compressibility: 0.8, stability: 0.1 },
      finalPop: 2000, maxPop: 3000,
    };
    const interestingM = {
      vec: {
        activityMean: 0.2, activityStd: 0.1, spatialEntropy: 0.6, compressibility: 0.3,
        movingComponents: 0.2, persistence: 0.7, lineageDiversity: 0.1, stability: 0.5,
      },
      finalPop: 1000, maxPop: 2000,
    };
    record('stage9: boring filters (dies/frozen/noise) classify correctly',
      explore.isBoring(diedM).died === true
      && explore.isBoring(frozenM).frozen === true
      && explore.isBoring(noiseM).noise === true
      && explore.isBoring(interestingM).any === false,
      `died=${JSON.stringify(explore.isBoring(diedM).died)} frozen=${JSON.stringify(explore.isBoring(frozenM).frozen)} noise=${JSON.stringify(explore.isBoring(noiseM).noise)}`);

    // Unit: novelty distance is Euclidean over the fixed metric vector.
    const zeroVec = {};
    for (const k of explore.METRIC_KEYS) zeroVec[k] = 0;
    const oneVec = { ...zeroVec };
    oneVec.activityMean = 1;
    record('stage9: novelty distance is Euclidean in metric space',
      explore.noveltyDistance(zeroVec, zeroVec) === 0
      && Math.abs(explore.noveltyDistance(zeroVec, oneVec) - 1) < 1e-12
      && explore.noveltyDistance(zeroVec, oneVec) >= explore.TAU_DEFAULT,
      `d=${explore.noveltyDistance(zeroVec, oneVec).toFixed(3)} tau=${explore.TAU_DEFAULT}`);

    // Determinism + smoke in isolated tmp dirs (the real archive is never read
    // or written by tests). --pattern still => deterministic frozen world;
    // --force-keep exercises the full gallery pipeline on it.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-'));
    const runExplorer = (out) => execFileSync('node', [
      path.join(ROOT, 'tools', 'explore.js'),
      '--size', '64', '--gens', '20', '--worlds', '1', '--seed-base', '7',
      '--pattern', 'still', '--force-keep',
      '--archive', path.join(out, 'archive.json'),
      '--out', out,
    ], { cwd: ROOT, stdio: 'pipe' });
    const detA = path.join(tmp, 'a');
    const detB = path.join(tmp, 'b');
    fs.mkdirSync(detA);
    fs.mkdirSync(detB);
    runExplorer(detA);
    runExplorer(detB);
    const read = (p) => fs.readFileSync(p, 'utf8');
    record('stage9: same config -> byte-identical run.json + archive.json',
      read(path.join(detA, 'run.json')) === read(path.join(detB, 'run.json'))
      && read(path.join(detA, 'archive.json')) === read(path.join(detB, 'archive.json')),
      'run.json + archive.json');

    const runJ = JSON.parse(read(path.join(detA, 'run.json')));
    const w0 = runJ.worlds[0];
    const entryDir = path.join(detA, w0.entry);
    const entry = JSON.parse(read(path.join(entryDir, 'metrics.json')));
    const gifOk = ffmpegHere
      ? fs.existsSync(path.join(entryDir, 'anim.gif')) && fs.statSync(path.join(entryDir, 'anim.gif')).size > 0
      : entry.gifSkip === 'ffmpeg not found';
    record('stage9: smoke — archive written, still world frozen, gallery entry complete',
      fs.existsSync(path.join(detA, 'archive.json'))
      && w0.boring.frozen === true
      && w0.kept === true
      && /^index\.html\?size=64&seed=7&mut=0(\.\d+)?$/.test(entry.reproUrl)
      && explore.METRIC_KEYS.every((k) => typeof entry.metrics[k] === 'number')
      && gifOk,
      `reproUrl=${entry.reproUrl} gif=${entry.gif} gifSkip=${entry.gifSkip}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- Stage 10: ecology (freq/energy/niche/age) ----
  {
    const readRaw64 = () => page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    const readEco64 = () => page.evaluate(() => {
      const b = window.__life.readEco();
      return b ? Array.from(b) : null;
    });
    const readRaw64EcoOrNull = async () => {
      const v = await readEco64();
      return v === null ? null : Uint8Array.from(v);
    };
    const stampMixed = () => page.evaluate(() => {
      window.__life.setAuto(false);
      window.__life.setGenome('conway');
      window.__life.clear();
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const left = x < 32;
          const alive = left ? ((x * 3 + y * 5) % 7 < 3) : ((x * 5 + y * 3) % 11 < 4);
          if (alive) {
            window.__life.setGenome(left ? 'conway' : 'highlife');
            window.__life.stampBrush(x, y, 0);
          }
        }
      }
      window.__life.setGenome('conway');
    });
    const eqBuf = (x, y) => {
      if (x === null || y === null || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return true;
    };
    const firstDiff = (x, y) => {
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i;
      return -1;
    };
    const stepAndCompareEco = async (opts, gens) => {
      // Loads ?size=64 + flags + mut, stamps the mixed world, then steps gens
      // against cpuStepEco (state AND eco) bit-exactly. Returns { diverged,
      // maxB, sums } where sums tracks sum(R)+sum(G) per gen for conservation.
      const q = new URLSearchParams({ size: '64', sps: '0.0001' });
      if (opts.flags) for (const [k, v] of Object.entries(opts.flags)) q.set(k, v);
      if (opts.mut) q.set('mut', String(opts.mut));
      if (opts.seed !== undefined) q.set('seed', String(opts.seed));
      await page.goto(`${base}?${q}`);
      await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
      if (!opts.seedOnly) await stampMixed();
      await page.evaluate(() => window.__life.setAuto(false));
      const s0 = Uint8Array.from(await readRaw64());
      // Eco textures exist only when energy|niche. For freq/age-only runs use
      // a synthetic all-zero eco on the CPU side: with energy=0/niche=0 the
      // CPU eco pass is a no-op (zero pool splits, zero niche writes), matching
      // the GPU where the eco pass never runs.
      const e0raw = await readRaw64EcoOrNull();
      const e0 = e0raw === null ? new Uint8Array(s0.length) : Uint8Array.from(e0raw);
      const hasEcoTex = e0raw !== null;
      const gen0 = await page.evaluate(() => window.__life.generation());
      const hashSeed = opts.seed !== undefined && opts.seed !== 'demo' ? Number(opts.seed) : 0;
      const refOpts = {
        freq: opts.flags && opts.flags.freq ? 1 : 0,
        energy: opts.flags && opts.flags.energy ? 1 : 0,
        niche: opts.flags && opts.flags.niche ? 1 : 0,
        age: opts.flags && opts.flags.age ? 1 : 0,
        mutBp: Math.round((opts.mut || 0) * 10000),
      };
      let s = s0;
      let e = e0;
      let diverged = false;
      let maxB = 0;
      const sums = [];
      for (let g = 0; g <= gens; g++) {
        if (hasEcoTex) {
          let sum = 0;
          for (let i = 0; i < e.length; i += 4) sum += e[i] + e[i + 1];
          sums.push(sum);
          for (let i = 2; i < e.length; i += 4) if (e[i] > maxB) maxB = e[i];
        }
        if (g === gens) break;
        await page.evaluate(() => window.__life.step(1));
        const prevS = s, prevE = e;
        const r = cpuStepEco(s, e, 64, gen0 + g, hashSeed, refOpts);
        s = r.state;
        e = r.eco;
        if (process.env.ECO_DEBUG && hasEcoTex) {
          const eGpuNow = await readEco64();
          let bad = -1;
          for (let i = 0; i < e.length; i++) if (e[i] !== eGpuNow[i]) { bad = i; break; }
          if (bad >= 0) {
            const ti = (bad / 4) | 0, ch = bad % 4;
            const x = ti % 64, y = (ti / 64) | 0;
            const ring = [];
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const qi = (((y + dy + 64) % 64) * 64 + ((x + dx + 64) % 64)) * 4;
              const nBorn = !(prevS[qi] & 1) && (s[qi] & 1);
              ring.push(`(${dx},${dy}) gpre=${prevE[qi + 1]} st=${prevS[qi] & 1}->${s[qi] & 1}${nBorn ? ' BORN' : ''}`);
            }
            console.log(`ECO_DEBUG first diverge gen=${gen0 + g + 1} texel=(${x},${y}) ch=${ch} cpu=${e[bad]} gpu=${eGpuNow[bad]}`);
            console.log(`ECO_DEBUG self: gpre=${prevE[ti * 4 + 1]} er=${prevE[ti * 4]} st=${prevS[ti * 4] & 1}->${s[ti * 4] & 1} cpuOut r/g/b=${e[ti * 4]}/${e[ti * 4 + 1]}/${e[ti * 4 + 2]} gpuOut=${eGpuNow[ti * 4]}/${eGpuNow[ti * 4 + 1]}/${eGpuNow[ti * 4 + 2]}`);
            console.log('ECO_DEBUG ring(old->new): ' + ring.join(' | '));
            break;
          }
        }
      }
      const sGpu = Uint8Array.from(await readRaw64());
      if (!eqBuf(s, sGpu)) diverged = true;
      let firstE = -1;
      if (hasEcoTex) {
        const eGpu = await readEco64();
        if (!eqBuf(e, eGpu)) {
          diverged = true;
          firstE = firstDiff(e, eGpu);
        }
      }
      return { mismatch: diverged, firstS: firstDiff(s, sGpu), firstE, maxB, sums, sGpu };
    };
    const loadGrid = async (query, gens = 30) => {
      await page.goto(`${base}?size=64&sps=0.0001&${query}`);
      await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
      await page.evaluate(() => window.__life.setAuto(false));
      await page.evaluate((n) => window.__life.step(n), gens);
      return Uint8Array.from(await readRaw64());
    };

    // freq=1: GPU matches the CPU ref bit-exact for 30 gens and the dynamics
    // diverge from the same world without the flag (RPS pressure kills
    // survivors with >= 4 similar neighbors).
    {
      const r = await stepAndCompareEco({ flags: { freq: '1' }, mut: 0.15 }, 30);
      const base30 = await loadGrid('seed=7&mut=0.15');
      const flag30 = await loadGrid('seed=7&mut=0.15&freq=1');
      record('stage10: freq bit-exact vs CPU ref (30 gens); diverges from baseline',
        !r.mismatch && !eqBuf(base30, flag30),
        `mismatch=${r.mismatch} firstS=${r.firstS} firstE=${r.firstE} diverged=${!eqBuf(base30, flag30)}`);
    }

    // energy=1: GPU matches the CPU ref for 30 gens; total energy sum(R)+sum(G)
    // is invariant every generation (= E0 per location, ambient-pool init) and
    // the gate (pool < B_MIN vetoes births) changes dynamics vs baseline.
    {
      const r = await stepAndCompareEco({ flags: { energy: '1' }, mut: 0.15, seed: 7, seedOnly: true }, 30);
      const conserved = r.sums.every((v) => v === r.sums[0]);
      const energy0 = conserved ? r.sums[0] : -1;
      const expected0 = ECO.ENERGY_E0 * 64 * 64; // ambient pool: E0 per location
      const flag30 = await loadGrid('seed=7&mut=0.15&energy=1');
      const base30 = await loadGrid('seed=7&mut=0.15');
      record('stage10: energy bit-exact; sum(R+G) conserved every gen; gate changes dynamics',
        !r.mismatch && conserved && energy0 === expected0 && !eqBuf(base30, flag30),
        `mismatch=${r.mismatch} sum0=${r.sums[0]} expected=${expected0} conserved=${conserved} diverged=${!eqBuf(base30, flag30)}`);
    }

    // niche=1: GPU matches the CPU ref for 300 gens on the churning seed=7
    // soup (the death-scar field must reach richness — max B >= NICH_T=48,
    // crossed around gen 140 while the soup still churns) and the S234 bonus
    // changes dynamics vs the same soup without the flag.
    {
      const r = await stepAndCompareEco({ flags: { niche: '1' }, mut: 0.15, seed: 7, seedOnly: true }, 300);
      const base = await loadGrid('seed=7&mut=0.15', 300);
      record('stage10: niche bit-exact vs CPU ref (300 gens); field reaches richness; S234 diverges',
        !r.mismatch && r.maxB >= ECO.NICH_T && !eqBuf(base, r.sGpu),
        `mismatch=${r.mismatch} firstS=${r.firstS} maxB=${r.maxB} diverged=${!eqBuf(base, r.sGpu)}`);
    }

    // age=1: GPU matches the CPU ref for 40 gens on the stamped mixed world
    // (donor veto + natural death with ages reaching >= 32) and diverges from
    // the seed=7 soup without the flag at the same gen count.
    {
      const r = await stepAndCompareEco({ flags: { age: '1' }, mut: 0.15 }, 40);
      const base40 = await loadGrid('seed=7&mut=0.15', 40);
      const age40 = await loadGrid('seed=7&mut=0.15&age=1', 40);
      record('stage10: age bit-exact vs CPU ref (40 gens); lifecycle diverges from baseline',
        !r.mismatch && !eqBuf(base40, age40),
        `mismatch=${r.mismatch} firstS=${r.firstS} diverged=${!eqBuf(base40, age40)}`);
    }

    // Combo: all four mechanisms + mutation together, 50 gens bit-exact on
    // BOTH main and eco textures.
    {
      const r = await stepAndCompareEco({
        flags: { freq: '1', energy: '1', niche: '1', age: '1' },
        mut: 0.15, seed: 7, seedOnly: true,
      }, 50);
      record('stage10: freq+energy+niche+age+mut combo bit-exact (50 gens, main+eco)',
        !r.mismatch,
        `mismatch=${r.mismatch} firstS=${r.firstS} firstE=${r.firstE} maxB=${r.maxB}`);
    }

    // Flags off: eco pair never allocated, readEco null. Freq/age alone also
    // need no eco textures (pure sim-shader mechanisms).
    {
      await page.goto(`${base}?size=${SIZE}&sps=0.0001`);
      await page.waitForFunction(() => !!window.__life);
      await page.evaluate(() => window.__life.setAuto(false));
      const nullEco = await page.evaluate(() => window.__life.readEco());
      await page.goto(`${base}?size=${SIZE}&sps=0.0001&freq=1&age=1`);
      await page.waitForFunction(() => !!window.__life);
      await page.waitForTimeout(400);
      const cFA = await page.evaluate(() => window.__counters);
      record('stage10: no eco textures without energy/niche; readEco null when off',
        nullEco === null && cFA.textures === 2 && cFA.framebuffers === 2,
        `readEco=${nullEco === null ? 'null' : typeof nullEco} textures=${cFA.textures} fbos=${cFA.framebuffers}`);
    }
  }

  // ---- Stage 11: pattern library and battle scenes ----
  {
    const libPage = await browser.newPage({ viewport: { width: 400, height: 300 } });
    const libErrs = [];
    libPage.on('pageerror', (e) => libErrs.push(String(e)));
    await libPage.goto(`${base}?size=${SIZE}&sps=0.0001`, { timeout: 60000 });
    await libPage.waitForFunction(() => !!window.__life);
    await libPage.evaluate(() => window.__life.setAuto(false));
    const libStep = (n) => libPage.evaluate((k) => window.__life.step(k), n);
    const libClearStamp = (name, x, y) => libPage.evaluate(([n, px, py]) => {
      window.__life.clear();
      window.__life.stampPattern(n, px, py);
    }, [name, x, y]);

    // stamp-exact for each library pattern vs the independent canonical list
    for (const [name, cells] of Object.entries(CELLS)) {
      await libClearStamp(name, 20, 20);
      const got = await gpuGrid(libPage);
      const want = wantFromCoords(cells.map(([x, y]) => [x + 20, y + 20]), SIZE);
      record(`stage11: ${name} stamped exactly (${cells.length} cells)`,
        countDiff(got, want) === 0);
    }

    // lwss/mwss: p4 spaceships with exact +(2,0) displacement per 4 generations
    for (const name of ['lwss', 'mwss']) {
      await libClearStamp(name, 20, 20);
      const s0 = await gpuGrid(libPage);
      await libStep(4);
      const s4 = await gpuGrid(libPage);
      record(`stage11: ${name} moves exactly (2,0) per 4 gens (p4)`,
        popOf(s0) === CELLS[name].length && countDiff(s4, shifted(s0, 2, 0)) === 0);
    }

    // pulsar: period 3, 48 cells, gen1 distinct with canonical pop 56
    {
      await libClearStamp('pulsar', 20, 20);
      const p0 = await gpuGrid(libPage);
      await libStep(1);
      const p1 = await gpuGrid(libPage);
      await libStep(2);
      const p3 = await gpuGrid(libPage);
      record('stage11: pulsar is p3 (48 cells, pop@1=56)',
        popOf(p0) === 48 && popOf(p1) === 56
        && countDiff(p1, p0) !== 0 && countDiff(p3, p0) === 0);
    }

    // pentadecathlon: minimal period 15 from the canonical ring phase
    {
      await libClearStamp('penta', 20, 20);
      const e0 = await gpuGrid(libPage);
      let minimal = true;
      for (let k = 1; k <= 14; k++) {
        await libStep(1);
        const ek = await gpuGrid(libPage);
        if (countDiff(ek, e0) === 0) minimal = false;
      }
      await libStep(1);
      const e15 = await gpuGrid(libPage);
      record('stage11: pentadecathlon is minimal p15 (18 cells)',
        popOf(e0) === 18 && minimal && countDiff(e15, e0) === 0);
    }

    // diehard: extinct exactly at gen 130 on 64^2 stamped at (20,20); GPU==CPU
    {
      await libClearStamp('diehard', 20, 20);
      const d0 = await gpuGrid(libPage);
      let ref = Uint8Array.from(d0);
      let exact = true;
      let pop100 = -1;
      for (let g = 1; g <= 130; g++) {
        ref = cpuStep(ref, SIZE);
        await libStep(1);
        if (g === 50 || g === 100 || g === 130) {
          const got = await gpuGrid(libPage);
          if (countDiff(ref, got) !== 0) exact = false;
          if (g === 100) pop100 = popOf(got);
        }
      }
      const d130 = await gpuGrid(libPage);
      record('stage11: diehard extinct exactly at gen 130; GPU==CPU at 50/100/130',
        popOf(d0) === 7 && pop100 > 0 && popOf(d130) === 0 && exact,
        `pop@100=${pop100} pop@130=${popOf(d130)}`);
    }

    // acorn: methuselah explodes; GPU==CPU at 50/100/150/200; pop@200 >= 100
    {
      await libClearStamp('acorn', 20, 20);
      const a0 = await gpuGrid(libPage);
      let ref = Uint8Array.from(a0);
      let exact = true;
      for (let g = 1; g <= 200; g++) {
        ref = cpuStep(ref, SIZE);
        await libStep(1);
        if (g === 50 || g === 100 || g === 150 || g === 200) {
          const got = await gpuGrid(libPage);
          if (countDiff(ref, got) !== 0) exact = false;
        }
      }
      const a200 = await gpuGrid(libPage);
      record('stage11: acorn explodes; GPU==CPU at 50/100/150/200',
        popOf(a0) === 7 && exact && popOf(a200) >= 100, `pop@200=${popOf(a200)}`);
    }

    // GPU vs CPU toroidal parity for the remaining patterns at 4/40/80
    for (const name of ['lwss', 'mwss', 'pulsar', 'penta']) {
      await libClearStamp(name, 20, 20);
      const g0 = await gpuGrid(libPage);
      let ref = Uint8Array.from(g0);
      let exact = true;
      for (let g = 1; g <= 80; g++) {
        ref = cpuStep(ref, SIZE);
        await libStep(1);
        if (g === 4 || g === 40 || g === 80) {
          const got = await gpuGrid(libPage);
          if (countDiff(ref, got) !== 0) exact = false;
        }
      }
      record(`stage11: ${name} GPU==CPU toroidal at gens 4/40/80`, exact);
    }

    // scenes on a 128^2 grid: stamp-exact union, GPU==CPU, duel emits gliders
    await libPage.goto(`${base}?size=128&sps=0.0001`, { timeout: 60000 });
    await libPage.waitForFunction(() => !!window.__life);
    await libPage.evaluate(() => window.__life.setAuto(false));
    for (const [name, cells] of Object.entries(SCENE_PARTS)) {
      await libClearStamp(name, 10, 10);
      const g0 = await gpuGrid(libPage);
      const want = wantFromCoords(cells.map(([x, y]) => [x + 10, y + 10]), 128);
      let ref = Uint8Array.from(g0);
      let exact = true;
      for (let g = 1; g <= 80; g++) {
        ref = cpuStep(ref, 128);
        await libStep(1);
        if (g === 40 || g === 80) {
          const got = await gpuGrid(libPage);
          if (countDiff(ref, got) !== 0) exact = false;
        }
      }
      const g80 = await gpuGrid(libPage);
      if (name === 'duel') {
        record('stage11: duel stamp-exact (72 cells), GPU==CPU 40/80, emits gliders',
          countDiff(g0, want) === 0 && exact && popOf(g80) > popOf(g0),
          `pop@0=${popOf(g0)} pop@80=${popOf(g80)}`);
      } else {
        record('stage11: fleet stamp-exact (63 cells), GPU==CPU 40/80',
          countDiff(g0, want) === 0 && exact,
          `pop@0=${popOf(g0)} pop@80=${popOf(g80)}`);
      }
    }

    // toolbar: dropdown lists every library option; DOM click stamps pulsar exactly
    await libPage.goto(`${base}?size=${SIZE}&sps=0.0001`, { timeout: 60000 });
    await libPage.waitForFunction(() => !!window.__life);
    await libPage.evaluate(() => window.__life.setAuto(false));
    const libOpts = await libPage.evaluate(() =>
      Array.from(document.getElementById('pattern').options).map((o) => o.value));
    record('stage11: pattern dropdown lists all library options',
      ['brush', 'glider', 'blinker', 'gun', 'lwss', 'mwss', 'pulsar', 'penta',
        'acorn', 'diehard', 'duel', 'fleet'].every((v) => libOpts.includes(v)),
      JSON.stringify(libOpts));
    await libPage.click('#btn-clear');
    await libPage.selectOption('#pattern', 'pulsar');
    await libPage.click('#btn-paint');
    const libExpectedTexel = (mx, my) => libPage.evaluate(([x, y]) => {
      const c = document.querySelector('canvas');
      const v = window.__life.view();
      return [Math.floor(v[0] + (x / c.clientWidth) * v[2]), Math.floor(v[1] + (1 - y / c.clientHeight) * v[3])];
    }, [mx, my]);
    const libPos = [200, 150];
    const libTex = await libExpectedTexel(libPos[0], libPos[1]);
    await libPage.mouse.move(libPos[0], libPos[1]);
    await libPage.mouse.down();
    await libPage.mouse.up();
    const domGrid = await gpuGrid(libPage);
    const domWant = wantFromCoords(CELLS.pulsar.map(([x, y]) => [libTex[0] + x, libTex[1] + y]), SIZE);
    record('stage11: pattern stamp via toolbar (DOM, pulsar)',
      countDiff(domGrid, domWant) === 0, `texel=(${libTex[0]},${libTex[1]})`);
    await libPage.selectOption('#pattern', 'brush');
    await libPage.click('#btn-paint');

    record('stage11: no page errors on the library page',
      libErrs.length === 0, libErrs.join('; ') || undefined);
    await libPage.close();
  }

  // ---- Stage 12: curated demo mode (?demo=1) ----
  {
    const demoErrs = [];
    const at = (cells, dx, dy) => cells.map(([x, y]) => [x + dx, y + dy]);
    const demoPage = await browser.newPage({ viewport: { width: 400, height: 300 } });
    demoPage.on('pageerror', (e) => demoErrs.push(String(e)));
    await demoPage.goto(`${base}?size=128&sps=0.0001&demo=1`, { timeout: 60000 });
    await demoPage.waitForFunction(() => !!window.__life);
    await demoPage.evaluate(() => window.__life.setAuto(false));
    const demoStep = (n) => demoPage.evaluate((k) => window.__life.step(k), n);

    const g0 = await gpuGrid(demoPage);
    const wantDuel = wantFromCoords(SCENE_PARTS.duel, 128);
    const v0 = await demoPage.evaluate(() => window.__life.view());
    record('stage12: demo phase 0 = duel (72 cells) stamp-exact + fitView camera',
      countDiff(g0, wantDuel) === 0 && popOf(g0) === 72
      && v0[0] === 0 && v0[2] === 128 && Math.abs(v0[1] - (64 - v0[3] / 2)) < 1e-9,
      `pop=${popOf(g0)} view=${JSON.stringify(v0)}`);

    await demoStep(240);
    const g240 = await gpuGrid(demoPage);
    const want240 = wantFromCoords(
      at(SCENE_PARTS.fleet, 3, 3)
        .concat(at(CELLS.pulsar, 2, 36))
        .concat(at(CELLS.penta, 45, 2)), 128);
    record('stage12: phase 1 at gen 240 stamps fleet+pulsar+penta stamp-exact',
      countDiff(g240, want240) === 0, `pop=${popOf(g240)}`);

    await demoStep(240);
    const g480 = await gpuGrid(demoPage);
    const want480 = wantFromCoords(
      at(CELLS.acorn, 10, 10)
        .concat(at(CELLS.diehard, 30, 30))
        .concat(at(CELLS.lwss, 2, 50))
        .concat(at(CELLS.lwss, 12, 50))
        .concat(at(CELLS.lwss, 22, 50))
        .concat(at(CELLS.mwss, 2, 56))
        .concat(at(CELLS.mwss, 14, 56)), 128);
    record('stage12: phase 2 at gen 480 stamps methuselahs+parade stamp-exact',
      countDiff(g480, want480) === 0, `pop=${popOf(g480)}`);

    await demoStep(240);
    const g720 = await gpuGrid(demoPage);
    const want720 = wantFromCoords(
      SCENE_PARTS.duel.concat(at(CELLS.pulsar, 50, 45)), 128);
    record('stage12: phase 3 at gen 720 stamps duel+pulsar stamp-exact',
      countDiff(g720, want720) === 0, `pop=${popOf(g720)}`);

    await demoStep(240);
    const g960 = await gpuGrid(demoPage);
    const gen960 = await demoPage.evaluate(() => window.__life.generation());
    record('stage12: demo loops back to phase 0 at gen 960',
      gen960 === 960 && countDiff(g960, wantDuel) === 0, `gen=${gen960}`);

    const demoPage2 = await browser.newPage({ viewport: { width: 400, height: 300 } });
    demoPage2.on('pageerror', (e) => demoErrs.push(String(e)));
    await demoPage2.goto(`${base}?size=128&sps=0.0001&demo=1`, { timeout: 60000 });
    await demoPage2.waitForFunction(() => !!window.__life);
    await demoPage2.evaluate(() => window.__life.setAuto(false));
    await demoPage2.evaluate((k) => window.__life.step(k), 480);
    const g480b = await gpuGrid(demoPage2);
    record('stage12: demo deterministic across loads (identical grid at gen 480)',
      countDiff(g480, g480b) === 0 && countDiff(g480b, wantDuel) !== 0);
    await demoPage2.close();

    const plainPage = await browser.newPage({ viewport: { width: 400, height: 300 } });
    plainPage.on('pageerror', (e) => demoErrs.push(String(e)));
    await plainPage.goto(`${base}?size=${SIZE}&sps=0.0001`, { timeout: 60000 });
    await plainPage.waitForFunction(() => !!window.__life);
    await plainPage.evaluate(() => window.__life.setAuto(false));
    await plainPage.evaluate((k) => window.__life.step(k), 1);
    const plainG = await gpuGrid(plainPage);
    record('stage12: without ?demo the grid stays empty (manual mode intact)',
      popOf(plainG) === 0, `pop=${popOf(plainG)}`);
    await plainPage.close();

    const hygPage = await browser.newPage({ viewport: { width: 400, height: 300 } });
    hygPage.on('pageerror', (e) => demoErrs.push(String(e)));
    await hygPage.addInitScript(() => {
      window.__counters = { textures: 0, framebuffers: 0, readPixels: 0, drawArrays: 0 };
      const W2 = WebGL2RenderingContext.prototype;
      for (const [name, key] of [['createTexture', 'textures'], ['createFramebuffer', 'framebuffers']]) {
        const orig = W2[name];
        W2[name] = function () { window.__counters[key]++; return orig.apply(this, arguments); };
      }
      const origRead = W2.readPixels;
      W2.readPixels = function () { window.__counters.readPixels++; return origRead.apply(this, arguments); };
      const origDraw = W2.drawArrays;
      W2.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
    });
    await hygPage.goto(`${base}?size=128&sps=120&demo=1`, { timeout: 60000 });
    await hygPage.waitForFunction(() => !!window.__life);
    const hygGen0 = await hygPage.evaluate(() => window.__life.generation());
    await hygPage.waitForTimeout(1500);
    const hygGen1 = await hygPage.evaluate(() => window.__life.generation());
    const hyg = await hygPage.evaluate(() => window.__counters);
    record('stage12: demo hygiene — no readback, stable counters while auto-stepping; no page errors',
      hygGen1 > hygGen0 && hyg.readPixels === 0 && hyg.textures === 2 && hyg.framebuffers === 2
      && demoErrs.length === 0,
      `gen ${hygGen0}->${hygGen1} readPixels=${hyg.readPixels} tex=${hyg.textures} errs=${demoErrs.length}`);
    await hygPage.close();
    await demoPage.close();
  }

  // ---- Stage 13: long-horizon ecology stability (3000 gens, mut=0) ----
  // Probe per issue #14: with eco flags at real speed (3000+ gens in minutes),
  // no flag combination may go to total extinction nor freeze (screen full /
  // stopped). Metrics at checkpoints 2000..3000 (step 100), readback only at
  // checkpoints (batched __life.step(k), explore.js precedent):
  //   (a) pop >= 1% of the grid sustained, (b) density in [1% floor, 0.80],
  //   (c) no pinned crystal: NOT (final-window density >= 0.35 AND relative
  //       pop range < 1%), (d) sum(R+G) constant where eco exists.
  // Calibration (evidence on #14, pre-fix run): sparse Conway settling under
  // freq/energy is benign B3/S23 physics, not the issue's "fill the screen
  // and stop" freeze — so (c) requires BOTH high density AND pinned pop.
  {
    const s13Errs = [];
    const s13Page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    s13Page.on('pageerror', (e) => s13Errs.push(String(e)));
    const CHECKS = [];
    for (let t = 2000; t <= 3000; t += 100) CHECKS.push(t);
    const POP_MIN = Math.ceil(0.01 * 64 * 64);
    const DENS_LO = POP_MIN / 4096; // same 1% bound as the pop floor (the
    // plan's [0.02, 0.8] band made the lower bound stricter (82 cells) than
    // the pop floor (41) — calibrated per the plan's evidence provision)
    const DENS_HI = 0.80;
    const CRYSTAL_DENS = 0.35;
    const PIN_MIN = 0.01;
    const CFGS = [
      ['freq', { freq: '1' }],
      ['energy', { energy: '1' }],
      ['niche', { niche: '1' }],
      ['age', { age: '1' }],
      ['combo', { freq: '1', energy: '1', niche: '1', age: '1' }],
    ];
    const readRaw64s13 = () => s13Page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    const readEcoS13 = () => s13Page.evaluate(() => {
      const b = window.__life.readEco();
      return b ? Array.from(b) : null;
    });
    const popOfRaw = (raw) => {
      let p = 0;
      for (let i = 0; i < raw.length; i += 4) if (raw[i] & 1) p++;
      return p;
    };
    for (const [name, flags] of CFGS) {
      const q = new URLSearchParams({ size: '64', sps: '0.0001', seed: '7' });
      for (const [k, v] of Object.entries(flags)) q.set(k, v);
      await s13Page.goto(`${base}?${q}`, { timeout: 60000 });
      await s13Page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
      await s13Page.evaluate(() => {
        window.__life.setAuto(false);
        window.__life.setGenome('conway');
        window.__life.clear();
        for (let y = 0; y < 64; y++) {
          for (let x = 0; x < 64; x++) {
            const left = x < 32;
            const alive = left ? ((x * 3 + y * 5) % 7 < 3) : ((x * 5 + y * 3) % 11 < 4);
            if (alive) {
              window.__life.setGenome(left ? 'conway' : 'highlife');
              window.__life.stampBrush(x, y, 0);
            }
          }
        }
        window.__life.setGenome('conway');
      });
      const e0raw = await readEcoS13();
      let sum0 = 0;
      if (e0raw) for (let i = 0; i < e0raw.length; i += 4) sum0 += e0raw[i] + e0raw[i + 1];
      let cur = 0;
      let minPop = Infinity;
      let maxPop = 0;
      let maxDens = 0;
      let minDens = 1;
      let consOk = true;
      const diag = [];
      for (const t of CHECKS) {
        if (t - cur > 0) {
          await s13Page.evaluate((k) => window.__life.step(k), t - cur);
          cur = t;
        }
        const a = await readRaw64s13();
        const pop = popOfRaw(a);
        const dens = pop / 4096;
        if (pop < minPop) minPop = pop;
        if (pop > maxPop) maxPop = pop;
        if (dens > maxDens) maxDens = dens;
        if (dens < minDens) minDens = dens;
        let sum = -1;
        if (e0raw) {
          const e = await readEcoS13();
          sum = 0;
          for (let i = 0; i < e.length; i += 4) sum += e[i] + e[i + 1];
          if (sum !== sum0) consOk = false;
        }
        await s13Page.evaluate(() => window.__life.step(10));
        cur += 10;
        diag.push(`${t}:${pop}${sum >= 0 ? '/' + sum : ''}`);
      }
      const relRange = maxPop > 0 ? (maxPop - minPop) / maxPop : 0;
      const pinnedCrystal = maxDens >= CRYSTAL_DENS && relRange < PIN_MIN;
      const ok = minPop >= POP_MIN && minDens >= DENS_LO && maxDens <= DENS_HI
        && !pinnedCrystal && consOk;
      record(`stage13: ${name} @3000 (mut=0, seed=7): pop>=${POP_MIN}, dens[${DENS_LO},${DENS_HI}], no pinned crystal${e0raw ? ', conserved' : ''}`,
        ok,
        `minPop=${minPop} dens=[${minDens.toFixed(3)},${maxDens.toFixed(3)}] relRange=${relRange.toFixed(4)} crystal=${pinnedCrystal} cons=${consOk} ckpts=${diag.join(' ')}`);
    }
    record('stage13: no page errors across the long-horizon probes',
      s13Errs.length === 0, s13Errs.join('; ') || undefined);
    await s13Page.close();
  }

  // ---- Stage 14: experiment presets (?exp=border|virus|physics|replication) ----
  // Probe per issue #15: each preset boots clean, matches its CPU mirror
  // bit-for-bit where one exists (border stamping, virus rewrite, replication
  // veto via cpuStepGenomeMut), keeps physics GPU-only (reduce crosschecked
  // against a CPU sum/count; zero loop readback), and is cross-load
  // deterministic. Every readback below is validation-path (paused, batched)
  // — never inside an auto-stepping frame. seed defaults to 0, mut to 0.
  {
    const s14Errs = [];
    const mkPage = async (qs) => {
      const p = await browser.newPage({ viewport: { width: 400, height: 300 } });
      p.on('pageerror', (e) => s14Errs.push(qs + ': ' + String(e)));
      await p.goto(`${base}?${qs}`, { timeout: 60000 });
      await p.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
      const bootErr = await p.evaluate(() => (document.getElementById('error') || {}).textContent || null);
      if (bootErr) throw new Error(`${qs} boot failed: ${bootErr}`);
      await p.evaluate(() => window.__life.setAuto(false));
      return p;
    };
    const raw = (p, s) => p.evaluate((n) => Array.from(window.__life.readRaw(0, 0, n, n)), s);
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

    // -- border: stamp + B6 fingerprint, then 50-gen CPU parity --
    {
      const page = await mkPage('size=64&exp=border&sps=0.0001');
      const at = (buf, x, y) => buf[(y * 64 + x) * 4] & 1;
      const g0 = await raw(page, 64);
      const m0 = expScenario(64, EXP_PRESETS.border);
      await page.evaluate(() => window.__life.step(1));
      const g1 = await raw(page, 64);
      record('stage14: border — boot stamp matches expScenario; n==6 stimulus births only on the HighLife half at gen 1 (right center born, left center and ring corners dead)',
        eq(g0, Array.from(m0))
        && at(g0, 16, 32) === 0 && at(g0, 48, 32) === 0
        && at(g0, 15, 31) === 1 && at(g0, 47, 31) === 1
        && at(g1, 48, 32) === 1 && at(g1, 16, 32) === 0
        && at(g1, 47, 31) === 0 && at(g1, 15, 31) === 0,
        `stamp=${eq(g0, Array.from(m0))} gen1 r=${at(g1, 48, 32)} l=${at(g1, 16, 32)}`);
      let cpu = Uint8Array.from(g0);
      // The fingerprint step above already advanced the GPU to gen1 — sync the
      // CPU (start-gen convention: cpuStep(state, gen) computes gen+1 from gen)
      // and check gen1 before the parity loop.
      cpu = cpuStepGenomeMut(cpu, 64, 0, 0, 0, EXP_PRESETS.border);
      let parity = eq(g1, Array.from(cpu));
      let gen = parity ? 1 : 0;
      while (parity && gen < 50) {
        cpu = cpuStepGenomeMut(cpu, 64, gen, 0, 0, EXP_PRESETS.border);
        await page.evaluate(() => window.__life.step(1));
        const gg = await raw(page, 64);
        if (eq(gg, Array.from(cpu))) gen++;
        else parity = false;
      }
      record('stage14: border — CPU mirror (stamp-only preset) matches GPU byte-for-byte for 50 gens',
        parity && gen === 50, parity ? 'gens 1..50 identical' : `diverged at gen ${gen + 1}`);
      await page.close();
    }

    // -- virus: stamp + contagion growth + immune zone, then 30-gen parity --
    {
      const page = await mkPage('size=128&exp=virus&sps=0.0001');
      const S = 128;
      const pA = S >> 3;
      const pB = S >> 2;
      const pC = (S >> 1) + (S >> 3);
      const marked0 = (pB - pA) * S;
      const zoneCount = (buf) => {
        let virus = 0;
        let immune = 0;
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const lid = (buf[(y * S + x) * 4 + 3] >> 2) & 63;
            if (lid !== 63) continue;
            if (x < pC) virus++;
            else if (x < S - 2) immune++; // x in [size-2, size) is wrap-adjacent
          }
        }
        return { virus, immune };
      };
      let g = await raw(page, S);
      const stampOk = eq(g, Array.from(expScenario(S, EXP_PRESETS.virus)));
      const z0 = zoneCount(g);
      let cpu = Uint8Array.from(g);
      let parity = true;
      let gen = 0;
      let z5 = null;
      let z10 = null;
      let immuneMax = 0;
      while (gen < 30) {
        cpu = cpuStepGenomeMut(cpu, S, gen, 0, 0, EXP_PRESETS.virus);
        await page.evaluate(() => window.__life.step(1));
        gen++;
        g = await raw(page, S);
        if (!eq(g, Array.from(cpu))) {
          parity = false;
          break;
        }
        const z = zoneCount(g);
        if (z.immune > immuneMax) immuneMax = z.immune;
        if (gen === 5) z5 = z;
        if (gen === 10) z10 = z;
      }
      record('stage14: virus — boot stamp matches expScenario; contagion grows through gen 10; the immune zone (x in [pC, size-2)) never takes lineage 63 through gen 30',
        stampOk && z0.virus === marked0
        && z5 !== null && z10 !== null
        && z5.virus > marked0 && z10.virus > z5.virus && immuneMax === 0,
        `stamp=${stampOk} marked0=${z0.virus}/${marked0} @5=${z5 ? z5.virus : '-'} @10=${z10 ? z10.virus : '-'} immuneMax=${immuneMax}`);
      record('stage14: virus — CPU mirror (rewrite + lid clamp) matches GPU byte-for-byte for 30 gens',
        parity && gen === 30, `diverged at gen ${gen}`);
      await page.close();
    }

    // -- replication: stamp + parity + qualified-donor scan, divergence --
    {
      const page = await mkPage('size=64&exp=replication&sps=0.0001');
      const S = 64;
      const g0 = await raw(page, S);
      const stampOk = eq(g0, Array.from(expScenario(S, EXP_PRESETS.replication)));
      let g = g0;
      let cpu = Uint8Array.from(g0);
      let base = Uint8Array.from(g0); // plain Conway baseline (exp off)
      let parity = true;
      let scanOk = true;
      let diverged = false;
      let gen = 0;
      for (; gen < 50; gen++) {
        const prev = Uint8Array.from(g);
        cpu = cpuStepGenomeMut(cpu, S, gen, 0, 0, EXP_PRESETS.replication);
        base = cpuStepGenomeMut(base, S, gen, 0, 0);
        await page.evaluate(() => window.__life.step(1));
        g = await raw(page, S);
        if (!eq(g, Array.from(cpu))) parity = false;
        if (!diverged && !eq(g, Array.from(base))) diverged = true;
        if (gen < 10) {
          // Qualified-donor scan: every GPU birth must have a donor whose full
          // pack already appears >= REPLICATION_MIN times among the living
          // neighbors of that birth (hash mirrors hashCell, seed 0).
          for (let y = 0; y < S && scanOk; y++) {
            for (let x = 0; x < S && scanOk; x++) {
              const si = (y * S + x) * 4;
              if ((prev[si] & 1) || !(g[si] & 1)) continue;
              const living = [];
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const qx = (x + dx + S) % S;
                  const qy = (y + dy + S) % S;
                  const qi = (qy * S + qx) * 4;
                  if (prev[qi] & 1) {
                    living.push((prev[qi + 1] | (prev[qi + 2] << 8) | (prev[qi + 3] << 16)) >>> 0);
                  }
                }
              }
              if (living.length === 0) {
                scanOk = false;
                break;
              }
              const donor = living[hashCell(x, y, gen, 0) % living.length];
              let copies = 0;
              for (let i = 0; i < living.length; i++) if (living[i] === donor) copies++;
              if (copies < REPLICATION_MIN) scanOk = false;
            }
          }
        }
      }
      record('stage14: replication — boot stamp matches expScenario; CPU mirror (copy veto) matches GPU for 50 gens; every birth in gens 0-9 has a qualified donor',
        stampOk && parity && gen === 50 && scanOk,
        `stamp=${stampOk} parity=${parity}@${gen} scan=${scanOk}`);
      record('stage14: replication — states diverge from plain Conway on the identical stamp (veto bites)',
        diverged, `diverged=${diverged}`);
      await page.close();
    }

    // -- physics: GPU-only reduce crosschecked vs CPU + bounds + cross-load --
    {
      const p1 = await mkPage('size=64&exp=physics&sps=0.0001');
      const g0 = await raw(p1, 64);
      let cpuSum = 0;
      let cpuCnt = 0;
      for (let i = 0; i < g0.length; i += 4) {
        if (!(g0[i] & 1)) continue;
        cpuCnt++;
        cpuSum += popcount18(g0[i + 1] | (g0[i + 2] << 8) | ((g0[i + 3] & 3) << 16));
      }
      await p1.evaluate(() => window.__life.step(1)); // phys now holds gen0 state
      const ph1 = await p1.evaluate(() => window.__life.readPhys());
      await p1.evaluate(() => window.__life.step(39));
      const gA = await raw(p1, 64);
      const phA = await p1.evaluate(() => window.__life.readPhys());
      const p2 = await mkPage('size=64&exp=physics&sps=0.0001');
      await p2.evaluate(() => window.__life.step(40));
      const gB = await raw(p2, 64);
      const phB = await p2.evaluate(() => window.__life.readPhys());
      const inBounds = (p) => p && p.count > 0 && p.sum <= p.count * 18
        && p.theta >= 0 && p.theta <= 255;
      record('stage14: physics — reduce crosschecks the CPU sum/count at gen 0, theta in [0,255], cross-load identical at gen 40',
        ph1 !== null && ph1.count === cpuCnt && ph1.sum === cpuSum
        && inBounds(ph1) && inBounds(phA)
        && eq(gA, gB) && JSON.stringify(phA) === JSON.stringify(phB),
        `cpu=${cpuSum}/${cpuCnt} gpu=${ph1.sum}/${ph1.count} theta ${ph1.theta}->${phA.theta}/${phB.theta}`);
      await p1.close();
      await p2.close();
    }

    // -- physics: stamped mixed scene diverges from the no-feedback control --
    {
      // seed() flattens every genome to Conway (rule mass 3 -> theta 43 ->
      // thr 1: the gate can never reach n==3, feedback inert by design), so
      // use the preset's own 50/50 conway+heavy stamp. Control = the proven
      // CPU ref WITHOUT feedback (physics has no CPU theta mirror — plan):
      // identical per-cell masks, no gate; any divergence is the shader gate.
      const p = await mkPage('size=64&exp=physics&sps=0.0001');
      const g0 = await raw(p, 64);
      let cpu = Uint8Array.from(g0);
      await p.evaluate(() => window.__life.step(1)); // reduce ran on gen0 state
      const ph0 = await p.evaluate(() => window.__life.readPhys());
      let gG = await raw(p, 64);
      cpu = cpuStepGenomeMut(cpu, 64, 0, 0, 0);
      const d1 = !eq(gG, Array.from(cpu));
      let gen = 1;
      while (gen < 20) {
        cpu = cpuStepGenomeMut(cpu, 64, gen, 0, 0);
        await p.evaluate(() => window.__life.step(1));
        gG = await raw(p, 64);
        gen++;
      }
      const diffCells = countDiff(gG, Array.from(cpu));
      record('stage14: physics — gen 0 theta >= 96 (thr >= 3: B3 blocked) and the stamped world diverges from the no-feedback control (same masks, CPU ref without the gate)',
        ph0 !== null && ph0.theta >= 96 && ph0.theta <= 255 && d1 && diffCells > 0,
        `theta0=${ph0 ? ph0.theta : '-'} gen1Diff=${d1} diffCells@${gen}=${diffCells}`);
      await p.close();
    }

    // -- physics: no readback while auto-stepping (rule 4 hygiene) --
    {
      const hyg = await browser.newPage({ viewport: { width: 400, height: 300 } });
      hyg.on('pageerror', (e) => s14Errs.push('hyg: ' + String(e)));
      await hyg.addInitScript(() => {
        window.__counters = { textures: 0, framebuffers: 0, readPixels: 0, drawArrays: 0 };
        const W2 = WebGL2RenderingContext.prototype;
        for (const [name, key] of [['createTexture', 'textures'], ['createFramebuffer', 'framebuffers']]) {
          const orig = W2[name];
          W2[name] = function () { window.__counters[key]++; return orig.apply(this, arguments); };
        }
        const origRead = W2.readPixels;
        W2.readPixels = function () { window.__counters.readPixels++; return origRead.apply(this, arguments); };
        const origDraw = W2.drawArrays;
        W2.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
      });
      await hyg.goto(`${base}?size=128&sps=120&exp=physics`, { timeout: 60000 });
      await hyg.waitForFunction(() => !!window.__life);
      const h0 = await hyg.evaluate(() => window.__life.generation());
      await hyg.waitForTimeout(1500);
      const h1 = await hyg.evaluate(() => window.__life.generation());
      const c = await hyg.evaluate(() => window.__counters);
      record('stage14: physics — zero readPixels while auto-stepping; allocs stable (2 state + mid + sum + count = 5 tex/fbo)',
        h1 > h0 && c.readPixels === 0 && c.textures === 5 && c.framebuffers === 5,
        `gen ${h0}->${h1} readPixels=${c.readPixels} tex=${c.textures} fbo=${c.framebuffers} draws=${c.drawArrays}`);
      await hyg.close();
    }

    // -- all four presets: cross-load determinism (+ page-error gate) --
    {
      const det = [];
      for (const name of ['border', 'virus', 'physics', 'replication']) {
        const pA = await mkPage(`size=64&exp=${name}&sps=0.0001`);
        const pB = await mkPage(`size=64&exp=${name}&sps=0.0001`);
        await pA.evaluate(() => window.__life.step(15));
        await pB.evaluate(() => window.__life.step(15));
        const ra = await raw(pA, 64);
        const rb = await raw(pB, 64);
        det.push({ name, ok: eq(ra, rb) });
        await pA.close();
        await pB.close();
      }
      record('stage14: all four presets cross-load deterministic at gen 15; no page errors across the preset probes',
        det.every((d) => d.ok) && s14Errs.length === 0,
        det.map((d) => `${d.name}=${d.ok}`).join(' ') + (s14Errs.length ? ' errs=' + s14Errs.join('; ') : ''));
    }

    // -- explorer: --exp plumbing (config/params/entryId/reproUrl/copyRate) --
    {
      const expTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explore14-'));
      execFileSync('node', [
        path.join(ROOT, 'tools', 'explore.js'),
        '--size', '64', '--gens', '20', '--worlds', '1', '--seed-base', '3',
        '--pattern', 'still', '--force-keep', '--no-gif', '--exp', 'physics',
        '--archive', path.join(expTmp, 'archive.json'),
        '--out', expTmp,
      ], { cwd: ROOT, stdio: 'pipe' });
      const runJ = JSON.parse(fs.readFileSync(path.join(expTmp, 'run.json'), 'utf8'));
      const w = runJ.worlds[0];
      const entry = JSON.parse(fs.readFileSync(path.join(expTmp, w.entry, 'metrics.json'), 'utf8'));
      const bad = spawnSync('node', [
        path.join(ROOT, 'tools', 'explore.js'), '--exp', 'nope',
      ], { cwd: ROOT, stdio: 'pipe' });
      record('stage14: explorer --exp smoke (config+params+entryId+reproUrl carry exp, top-level copyRate in [0,1]) and invalid --exp rejected',
        runJ.config.exp === 'physics'
        && w.params.exp === 'physics'
        && typeof w.copyRate === 'number' && w.copyRate >= 0 && w.copyRate <= 1
        && typeof entry.copyRate === 'number' && entry.copyRate === w.copyRate
        && /_expphysics$/.test(w.entry)
        && /&exp=physics$/.test(entry.reproUrl)
        && bad.status !== 0,
        `entry=${w.entry} copyRate=${w.copyRate} repro=${entry.reproUrl} badStatus=${bad.status}`);
      fs.rmSync(expTmp, { recursive: true, force: true });
    }
  }

  record(
    'no page errors or console errors across the whole run',
    pageErrors.length === 0 && !console_.some((m) => m.startsWith('[error]')),
    [...pageErrors, ...console_.filter((m) => m.startsWith('[error]'))].join('; ') || undefined,
  );

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error(`FAILED: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
