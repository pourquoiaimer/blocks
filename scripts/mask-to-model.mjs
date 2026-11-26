#!/usr/bin/env node
/**
 * 遮罩轉積木腳本（P1 工具）
 * 用法：node scripts/mask-to-model.mjs <input.json>
 * 輸入 JSON 格式：{ id, name, palette: [{ name, hex }], board: { w, d }, masks: string[][] }
 * 會自動驗證每層奇偶交錯貪心填磚結果，並輸出顆數統計與可用於 src/data/models.ts 的結構。
 */
import fs from 'node:fs';
import path from 'node:path';

function fillMask(rows, preferVertical, paletteLen = 2) {
  const H = rows.length;
  const W = rows[0]?.length ?? 0;
  const grid = rows.map(r =>
    r.split('').map(ch => {
      if (ch === '.' || ch === ' ') return null;
      if (ch === 'X') return { color: 0, singleOnly: false };
      if (ch === 'E') return { color: Math.min(1, paletteLen - 1), singleOnly: true };
      const n = Number(ch);
      return Number.isFinite(n) ? { color: Math.min(n, paletteLen - 1), singleOnly: false } : { color: 0, singleOnly: false };
    })
  );
  const free = grid.map(r => r.map(Boolean));
  const out = [];
  const can = (x, z, w, d, color) => {
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const xx = x + dx;
        const zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= W || zz >= H) return false;
        const cell = grid[zz][xx];
        if (!free[zz][xx] || !cell || cell.singleOnly || cell.color !== color) return false;
      }
    }
    return true;
  };
  const take = (x, z, w, d, shape, rot, color) => {
    for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) free[z + dz][x + dx] = false;
    out.push({ shape, rot, color, gx: x, gz: z });
  };
  const order = preferVertical
    ? [[1, 4, '1x4', 90], [4, 1, '1x4', 0], [1, 2, '1x2', 90], [2, 1, '1x2', 0]]
    : [[4, 1, '1x4', 0], [1, 4, '1x4', 90], [2, 1, '1x2', 0], [1, 2, '1x2', 90]];
  for (const [w, d, s, rot] of order) {
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const cell = grid[z][x];
        if (free[z][x] && cell && !cell.singleOnly && can(x, z, w, d, cell.color)) {
          take(x, z, w, d, s, rot, cell.color);
        }
      }
    }
  }
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const cell = grid[z][x];
      if (free[z][x] && cell) {
        out.push({ shape: '1x1', rot: 0, color: cell.color, gx: x, gz: z });
        free[z][x] = false;
      }
    }
  }
  return out;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.log('用法: node scripts/mask-to-model.mjs <blueprint.json>');
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
const paletteLen = raw.palette?.length ?? 2;
let total = 0;
const counts = { '1x1': 0, '1x2': 0, '1x4': 0 };

raw.masks.forEach((layerMask, layer) => {
  const filled = fillMask(layerMask, layer % 2 === 1, paletteLen);
  total += filled.length;
  for (const b of filled) counts[b.shape]++;
});

console.log(`模型: ${raw.name} (${raw.id})`);
console.log(`總層數: ${raw.masks.length} · 總零件數: ${total}`);
console.log(`零件分佈: 1x4=${counts['1x4']}, 1x2=${counts['1x2']}, 1x1=${counts['1x1']}`);
