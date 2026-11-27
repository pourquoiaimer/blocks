import * as THREE from 'three';
import type { BrickModel, PlanBrick } from '../types/brick';
import { rotCells, shapeStudCells, SHAPES } from './brickPlanner';

function shadeHex(hex: number, factor: number): string {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 255) * factor)));
  return `rgb(${r},${g},${b})`;
}

function rotLocalPt(u: number, v: number, rot: number): [number, number] {
  const r = ((rot % 360) + 360) % 360;
  if (r === 0) return [u, v];
  if (r === 90) return [1 - v, u];
  if (r === 180) return [1 - u, 1 - v];
  return [v, 1 - u];
}

function rotLocalDir(du: number, dv: number, rot: number): [number, number] {
  const r = ((rot % 360) + 360) % 360;
  if (r === 0) return [du, dv];
  if (r === 90) return [-dv, du];
  if (r === 180) return [-du, -dv];
  return [dv, -du];
}

function drawModelPreviewOnCanvas(
  ctx: CanvasRenderingContext2D,
  model: BrickModel,
  plan: PlanBrick[],
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number
): void {
  if (plan.length === 0) return;

  const isoX = (x: number, z: number) => (x - z) * 0.866;
  const isoY = (x: number, y: number, z: number) => (x + z) * 0.5 - y * 1.15;

  const boardW = model.board.w;
  const boardD = model.board.d;

  // 計算整體包圍盒以自動縮放並置中
  let minPx = Infinity;
  let maxPx = -Infinity;
  let minPy = Infinity;
  let maxPy = -Infinity;

  const samplePts: [number, number, number][] = [
    [0, 0, 0],
    [boardW, 0, 0],
    [0, 0, boardD],
    [boardW, 0, boardD],
  ];
  for (const b of plan) {
    const cells = rotCells(SHAPES[b.shape].cells, b.rot);
    for (const [dx, dz] of cells) {
      const gx = b.gx + dx;
      const gz = b.gz + dz;
      samplePts.push([gx, b.layer + 1.2, gz], [gx + 1, b.layer + 1.2, gz + 1]);
    }
  }
  for (const [x, y, z] of samplePts) {
    const px = isoX(x, z);
    const py = isoY(x, y, z);
    minPx = Math.min(minPx, px);
    maxPx = Math.max(maxPx, px);
    minPy = Math.min(minPy, py);
    maxPy = Math.max(maxPy, py);
  }

  const spanX = Math.max(1, maxPx - minPx);
  const spanY = Math.max(1, maxPy - minPy);
  const scale = Math.min((boxW * 0.88) / spanX, (boxH * 0.86) / spanY);
  const offX = boxX + boxW * 0.5 - ((minPx + maxPx) * 0.5) * scale;
  const offY = boxY + boxH * 0.54 - ((minPy + maxPy) * 0.5) * scale;

  const project = (x: number, y: number, z: number): [number, number] => [
    offX + isoX(x, z) * scale,
    offY + isoY(x, y, z) * scale,
  ];

  // 先畫半透明底板陰影與組裝墊
  const p00 = project(0, 0, 0);
  const p10 = project(boardW, 0, 0);
  const p11 = project(boardW, 0, boardD);
  const p01 = project(0, 0, boardD);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p00[0], p00[1] + 8);
  ctx.lineTo(p10[0], p10[1] + 8);
  ctx.lineTo(p11[0], p11[1] + 8);
  ctx.lineTo(p01[0], p01[1] + 8);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(p00[0], p00[1]);
  ctx.lineTo(p10[0], p10[1]);
  ctx.lineTo(p11[0], p11[1]);
  ctx.lineTo(p01[0], p01[1]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(28, 36, 48, 0.9)';
  ctx.strokeStyle = 'rgba(165, 200, 235, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  interface BoxCellItem {
    brick: PlanBrick;
    cx: number;
    cz: number;
    dx: number;
    dz: number;
    cellSet: Set<string>;
    hasStud: boolean;
    slopePart: 'none' | 'fullSlope' | 'rampOnly';
  }

  const cellItems: BoxCellItem[] = [];
  for (const brick of plan) {
    const cells = rotCells(SHAPES[brick.shape].cells, brick.rot);
    const studList = shapeStudCells(brick.shape, brick.rot);
    const studSet = new Set(studList.map(([sx, sz]) => `${sx},${sz}`));
    const cellSet = new Set(cells.map(([lx, lz]) => `${lx},${lz}`));
    for (const [dx, dz] of cells) {
      const hasStud = studSet.has(`${dx},${dz}`);
      let slopePart: BoxCellItem['slopePart'] = 'none';
      if (brick.shape === 'slope1x1') slopePart = 'fullSlope';
      else if (brick.shape === 'slope1x2' && !hasStud) slopePart = 'rampOnly';
      cellItems.push({
        brick,
        cx: brick.gx + dx,
        cz: brick.gz + dz,
        dx,
        dz,
        cellSet,
        hasStud,
        slopePart,
      });
    }
  }

  // 由下往上、由後往前（cam ~ +X, +Y, +Z）
  cellItems.sort((a, b) => {
    if (a.brick.layer !== b.brick.layer) return a.brick.layer - b.brick.layer;
    return a.cx + a.cz - (b.cx + b.cz);
  });

  const drawPoly = (pts: [number, number][]) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };

  for (const item of cellItems) {
    const { brick, cx, cz, dx, dz, cellSet, hasStud, slopePart } = item;
    const colDef = model.palette[brick.color];
    const hex = colDef?.hex ?? 0xd94b3b;
    const alpha = colDef?.transparent ? 0.55 : 1.0;
    const x0 = cx;
    const z0 = cz;
    const x1 = cx + 1;
    const z1 = cz + 1;
    const y0 = brick.layer;
    const y1 = brick.layer + 1;

    ctx.globalAlpha = alpha;

    if (slopePart !== 'none') {
      const toeY = y0 + 0.22;
      const flatTopEnd = slopePart === 'fullSlope' ? 0.22 : 0.04;
      const rot = brick.rot;
      const pW = (u: number, y: number, v: number): [number, number] => {
        const [ru, rv] = rotLocalPt(u, v, rot);
        return project(x0 + ru, y, z0 + rv);
      };
      const b00 = pW(0, y0, 0);
      const b10 = pW(1, y0, 0);
      const b11 = pW(1, y0, 1);
      const b01 = pW(0, y0, 1);
      const t00 = pW(0, y1, 0);
      const t01 = pW(0, y1, 1);
      const tE0 = pW(flatTopEnd, y1, 0);
      const tE1 = pW(flatTopEnd, y1, 1);
      const r10 = pW(1, toeY, 0);
      const r11 = pW(1, toeY, 1);

      const rampDx = 1 - flatTopEnd;
      const rampDy = 1 - 0.22;
      const rampLen = Math.hypot(rampDx, rampDy);
      const [rnX, rnZ] = rotLocalDir(rampDy / rampLen, 0, rot);
      const rnY = rampDx / rampLen;

      const camVec = [0.577, 0.577, 0.577];
      const faces: Array<{ pts: [number, number][]; normal: [number, number, number]; shade: number; hide?: boolean }> = [
        {
          pts: [t01, t00, b00, b01],
          normal: [rotLocalDir(-1, 0, rot)[0], 0, rotLocalDir(-1, 0, rot)[1]],
          shade: 0.78,
          hide: slopePart === 'rampOnly',
        },
        {
          pts: [r10, r11, b11, b10],
          normal: [rotLocalDir(1, 0, rot)[0], 0, rotLocalDir(1, 0, rot)[1]],
          shade: 0.82,
        },
        {
          pts: [b00, t00, tE0, r10, b10],
          normal: [rotLocalDir(0, -1, rot)[0], 0, rotLocalDir(0, -1, rot)[1]],
          shade: 0.72,
        },
        {
          pts: [b11, r11, tE1, t01, b01],
          normal: [rotLocalDir(0, 1, rot)[0], 0, rotLocalDir(0, 1, rot)[1]],
          shade: 0.86,
        },
        { pts: [t00, tE0, tE1, t01], normal: [0, 1, 0], shade: 1.06 },
        { pts: [tE0, r10, r11, tE1], normal: [rnX, rnY, rnZ], shade: 0.96 },
      ];

      for (const f of faces) {
        if (f.hide) continue;
        if (f.normal[0] * camVec[0] + f.normal[1] * camVec[1] + f.normal[2] * camVec[2] <= 0.001) continue;
        drawPoly(f.pts);
        ctx.fillStyle = shadeHex(hex, f.shade);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.24)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      continue;
    }

    const hasE = cellSet.has(`${dx + 1},${dz}`);
    const hasS = cellSet.has(`${dx},${dz + 1}`);
    const hasW = cellSet.has(`${dx - 1},${dz}`);
    const hasN = cellSet.has(`${dx},${dz - 1}`);

    const t00 = project(x0, y1, z0);
    const t10 = project(x1, y1, z0);
    const t11 = project(x1, y1, z1);
    const t01 = project(x0, y1, z1);
    const b10 = project(x1, y0, z0);
    const b11 = project(x1, y0, z1);
    const b01 = project(x0, y0, z1);

    // 右側面 (+X)
    if (!hasE) {
      drawPoly([t10, t11, b11, b10]);
      ctx.fillStyle = shadeHex(hex, 0.72);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // 左側面 (+Z)
    if (!hasS) {
      drawPoly([t01, t11, b11, b01]);
      ctx.fillStyle = shadeHex(hex, 0.86);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // 頂面 (+Y)
    drawPoly([t00, t10, t11, t01]);
    ctx.fillStyle = shadeHex(hex, 1.06);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 0.75;
    if (!hasN) {
      ctx.beginPath();
      ctx.moveTo(t00[0], t00[1]);
      ctx.lineTo(t10[0], t10[1]);
      ctx.stroke();
    }
    if (!hasE) {
      ctx.beginPath();
      ctx.moveTo(t10[0], t10[1]);
      ctx.lineTo(t11[0], t11[1]);
      ctx.stroke();
    }
    if (!hasS) {
      ctx.beginPath();
      ctx.moveTo(t11[0], t11[1]);
      ctx.lineTo(t01[0], t01[1]);
      ctx.stroke();
    }
    if (!hasW) {
      ctx.beginPath();
      ctx.moveTo(t01[0], t01[1]);
      ctx.lineTo(t00[0], t00[1]);
      ctx.stroke();
    }

    // 頂部積木圓點 (Studs)
    if (hasStud) {
      const [sx, sy] = project(cx + 0.5, y1 + 0.16, cz + 0.5);
      const rX = Math.max(1.8, scale * 0.23);
      const rY = Math.max(1.1, scale * 0.14);
      ctx.beginPath();
      ctx.ellipse(sx, sy + rY * 0.4, rX, rY, 0, 0, Math.PI * 2);
      ctx.fillStyle = shadeHex(hex, 0.8);
      ctx.fill();

      ctx.beginPath();
      ctx.ellipse(sx, sy, rX, rY, 0, 0, Math.PI * 2);
      ctx.fillStyle = shadeHex(hex, 1.15);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * 動態產生像樂高商品盒一樣的盒蓋／盒面彩繪貼圖（印有模型名稱、片數與該組模型的等角立體圖）
 */
export function createProductBoxTexture(
  model: BrickModel,
  plan: PlanBrick[],
  maxAnisotropy = 4
): THREE.CanvasTexture {
  const w = 1024;
  const h = 768;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const accent = model.palette[0]?.hex ?? 0x4b93d6;
  const accentCss = shadeHex(accent, 0.95);
  const darkAccent = shadeHex(accent, 0.35);

  // 商品盒亮面背景漸層
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#13253a');
  bg.addColorStop(0.55, darkAccent);
  bg.addColorStop(1, '#0d141d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 柔和舞台聚光圓暈
  const radial = ctx.createRadialGradient(w * 0.56, h * 0.5, 40, w * 0.56, h * 0.5, 390);
  radial.addColorStop(0, 'rgba(255, 255, 255, 0.24)');
  radial.addColorStop(0.55, 'rgba(127, 227, 255, 0.08)');
  radial.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, w, h);

  // 細緻積木顆粒暗紋背景裝飾
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let gx = 40; gx < w; gx += 76) {
    for (let gy = 40; gy < h; gy += 76) {
      ctx.beginPath();
      ctx.arc(gx, gy, 16, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 外框金邊 / 紙盒摺線飾條
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 10;
  ctx.strokeRect(18, 18, w - 36, h - 36);

  // 繪製主角積木模型立體彩圖
  drawModelPreviewOnCanvas(ctx, model, plan, 250, 95, 710, 560);

  // 左上角經典玩具盒紅標方章
  ctx.save();
  ctx.fillStyle = '#d62b2b';
  ctx.fillRect(42, 42, 134, 134);
  ctx.strokeStyle = '#ffeb7a';
  ctx.lineWidth = 6;
  ctx.strokeRect(48, 48, 122, 122);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px "Noto Sans TC", "PingFang TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('積木工坊', 109, 102);
  ctx.fillStyle = '#ffe569';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('WORKSHOP', 109, 136);
  ctx.restore();

  // 左側產品標題與規格資訊
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 54px "Noto Sans TC", "PingFang TC", sans-serif';
  ctx.fillText(model.name, 46, 254, 340);

  ctx.fillStyle = '#b9d6f2';
  ctx.font = '500 22px "Noto Sans TC", "PingFang TC", sans-serif';
  const subtitle = model.subtitle.length > 18 ? `${model.subtitle.slice(0, 18)}…` : model.subtitle;
  ctx.fillText(subtitle, 46, 294, 340);

  // 難度與層數標籤條
  ctx.fillStyle = accentCss;
  ctx.fillRect(46, 332, 8, 118);

  ctx.fillStyle = '#ffe278';
  ctx.font = 'bold 46px sans-serif';
  ctx.fillText(`${plan.length}`, 70, 380);
  ctx.fillStyle = '#dce8f5';
  ctx.font = '600 20px "Noto Sans TC", "PingFang TC", sans-serif';
  ctx.fillText('PCS 顆積木零件', 70, 408);
  ctx.fillStyle = '#9bc4ea';
  ctx.fillText(`難度：${model.difficulty} · ${model.masks.length} 層結構`, 70, 442);
  ctx.restore();

  // 底部玩具盒彩條＋條碼裝飾
  ctx.fillStyle = '#f4c430';
  ctx.fillRect(18, h - 74, w - 36, 56);

  ctx.fillStyle = '#181410';
  ctx.font = 'bold 24px "Noto Sans TC", "PingFang TC", sans-serif';
  ctx.fillText(`SET · ${model.id.toUpperCase().slice(0, 14)}   |   3+ 小盤 & 深籃套組`, 46, h - 38);

  // 右下角擬真條碼小圖
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w - 172, h - 66, 132, 40);
  ctx.fillStyle = '#111111';
  for (let b = 0; b < 18; b++) {
    const bw = b % 3 === 0 ? 4 : 2;
    ctx.fillRect(w - 162 + b * 6.5, h - 61, bw, 30);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}
