import type {
  BrickModel,
  BuildStep,
  ColorDef,
  PlanBrick,
  PouchSpec,
  ShapeDef,
  ShapeKey,
} from '../types/brick';

/* ═══════ 已定案尺寸（請勿更動） ═══════ */
export const CELL = 0.55;
export const BRICK_H = CELL * 1.2; // 0.66
export const STUD_R = CELL * 0.30;
export const STUD_H = CELL * 0.18;
export const W = (g: number): number => g * CELL;

export const SHAPES: Record<ShapeKey, ShapeDef> = {
  '1x1': { cells: [[0, 0]], label: '單格' },
  '1x2': { cells: [[0, 0], [1, 0]], label: '兩格' },
  '1x3': { cells: [[0, 0], [1, 0], [2, 0]], label: '三格' },
  '1x4': { cells: [[0, 0], [1, 0], [2, 0], [3, 0]], label: '四格' },
  '2x2': { cells: [[0, 0], [1, 0], [0, 1], [1, 1]], label: '2×2 方塊' },
  '2x3': {
    cells: [
      [0, 0], [1, 0], [2, 0],
      [0, 1], [1, 1], [2, 1],
    ],
    label: '2×3 中板',
  },
  '2x4': {
    cells: [
      [0, 0], [1, 0], [2, 0], [3, 0],
      [0, 1], [1, 1], [2, 1], [3, 1],
    ],
    label: '2×4 長板',
  },
  '4x4': {
    cells: [
      [0, 0], [1, 0], [2, 0], [3, 0],
      [0, 1], [1, 1], [2, 1], [3, 1],
      [0, 2], [1, 2], [2, 2], [3, 2],
      [0, 3], [1, 3], [2, 3], [3, 3],
    ],
    label: '4×4 大底板',
  },
  L3: { cells: [[0, 0], [1, 0], [0, 1]], label: '三格轉角 L' },
  slope1x1: { cells: [[0, 0]], studCells: [], isSlope: true, label: '1×1 斜坡' },
  slope1x2: { cells: [[0, 0], [1, 0]], studCells: [[0, 0]], isSlope: true, label: '1×2 斜坡' },
};

function rawRotPoint(x: number, z: number, rot: number): [number, number] {
  const r = ((rot % 360) + 360) % 360;
  if (r === 0) return [x, z];
  if (r === 90) return [-z, x];
  if (r === 180) return [-x, -z];
  return [z, -x];
}

export function rotCells(cells: [number, number][], rot: number): [number, number][] {
  const out = cells.map(([x, z]) => rawRotPoint(x, z, rot));
  const mnX = Math.min(...out.map(c => c[0]));
  const mnZ = Math.min(...out.map(c => c[1]));
  return out.map(([x, z]) => [x - mnX, z - mnZ]);
}

export function shapeStudCells(shape: ShapeKey, rot: number): [number, number][] {
  const def = SHAPES[shape];
  const baseStuds = def.studCells ?? def.cells;
  if (baseStuds.length === 0) return [];
  const allRaw = def.cells.map(([x, z]) => rawRotPoint(x, z, rot));
  const mnX = Math.min(...allRaw.map(c => c[0]));
  const mnZ = Math.min(...allRaw.map(c => c[1]));
  return baseStuds.map(([x, z]) => {
    const [rx, rz] = rawRotPoint(x, z, rot);
    return [rx - mnX, rz - mnZ];
  });
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

interface ShapeTemplate {
  shape: ShapeKey;
  rot: number;
  cells: [number, number][];
  size: number;
  orient: 'h' | 'v' | 'sq';
}

function buildTemplateList(
  specs: Array<{ shape: ShapeKey; rots: number[]; orientForRot: (r: number) => 'h' | 'v' | 'sq' }>
): ShapeTemplate[] {
  const out: ShapeTemplate[] = [];
  for (const s of specs) {
    for (const rot of s.rots) {
      const cells = rotCells(SHAPES[s.shape].cells, rot);
      out.push({
        shape: s.shape,
        rot,
        cells,
        size: cells.length,
        orient: s.orientForRot(rot),
      });
    }
  }
  return out;
}

const BASE_TEMPLATE_SPECS: Array<{
  shape: ShapeKey;
  rots: number[];
  orientForRot: (r: number) => 'h' | 'v' | 'sq';
}> = [
  { shape: '1x4', rots: [0, 90], orientForRot: r => (r === 0 ? 'h' : 'v') },
  { shape: '2x2', rots: [0], orientForRot: () => 'sq' },
  { shape: '1x3', rots: [0, 90], orientForRot: r => (r === 0 ? 'h' : 'v') },
  { shape: 'L3', rots: [0, 90, 180, 270], orientForRot: () => 'sq' },
  { shape: '1x2', rots: [0, 90], orientForRot: r => (r === 0 ? 'h' : 'v') },
  { shape: '1x1', rots: [0], orientForRot: () => 'sq' },
];

const LARGE_TEMPLATE_SPECS: Array<{
  shape: ShapeKey;
  rots: number[];
  orientForRot: (r: number) => 'h' | 'v' | 'sq';
}> = [
  { shape: '4x4', rots: [0], orientForRot: () => 'sq' },
  { shape: '2x4', rots: [0, 90], orientForRot: r => (r === 0 ? 'h' : 'v') },
  { shape: '2x3', rots: [0, 90], orientForRot: r => (r === 0 ? 'h' : 'v') },
  ...BASE_TEMPLATE_SPECS,
];

const FILL_TEMPLATES: ShapeTemplate[] = buildTemplateList(BASE_TEMPLATE_SPECS);
const FILL_TEMPLATES_LARGE: ShapeTemplate[] = buildTemplateList(LARGE_TEMPLATE_SPECS);

interface PlacementCandidate {
  tpl: ShapeTemplate;
  gx: number;
  gz: number;
  mask: number;
  indices: number[];
}

interface ExactScore {
  bricks: number;
  ones: number;
  non4: number;
  dirPenalty: number;
  chosen: PlacementCandidate[];
}

function isScoreBetter(a: ExactScore, b: ExactScore): boolean {
  if (a.bricks !== b.bricks) return a.bricks < b.bricks;
  if (a.ones !== b.ones) return a.ones < b.ones;
  if (a.non4 !== b.non4) return a.non4 < b.non4;
  return a.dirPenalty < b.dirPenalty;
}

function solveExactComponent(
  cells: Array<[number, number]>,
  color: number,
  preferVertical: boolean,
  templates: ShapeTemplate[]
): RawFilledBrick[] | null {
  const n = cells.length;
  if (n === 0 || n > 14) return null;

  const coordToIdx = new Map<string, number>();
  cells.forEach(([x, z], idx) => coordToIdx.set(`${x},${z}`, idx));

  const byFirstBit: PlacementCandidate[][] = Array.from({ length: n }, () => []);
  const seenKey = new Set<string>();

  for (let idx = 0; idx < n; idx++) {
    const [cx, cz] = cells[idx];
    for (const tpl of templates) {
      for (const [ox, oz] of tpl.cells) {
        const gx = cx - ox;
        const gz = cz - oz;
        const pKey = `${tpl.shape}:${tpl.rot}:${gx},${gz}`;
        if (seenKey.has(pKey)) continue;

        let mask = 0;
        const indices: number[] = [];
        let ok = true;
        for (const [dx, dz] of tpl.cells) {
          const hit = coordToIdx.get(`${gx + dx},${gz + dz}`);
          if (hit === undefined) {
            ok = false;
            break;
          }
          mask |= 1 << hit;
          indices.push(hit);
        }
        if (!ok) continue;
        seenKey.add(pKey);

        // Lowest set bit inside this mask determines which subproblem anchor calls it
        let lowest = 0;
        while ((mask & (1 << lowest)) === 0) lowest++;
        byFirstBit[lowest].push({ tpl, gx, gz, mask, indices });
      }
    }
  }

  for (let i = 0; i < n; i++) {
    byFirstBit[i].sort((a, b) => {
      if (b.tpl.size !== a.tpl.size) return b.tpl.size - a.tpl.size;
      const aMatch =
        (preferVertical && a.tpl.orient === 'v') || (!preferVertical && a.tpl.orient === 'h') ? 1 : 0;
      const bMatch =
        (preferVertical && b.tpl.orient === 'v') || (!preferVertical && b.tpl.orient === 'h') ? 1 : 0;
      return bMatch - aMatch;
    });
  }

  const memo = new Map<number, ExactScore>();
  let visited = 0;
  const MAX_VISITS = 700;
  let aborted = false;

  const solve = (remMask: number): ExactScore => {
    if (remMask === 0) {
      return { bricks: 0, ones: 0, non4: 0, dirPenalty: 0, chosen: [] };
    }
    const cached = memo.get(remMask);
    if (cached) return cached;
    if (++visited > MAX_VISITS) {
      aborted = true;
      return { bricks: 999, ones: 999, non4: 999, dirPenalty: 999, chosen: [] };
    }

    let first = 0;
    while ((remMask & (1 << first)) === 0) first++;

    let best: ExactScore | null = null;
    for (const cand of byFirstBit[first]) {
      if ((cand.mask & remMask) !== cand.mask) continue;
      const sub = solve(remMask ^ cand.mask);
      if (aborted) break;

      const isOne = cand.tpl.size === 1 ? 1 : 0;
      const isNon4 = cand.tpl.size < 4 ? 1 : 0;
      const dirPen =
        (preferVertical && cand.tpl.orient === 'h') || (!preferVertical && cand.tpl.orient === 'v')
          ? 1
          : 0;

      const candidateScore: ExactScore = {
        bricks: sub.bricks + 1,
        ones: sub.ones + isOne,
        non4: sub.non4 + isNon4,
        dirPenalty: sub.dirPenalty + dirPen,
        chosen: [cand, ...sub.chosen],
      };
      if (!best || isScoreBetter(candidateScore, best)) {
        best = candidateScore;
      }
    }

    const res = best ?? { bricks: 999, ones: 999, non4: 999, dirPenalty: 999, chosen: [] };
    memo.set(remMask, res);
    return res;
  };

  const fullMask = (1 << n) - 1;
  const final = solve(fullMask);
  if (aborted || final.bricks >= 999) return null;

  return final.chosen.map(c => ({
    shape: c.tpl.shape,
    rot: c.tpl.rot,
    color,
    gx: c.gx,
    gz: c.gz,
  }));
}

/**
 * 智慧型積木拆解填磚：
 * 1. 新增 1x3、2x2 與 L3 三格轉角型，消除原本 3 格/L 角必須碎成小塊的問題。
 * 2. 避免把連續 4 格誤拆成 3+1 或 2+1+1：對 <= 14 格連通區做最優磚數精算；
 *    大面積區塊先依「最少孤立單格 + 優先 4 格完整條 + 奇偶交錯」逐塊填放，剩 <= 14 格立即轉入精算收尾。
 */
export function fillMask(
  rows: string[],
  preferVertical: boolean,
  paletteLen = 2,
  blockedCoords?: Set<string>,
  allowLargeBricks = false
): RawFilledBrick[] {
  const templates = allowLargeBricks ? FILL_TEMPLATES_LARGE : FILL_TEMPLATES;
  const H = rows.length;
  const Wd = rows[0]?.length ?? 0;
  const grid: (ParsedCell | null)[][] = rows.map(r =>
    r.split('').map(c => parseMaskChar(c, paletteLen))
  );
  const free = grid.map((r, z) =>
    r.map((c, x) => c !== null && !(blockedCoords?.has(`${x},${z}`) ?? false))
  );
  const out: RawFilledBrick[] = [];

  // 先處理強制單格點位（例如眼睛 'E'）
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < Wd; x++) {
      const cell = grid[z][x];
      if (free[z][x] && cell && cell.singleOnly) {
        out.push({ shape: '1x1', rot: 0, color: cell.color, gx: x, gz: z });
        free[z][x] = false;
      }
    }
  }

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const neighborDegree = (x: number, z: number, color: number): number => {
    let deg = 0;
    for (const [dx, dz] of dirs) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx >= 0 && nz >= 0 && nx < Wd && nz < H && free[nz][nx] && grid[nz][nx]?.color === color) {
        deg++;
      }
    }
    return deg;
  };

  // 逐個連通同色區塊拆解
  const visited = Array.from({ length: H }, () => Array<boolean>(Wd).fill(false));
  for (let sz = 0; sz < H; sz++) {
    for (let sx = 0; sx < Wd; sx++) {
      if (!free[sz][sx] || visited[sz][sx]) continue;
      const color = grid[sz][sx]!.color;

      const comp: Array<[number, number]> = [];
      const queue: Array<[number, number]> = [[sx, sz]];
      visited[sz][sx] = true;
      while (queue.length > 0) {
        const [cx, cz] = queue.shift()!;
        comp.push([cx, cz]);
        for (const [dx, dz] of dirs) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (
            nx >= 0 &&
            nz >= 0 &&
            nx < Wd &&
            nz < H &&
            !visited[nz][nx] &&
            free[nz][nx] &&
            grid[nz][nx]?.color === color
          ) {
            visited[nz][nx] = true;
            queue.push([nx, nz]);
          }
        }
      }

      if (comp.length <= 14) {
        const exact = solveExactComponent(comp, color, preferVertical, templates);
        if (exact) {
          for (const b of exact) {
            out.push(b);
            for (const [dx, dz] of rotCells(SHAPES[b.shape].cells, b.rot)) {
              free[b.gz + dz][b.gx + dx] = false;
            }
          }
          continue;
        }
      }

      // 大面積區塊：先用無孤立格前瞻貪心填放，直到剩餘免費格 <= 14 再精算收尾
      let remaining = [...comp];
      while (remaining.length > 0) {
        remaining = remaining.filter(([x, z]) => free[z][x]);
        if (remaining.length === 0) break;

        if (remaining.length <= 14) {
          const exact = solveExactComponent(remaining, color, preferVertical, templates);
          if (exact) {
            for (const b of exact) {
              out.push(b);
              for (const [dx, dz] of rotCells(SHAPES[b.shape].cells, b.rot)) {
                free[b.gz + dz][b.gx + dx] = false;
              }
            }
            break;
          }
        }

        // 挑選鄰居最少的邊角/突出格先解決，最不會把完整長條剪斷
        let anchor = remaining[0];
        let bestDeg = 99;
        for (const pt of remaining) {
          const d = neighborDegree(pt[0], pt[1], color);
          if (d < bestDeg) {
            bestDeg = d;
            anchor = pt;
            if (d <= 1) break;
          }
        }

        const [ax, az] = anchor;
        let bestMove: { tpl: ShapeTemplate; gx: number; gz: number; score: number } | null = null;

        for (const tpl of templates) {
          for (const [ox, oz] of tpl.cells) {
            const gx = ax - ox;
            const gz = az - oz;
            const absCells: Array<[number, number]> = [];
            let valid = true;
            for (const [dx, dz] of tpl.cells) {
              const xx = gx + dx;
              const zz = gz + dz;
              if (
                xx < 0 ||
                zz < 0 ||
                xx >= Wd ||
                zz >= H ||
                !free[zz][xx] ||
                grid[zz][xx]?.color !== color
              ) {
                valid = false;
                break;
              }
              absCells.push([xx, zz]);
            }
            if (!valid) continue;

            // 暫時標記放置，計算周邊是否製造了孤立 1x1
            for (const [xx, zz] of absCells) free[zz][xx] = false;
            const checkedAdj = new Set<string>();
            let orphans = 0;
            for (const [xx, zz] of absCells) {
              for (const [ddx, ddz] of dirs) {
                const nx = xx + ddx;
                const nz = zz + ddz;
                const k = `${nx},${nz}`;
                if (
                  nx >= 0 &&
                  nz >= 0 &&
                  nx < Wd &&
                  nz < H &&
                  free[nz][nx] &&
                  grid[nz][nx]?.color === color &&
                  !checkedAdj.has(k)
                ) {
                  checkedAdj.add(k);
                  if (neighborDegree(nx, nz, color) === 0) orphans++;
                }
              }
            }
            for (const [xx, zz] of absCells) free[zz][xx] = true;

            const sizeScore = tpl.size === 1 ? 0 : tpl.size * 34;
            const dirBonus =
              (preferVertical && tpl.orient === 'v') || (!preferVertical && tpl.orient === 'h')
                ? 8
                : 0;
            const rectBonus =
              tpl.shape === '4x4'
                ? 12
                : tpl.shape === '2x4'
                  ? 8
                  : tpl.shape === '2x3'
                    ? 6
                    : tpl.shape === '1x4'
                      ? 4
                      : tpl.shape === '2x2'
                        ? 3
                        : 0;
            const score = sizeScore + rectBonus + dirBonus - orphans * 140;

            if (!bestMove || score > bestMove.score) {
              bestMove = { tpl, gx, gz, score };
            }
          }
        }

        if (bestMove) {
          out.push({
            shape: bestMove.tpl.shape,
            rot: bestMove.tpl.rot,
            color,
            gx: bestMove.gx,
            gz: bestMove.gz,
          });
          for (const [dx, dz] of bestMove.tpl.cells) {
            free[bestMove.gz + dz][bestMove.gx + dx] = false;
          }
        } else {
          out.push({ shape: '1x1', rot: 0, color, gx: ax, gz: az });
          free[az][ax] = false;
        }
      }
    }
  }

  return out;
}

const MAX_POUCH_BRICKS = 11;

/**
 * 依「顏色 + 零件大小」拆成較多包小袋子，每包約 4~11 顆；同色零星小件合併成同色混合袋
 */
export function assignSortedPouches(plan: PlanBrick[], palette: ColorDef[]): PouchSpec[] {
  if (plan.length === 0) return [];

  const shapeOrder: ShapeKey[] = [
    '4x4',
    '2x4',
    '2x3',
    '1x4',
    '2x2',
    '1x3',
    'L3',
    '1x2',
    'slope1x2',
    'slope1x1',
    '1x1',
  ];
  const byColor = new Map<number, PlanBrick[]>();
  for (const b of plan) {
    let arr = byColor.get(b.color);
    if (!arr) {
      arr = [];
      byColor.set(b.color, arr);
    }
    arr.push(b);
  }

  interface RawGroup {
    colorIdx: number;
    shapeHint: ShapeKey | 'mixed';
    bricks: PlanBrick[];
  }

  const rawGroups: RawGroup[] = [];
  const colorKeys = [...byColor.keys()].sort((a, b) => a - b);

  for (const colorIdx of colorKeys) {
    const items = byColor.get(colorIdx)!;
    const byShape = new Map<ShapeKey, PlanBrick[]>();
    for (const sh of shapeOrder) byShape.set(sh, []);
    for (const b of items) {
      byShape.get(b.shape)?.push(b);
    }

    const tinyOverflow: PlanBrick[] = [];
    for (const sh of shapeOrder) {
      const list = byShape.get(sh) ?? [];
      if (list.length === 0) continue;
      if (list.length <= 2 && items.length >= 4) {
        tinyOverflow.push(...list);
      } else {
        rawGroups.push({ colorIdx, shapeHint: sh, bricks: list });
      }
    }
    if (tinyOverflow.length > 0) {
      const uniqueShapes = new Set(tinyOverflow.map(b => b.shape));
      rawGroups.push({
        colorIdx,
        shapeHint: uniqueShapes.size === 1 ? tinyOverflow[0].shape : 'mixed',
        bricks: tinyOverflow,
      });
    }
  }

  const finalBuckets: RawGroup[] = [];
  let accentMix: PlanBrick[] = [];
  const flushAccent = () => {
    if (accentMix.length === 0) return;
    const shapes = new Set(accentMix.map(b => b.shape));
    finalBuckets.push({
      colorIdx: accentMix[0].color,
      shapeHint: shapes.size === 1 ? accentMix[0].shape : 'mixed',
      bricks: accentMix,
    });
    accentMix = [];
  };

  for (const g of rawGroups) {
    if (rawGroups.length > 7 && g.bricks.length <= 2) {
      if (accentMix.length + g.bricks.length > MAX_POUCH_BRICKS) {
        flushAccent();
      }
      accentMix.push(...g.bricks);
    } else {
      finalBuckets.push(g);
    }
  }
  flushAccent();

  const pouches: PouchSpec[] = [];
  for (const bucket of finalBuckets) {
    const chunks = Math.max(1, Math.ceil(bucket.bricks.length / MAX_POUCH_BRICKS));
    const perChunk = Math.ceil(bucket.bricks.length / chunks);
    for (let c = 0; c < chunks; c++) {
      const slice = bucket.bricks.slice(c * perChunk, (c + 1) * perChunk);
      if (slice.length === 0) continue;
      const pIdx = pouches.length;
      const distinctColors = new Set(slice.map(b => b.color));
      const distinctShapes = new Set(slice.map(b => b.shape));
      const colorLabel =
        distinctColors.size === 1
          ? palette[slice[0].color]?.name ?? `色${slice[0].color + 1}`
          : '跳色點綴';
      const shapeLabel =
        distinctShapes.size === 1 ? SHAPES[slice[0].shape].label : '大小混合';
      const suffix = chunks > 1 ? ` ${c + 1}/${chunks}` : '';
      const defaultTrayIndex = pIdx % 3;

      for (const b of slice) {
        b.packIndex = pIdx;
        b.trayIndex = defaultTrayIndex;
      }

      pouches.push({
        index: pIdx,
        label: `${colorLabel} · ${shapeLabel}${suffix}`,
        colorIdx: slice[0].color,
        shapeHint: distinctShapes.size === 1 ? slice[0].shape : 'mixed',
        count: slice.length,
        defaultTrayIndex,
      });
    }
  }

  return pouches;
}

export function buildSortedPouches(model: BrickModel): PouchSpec[] {
  const plan = buildPlan(model);
  return assignSortedPouches(plan, model.palette);
}

export function buildPlan(model: BrickModel): PlanBrick[] {
  const modelH = model.masks[0]?.length ?? 8;
  const modelW = model.masks[0]?.[0]?.length ?? 12;
  const ofx = Math.floor((model.board.w - modelW) / 2);
  const ofz = Math.floor((model.board.d - modelH) / 2);
  const plan: PlanBrick[] = [];

  const specialsByLayer = new Map<number, NonNullable<BrickModel['specialBricks']>>();
  const blockedByLayer = new Map<number, Set<string>>();
  for (const sp of model.specialBricks ?? []) {
    let arr = specialsByLayer.get(sp.layer);
    if (!arr) {
      arr = [];
      specialsByLayer.set(sp.layer, arr);
    }
    arr.push(sp);

    let set = blockedByLayer.get(sp.layer);
    if (!set) {
      set = new Set();
      blockedByLayer.set(sp.layer, set);
    }
    for (const [dx, dz] of rotCells(SHAPES[sp.shape].cells, sp.rot)) {
      set.add(`${sp.gx + dx},${sp.gz + dz}`);
    }
  }

  let idx = 0;
  model.masks.forEach((mask, layer) => {
    const blocked = blockedByLayer.get(layer);
    const allowLarge = Boolean(model.allowLargePlates || model.largePlateLayers?.includes(layer));
    const filled = fillMask(mask, layer % 2 === 1, model.palette.length, blocked, allowLarge);
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
        packIndex: 0,
        trayIndex: 0,
      });
    }

    for (const sp of specialsByLayer.get(layer) ?? []) {
      const gx = sp.gx + ofx;
      const gz = sp.gz + ofz;
      const cells = worldCells(sp.shape, sp.rot, gx, gz);
      const bb = bboxOf(rotCells(SHAPES[sp.shape].cells, sp.rot));
      plan.push({
        index: idx++,
        shape: sp.shape,
        rot: sp.rot,
        color: sp.color,
        gx,
        gz,
        layer,
        cells,
        bb,
        cellSet: new Set(cells),
        packIndex: 0,
        trayIndex: 0,
      });
    }
  });

  assignSortedPouches(plan, model.palette);
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
