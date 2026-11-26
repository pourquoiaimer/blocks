import type { BrickModel, BuildStep, PlanBrick, ShapeDef, ShapeKey } from '../types/brick';

/* ═══════ 已定案尺寸（請勿更動） ═══════ */
export const CELL = 0.55;
export const BRICK_H = CELL * 1.2; // 0.66
export const STUD_R = CELL * 0.30;
export const STUD_H = CELL * 0.18;
export const W = (g: number): number => g * CELL;

export const SHAPES: Record<ShapeKey, ShapeDef> = {
  '1x1': { cells: [[0, 0]], label: '單格' },
  '1x2': { cells: [[0, 0], [1, 0]], label: '兩格' },
  '1x4': { cells: [[0, 0], [1, 0], [2, 0], [3, 0]], label: '四格' },
};

export function rotCells(cells: [number, number][], rot: number): [number, number][] {
  const r = ((rot % 360) + 360) % 360;
  const out: [number, number][] = cells.map(([x, z]) => {
    if (r === 0) return [x, z];
    if (r === 90) return [-z, x];
    if (r === 180) return [-x, -z];
    return [z, -x];
  });
  const mnX = Math.min(...out.map(c => c[0]));
  const mnZ = Math.min(...out.map(c => c[1]));
  return out.map(([x, z]) => [x - mnX, z - mnZ]);
}

export function bboxOf(cells: [number, number][]): { w: number; d: number } {
  const xs = cells.map(c => c[0]);
  const zs = cells.map(c => c[1]);
  return { w: Math.max(...xs) + 1, d: Math.max(...zs) + 1 };
}

export function outlineLoop(cells: [number, number][]): string[] | null {
  const has = new Set(cells.map(([x, z]) => `${x},${z}`));
  const outs = new Map<string, string[]>();
  const push = (a: string, b: string) => {
    let arr = outs.get(a);
    if (!arr) {
      arr = [];
      outs.set(a, arr);
    }
    arr.push(b);
  };
  for (const [x, z] of cells) {
    if (!has.has(`${x},${z - 1}`)) push(`${x},${z}`, `${x + 1},${z}`);
    if (!has.has(`${x + 1},${z}`)) push(`${x + 1},${z}`, `${x + 1},${z + 1}`);
    if (!has.has(`${x},${z + 1}`)) push(`${x + 1},${z + 1}`, `${x},${z + 1}`);
    if (!has.has(`${x - 1},${z}`)) push(`${x},${z + 1}`, `${x},${z}`);
  }
  const start = outs.keys().next().value as string | undefined;
  if (!start) return null;
  const loop = [start];
  let cur = start;
  let prev: string | null = null;
  for (let i = 0; i < 300; i++) {
    const list = outs.get(cur) || [];
    const nxt = list.find(v => v !== prev) ?? list[0];
    if (!nxt) break;
    if (nxt === start) return loop;
    loop.push(nxt);
    prev = cur;
    cur = nxt;
  }
  return loop.length >= 3 ? loop : null;
}

export function worldCells(shape: ShapeKey, rot: number, gx: number, gz: number): string[] {
  return rotCells(SHAPES[shape].cells, rot).map(([x, z]) => `${gx + x},${gz + z}`);
}

interface ParsedCell {
  color: number;
  singleOnly: boolean;
}

function parseMaskChar(ch: string, paletteLen: number): ParsedCell | null {
  if (ch === '.' || ch === ' ') return null;
  if (ch === 'X') return { color: 0, singleOnly: false };
  if (ch === 'E') return { color: Math.min(1, Math.max(0, paletteLen - 1)), singleOnly: true };
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) {
    const idx = code - 48;
    return { color: Math.min(idx, Math.max(0, paletteLen - 1)), singleOnly: false };
  }
  // Uppercase A-Z (excluding E/X) -> 10+ or single-only if lowercase
  if (code >= 65 && code <= 90) {
    const idx = (code - 65) % Math.max(1, paletteLen);
    return { color: idx, singleOnly: false };
  }
  if (code >= 97 && code <= 122) {
    const idx = (code - 97) % Math.max(1, paletteLen);
    return { color: idx, singleOnly: true };
  }
  return { color: 0, singleOnly: false };
}

export interface RawFilledBrick {
  shape: ShapeKey;
  rot: number;
  color: number;
  gx: number;
  gz: number;
}

export function fillMask(rows: string[], preferVertical: boolean, paletteLen = 2): RawFilledBrick[] {
  const H = rows.length;
  const Wd = rows[0]?.length ?? 0;
  const grid: (ParsedCell | null)[][] = rows.map(r =>
    r.split('').map(c => parseMaskChar(c, paletteLen))
  );
  const free = grid.map(r => r.map(c => c !== null));
  const out: RawFilledBrick[] = [];

  const can = (x: number, z: number, w: number, d: number, color: number): boolean => {
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const xx = x + dx;
        const zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= Wd || zz >= H) return false;
        const cell = grid[zz][xx];
        if (!free[zz][xx] || !cell || cell.singleOnly || cell.color !== color) return false;
      }
    }
    return true;
  };

  const take = (x: number, z: number, w: number, d: number, shape: ShapeKey, rot: number, color: number) => {
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) {
        free[z + dz][x + dx] = false;
      }
    }
    out.push({ shape, rot, color, gx: x, gz: z });
  };

  const order: [number, number, ShapeKey, number][] = preferVertical
    ? [[1, 4, '1x4', 90], [4, 1, '1x4', 0], [1, 2, '1x2', 90], [2, 1, '1x2', 0]]
    : [[4, 1, '1x4', 0], [1, 4, '1x4', 90], [2, 1, '1x2', 0], [1, 2, '1x2', 90]];

  for (const [w, d, s, rot] of order) {
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < Wd; x++) {
        const cell = grid[z][x];
        if (free[z][x] && cell && !cell.singleOnly && can(x, z, w, d, cell.color)) {
          take(x, z, w, d, s, rot, cell.color);
        }
      }
    }
  }

  for (let z = 0; z < H; z++) {
    for (let x = 0; x < Wd; x++) {
      const cell = grid[z][x];
      if (free[z][x] && cell) {
        out.push({ shape: '1x1', rot: 0, color: cell.color, gx: x, gz: z });
        free[z][x] = false;
      }
    }
  }

  return out;
}

export function buildPlan(model: BrickModel): PlanBrick[] {
  const modelH = model.masks[0]?.length ?? 8;
  const modelW = model.masks[0]?.[0]?.length ?? 12;
  const ofx = Math.floor((model.board.w - modelW) / 2);
  const ofz = Math.floor((model.board.d - modelH) / 2);
  const plan: PlanBrick[] = [];

  const packForLayer = (layer: number): { packIndex: number; trayIndex: number } => {
    for (let i = 0; i < model.packs.length; i++) {
      if (layer <= model.packs[i].maxLayer) {
        return { packIndex: i, trayIndex: model.packs[i].trayIndex };
      }
    }
    const last = model.packs.length - 1;
    return { packIndex: Math.max(0, last), trayIndex: last >= 0 ? model.packs[last].trayIndex : 0 };
  };

  let idx = 0;
  model.masks.forEach((mask, layer) => {
    const filled = fillMask(mask, layer % 2 === 1, model.palette.length);
    const { packIndex, trayIndex } = packForLayer(layer);
    for (const b of filled) {
      const gx = b.gx + ofx;
      const gz = b.gz + ofz;
      const cells = worldCells(b.shape, b.rot, gx, gz);
      const bb = bboxOf(rotCells(SHAPES[b.shape].cells, b.rot));
      plan.push({
        index: idx++,
        shape: b.shape,
        rot: b.rot,
        color: b.color,
        gx,
        gz,
        layer,
        cells,
        bb,
        cellSet: new Set(cells),
        packIndex,
        trayIndex,
      });
    }
  });

  return plan;
}

export function buildSteps(
  plan: PlanBrick[],
  sections?: { name: string; maxLayer: number }[]
): BuildStep[] {
  const byLayer = new Map<number, PlanBrick[]>();
  for (const p of plan) {
    let arr = byLayer.get(p.layer);
    if (!arr) {
      arr = [];
      byLayer.set(p.layer, arr);
    }
    arr.push(p);
  }

  const sectionForLayer = (layer: number): string | undefined => {
    if (!sections || sections.length === 0) return undefined;
    for (const s of sections) {
      if (layer <= s.maxLayer) return s.name;
    }
    return sections[sections.length - 1]?.name;
  };

  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const steps: BuildStep[] = [];
  const accumulated: PlanBrick[] = [];

  for (const L of layers) {
    const items = [...(byLayer.get(L) ?? [])].sort((a, b) => {
      if (a.gz !== b.gz) return a.gz - b.gz;
      if (a.gx !== b.gx) return a.gx - b.gx;
      return a.index - b.index;
    });

    let i = 0;
    while (i < items.length) {
      const rem = items.length - i;
      let take = 5;
      if (rem <= 6) {
        take = rem;
      } else if (rem === 7) {
        take = 4;
      } else if (rem === 8) {
        take = 4;
      } else if (rem === 9) {
        take = 5;
      } else if (rem === 10) {
        take = 5;
      } else if (rem - 5 < 3) {
        take = 4;
      }
      const chunk = items.slice(i, i + take);
      steps.push({
        stepIndex: steps.length,
        layer: L,
        sectionName: sectionForLayer(L),
        bricks: chunk,
        prevBricks: [...accumulated],
      });
      accumulated.push(...chunk);
      i += take;
    }
  }

  return steps;
}

export function rgbDistSq(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

export function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}
