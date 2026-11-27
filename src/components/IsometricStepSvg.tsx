import React, { useEffect, useMemo, useRef } from 'react';
import type { ColorDef, PlanBrick } from '../types/brick';
import { SHAPES, rotCells, shapeStudCells } from '../engine/brickPlanner';

interface Props {
  bricks: PlanBrick[];
  prevBricks?: PlanBrick[];
  palette: ColorDef[];
  boardW: number;
  boardD: number;
  className?: string;
  showAllBright?: boolean;
  yawDeg?: number;
  pitchDeg?: number;
  interactive?: boolean;
  onRotateChange?: (yawDeg: number, pitchDeg: number) => void;
  onClickCanvas?: () => void;
}

function shadeRgb(hex: number, factor: number): string {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 255) * factor)));
  return `rgb(${r},${g},${b})`;
}

interface CellEntry {
  brick: PlanBrick;
  isCurrent: boolean;
  cx: number; // world grid X
  cz: number; // world grid Z
  dx: number; // local cell X
  dz: number; // local cell Z
  cellSet: Set<string>;
  hasStud: boolean;
  slopePart: 'none' | 'fullSlope' | 'rampOnly';
  depth: number;
}

const CANVAS_W = 640;
const CANVAS_H = 480;

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

export const IsometricStepSvg: React.FC<Props> = React.memo(
  ({
    bricks,
    prevBricks = [],
    palette,
    boardW,
    boardD,
    className = '',
    showAllBright = false,
    yawDeg = 32,
    pitchDeg = 30,
    interactive = false,
    onRotateChange,
    onClickCanvas,
  }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const dragRef = useRef<{
      active: boolean;
      pointerId: number;
      startX: number;
      startY: number;
      startYaw: number;
      startPitch: number;
      moved: boolean;
    }>({
      active: false,
      pointerId: -1,
      startX: 0,
      startY: 0,
      startYaw: yawDeg,
      startPitch: pitchDeg,
      moved: false,
    });

    const sceneData = useMemo(() => {
      const unit = 12;
      const brickH = 1.18;
      const studH = 0.24;
      const cxBoard = boardW * 0.5;
      const czBoard = boardD * 0.5;

      const yaw = (yawDeg * Math.PI) / 180;
      const pitch = (Math.max(12, Math.min(72, pitchDeg)) * Math.PI) / 180;
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);

      // 指向相機的單位向量
      const camX = sinY * cosP;
      const camY = sinP;
      const camZ = cosY * cosP;

      const proj = (gx: number, gy: number, gz: number): [number, number] => {
        const dx = gx - cxBoard;
        const dz = gz - czBoard;
        const rx = dx * cosY - dz * sinY;
        const rz = dx * sinY + dz * cosY;
        const sx = rx * unit;
        const sy = (rz * sinP - gy * brickH * cosP) * unit;
        return [sx, sy];
      };

      const rawBricks: Array<{ brick: PlanBrick; isCurrent: boolean }> = [];
      for (const b of prevBricks) {
        rawBricks.push({ brick: b, isCurrent: showAllBright });
      }
      for (const b of bricks) {
        rawBricks.push({ brick: b, isCurrent: true });
      }

      // 拆分為單格單元 (1×1 grid cell) 後做精確深度排序，徹底解決凹多邊形 L3 與斜坡遮擋問題
      const byLayer = new Map<number, CellEntry[]>();
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      const expand = (x: number, y: number) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      };

      for (const [bx, bz] of [
        [0, 0],
        [boardW, 0],
        [boardW, boardD],
        [0, boardD],
      ]) {
        const [px, py] = proj(bx, 0, bz);
        expand(px, py);
      }

      for (const { brick, isCurrent } of rawBricks) {
        const cells = rotCells(SHAPES[brick.shape].cells, brick.rot);
        const studList = shapeStudCells(brick.shape, brick.rot);
        const studSet = new Set(studList.map(([sx, sz]) => `${sx},${sz}`));
        const localCellSet = new Set(cells.map(([lx, lz]) => `${lx},${lz}`));

        let arr = byLayer.get(brick.layer);
        if (!arr) {
          arr = [];
          byLayer.set(brick.layer, arr);
        }

        for (const [dx, dz] of cells) {
          const cx = brick.gx + dx;
          const cz = brick.gz + dz;
          const hasStud = studSet.has(`${dx},${dz}`);
          let slopePart: CellEntry['slopePart'] = 'none';
          if (brick.shape === 'slope1x1') slopePart = 'fullSlope';
          else if (brick.shape === 'slope1x2' && !hasStud) slopePart = 'rampOnly';

          arr.push({
            brick,
            isCurrent,
            cx,
            cz,
            dx,
            dz,
            cellSet: localCellSet,
            hasStud,
            slopePart,
            depth: (cx + 0.5) * camX + (cz + 0.5) * camZ,
          });

          for (const [vx, vy, vz] of [
            [cx, brick.layer, cz],
            [cx + 1, brick.layer, cz],
            [cx + 1, brick.layer, cz + 1],
            [cx, brick.layer, cz + 1],
            [cx, brick.layer + 1.25, cz],
            [cx + 1, brick.layer + 1.25, cz],
            [cx + 1, brick.layer + 1.25, cz + 1],
            [cx, brick.layer + 1.25, cz + 1],
          ]) {
            const [px, py] = proj(vx, vy, vz);
            expand(px, py);
          }
        }
      }

      const layers = [...byLayer.keys()].sort((a, b) => a - b);
      const list: CellEntry[] = [];
      for (const L of layers) {
        const layerCells = byLayer.get(L)!;
        layerCells.sort((a, b) => a.depth - b.depth);
        list.push(...layerCells);
      }

      const pad = 14;
      const vbX = (Number.isFinite(minX) ? minX : -60) - pad;
      const vbY = (Number.isFinite(minY) ? minY : -60) - pad;
      const vbW = Math.max(80, (Number.isFinite(maxX) ? maxX - minX : 120) + pad * 2);
      const vbH = Math.max(60, (Number.isFinite(maxY) ? maxY - minY : 100) + pad * 2);

      const basePoly = [
        proj(0, 0, 0),
        proj(boardW, 0, 0),
        proj(boardW, 0, boardD),
        proj(0, 0, boardD),
      ];

      // 正面 (+Z) 方向標記三角箭頭
      const frontMid = proj(boardW * 0.5, 0, boardD + 0.55);
      const frontLeft = proj(boardW * 0.5 - 0.65, 0, boardD + 0.12);
      const frontRight = proj(boardW * 0.5 + 0.65, 0, boardD + 0.12);

      // 相機空間固定側光，確保轉到任何方向都有明確立體明暗
      const shadeForNormal = (nx: number, ny: number, nz: number, finish?: string): number => {
        const rnx = nx * cosY - nz * sinY;
        const rnz = nx * sinY + nz * cosY;
        const dot = rnx * 0.36 + ny * 0.78 + rnz * 0.42;
        const base = finish === 'metallic' ? 0.68 + dot * 0.44 : 0.72 + dot * 0.34;
        return Math.max(0.54, Math.min(finish === 'metallic' ? 1.15 : 1.05, base));
      };

      return {
        list,
        proj,
        vbX,
        vbY,
        vbW,
        vbH,
        basePoly,
        frontTri: [frontLeft, frontRight, frontMid] as [number, number][],
        unit,
        studH,
        camX,
        camY,
        camZ,
        sinP,
        cosP,
        shadeForNormal,
      };
    }, [bricks, prevBricks, boardW, boardD, showAllBright, yawDeg, pitchDeg]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const {
        list,
        proj,
        vbX,
        vbY,
        vbW,
        vbH,
        basePoly,
        frontTri,
        unit,
        studH,
        camX,
        camY,
        camZ,
        sinP,
        cosP,
        shadeForNormal,
      } = sceneData;
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

      const scale = Math.min(CANVAS_W / vbW, CANVAS_H / vbH);
      const offX = (CANVAS_W - vbW * scale) * 0.5 - vbX * scale;
      const offY = (CANVAS_H - vbH * scale) * 0.5 - vbY * scale;

      ctx.save();
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      const drawPoly = (pts: [number, number][]) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      };

      const drawLine = (a: [number, number], b: [number, number]) => {
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      };

      // 底板輪廓
      drawPoly(basePoly);
      ctx.fillStyle = '#151b22';
      ctx.fill();
      ctx.strokeStyle = 'rgba(159,180,204,0.28)';
      ctx.lineWidth = 0.9;
      ctx.stroke();

      // 正面指示標記
      drawPoly(frontTri);
      ctx.fillStyle = 'rgba(127,227,255,0.68)';
      ctx.fill();

      const rx = unit * 0.28;
      const ry = Math.max(1.2, rx * sinP);
      const studPxH = unit * studH * cosP;

      for (const item of list) {
        const { brick: b, cx, cz, dx, dz, cellSet, hasStud, slopePart } = item;
        const x0 = cx;
        const x1 = cx + 1;
        const z0 = cz;
        const z1 = cz + 1;
        const y0 = b.layer;
        const y1 = b.layer + 1;

        const colDef = palette[b.color];
        const isTrans = Boolean(colDef?.transparent);
        const finish = colDef?.finish;
        const baseHex = item.isCurrent ? (colDef?.hex ?? 0xeceff2) : 0x45505e;
        const strokeColor = isTrans
          ? 'rgba(180,232,255,0.85)'
          : item.isCurrent
            ? '#0c1016'
            : '#20262e';
        const strokeW = item.isCurrent ? 0.88 : 0.55;
        const highlightStroke = isTrans
          ? 'rgba(220,245,255,0.88)'
          : finish === 'metallic'
            ? 'rgba(255,244,196,0.62)'
            : 'rgba(127,227,255,0.42)';

        const topShade = shadeForNormal(0, 1, 0, finish);
        const topColor = shadeRgb(baseHex, topShade);

        ctx.globalAlpha = isTrans ? (item.isCurrent ? 0.5 : 0.24) : item.isCurrent ? 1 : 0.78;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeW;

        if (slopePart !== 'none') {
          // 繪製凸斜坡積木（1×1 全斜坡 或 1×2 前段斜坡）
          const toeY = y0 + 0.22;
          const flatTopEnd = slopePart === 'fullSlope' ? 0.22 : 0.04;
          const rot = b.rot;

          const pW = (u: number, y: number, v: number): [number, number] => {
            const [ru, rv] = rotLocalPt(u, v, rot);
            return proj(x0 + ru, y, z0 + rv);
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

          const faces: Array<{
            pts: [number, number][];
            normal: [number, number, number];
            hide?: boolean;
          }> = [
            // 後高面 (u = 0): 若屬於 slope1x2 前段斜坡則隱藏接縫內面
            {
              pts: [t01, t00, b00, b01],
              normal: [rotLocalDir(-1, 0, rot)[0], 0, rotLocalDir(-1, 0, rot)[1]],
              hide: slopePart === 'rampOnly',
            },
            // 前低唇面 (u = 1)
            {
              pts: [r10, r11, b11, b10],
              normal: [rotLocalDir(1, 0, rot)[0], 0, rotLocalDir(1, 0, rot)[1]],
            },
            // 左側面 (v = 0)
            {
              pts: [b00, t00, tE0, r10, b10],
              normal: [rotLocalDir(0, -1, rot)[0], 0, rotLocalDir(0, -1, rot)[1]],
            },
            // 右側面 (v = 1)
            {
              pts: [b11, r11, tE1, t01, b01],
              normal: [rotLocalDir(0, 1, rot)[0], 0, rotLocalDir(0, 1, rot)[1]],
            },
            // 頂小平臺
            {
              pts: [t00, tE0, tE1, t01],
              normal: [0, 1, 0],
            },
            // 主斜坡面
            {
              pts: [tE0, r10, r11, tE1],
              normal: [rnX, rnY, rnZ],
            },
          ];

          for (const f of faces) {
            if (f.hide) continue;
            const dotCam = f.normal[0] * camX + f.normal[1] * camY + f.normal[2] * camZ;
            if (dotCam <= 0.001) continue;
            drawPoly(f.pts);
            ctx.fillStyle = shadeRgb(baseHex, shadeForNormal(f.normal[0], f.normal[1], f.normal[2], finish));
            ctx.fill();
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = strokeW;
            ctx.stroke();
          }

          if (item.isCurrent) {
            ctx.strokeStyle = highlightStroke;
            ctx.lineWidth = 0.6;
            drawLine(tE0, tE1);
            drawLine(r10, r11);
          }
          continue;
        }

        // 一般方格（支援 1×1, 1×2, 1×3, 1×4, 2×2, L3 以及 slope1×2 的後高格）
        const hasN = cellSet.has(`${dx},${dz - 1}`);
        const hasS = cellSet.has(`${dx},${dz + 1}`);
        const hasW = cellSet.has(`${dx - 1},${dz}`);
        const hasE = cellSet.has(`${dx + 1},${dz}`);

        const t00 = proj(x0, y1, z0);
        const t10 = proj(x1, y1, z0);
        const t11 = proj(x1, y1, z1);
        const t01 = proj(x0, y1, z1);

        const b00 = proj(x0, y0, z0);
        const b10 = proj(x1, y0, z0);
        const b11 = proj(x1, y0, z1);
        const b01 = proj(x0, y0, z1);

        // 僅在沒有同積木相鄰格的方向繪製側面（完美支援 L3 凹型！）
        if (camZ > 0.001 && !hasS) {
          drawPoly([t01, t11, b11, b01]);
          ctx.fillStyle = shadeRgb(baseHex, shadeForNormal(0, 0, 1, finish));
          ctx.fill();
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = strokeW;
          ctx.stroke();
        } else if (camZ < -0.001 && !hasN) {
          drawPoly([t10, t00, b00, b10]);
          ctx.fillStyle = shadeRgb(baseHex, shadeForNormal(0, 0, -1, finish));
          ctx.fill();
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = strokeW;
          ctx.stroke();
        }

        if (camX > 0.001 && !hasE) {
          drawPoly([t11, t10, b10, b11]);
          ctx.fillStyle = shadeRgb(baseHex, shadeForNormal(1, 0, 0, finish));
          ctx.fill();
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = strokeW;
          ctx.stroke();
        } else if (camX < -0.001 && !hasW) {
          drawPoly([t00, t01, b01, b00]);
          ctx.fillStyle = shadeRgb(baseHex, shadeForNormal(-1, 0, 0, finish));
          ctx.fill();
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = strokeW;
          ctx.stroke();
        }

        // 頂面填色（同積木內接邊不描黑線）
        drawPoly([t00, t10, t11, t01]);
        ctx.fillStyle = topColor;
        ctx.fill();

        // 僅描繪外圍輪廓線
        ctx.strokeStyle = item.isCurrent ? highlightStroke : strokeColor;
        ctx.lineWidth = item.isCurrent ? 0.78 : strokeW;
        if (!hasN) drawLine(t00, t10);
        if (!hasE) drawLine(t10, t11);
        if (!hasS) drawLine(t11, t01);
        if (!hasW) drawLine(t01, t00);

        // 凸粒
        if (hasStud) {
          const [sx, sy] = proj(cx + 0.5, y1, cz + 0.5);
          ctx.fillStyle = shadeRgb(baseHex, 0.78);
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 0.45;
          ctx.fillRect(sx - rx, sy - studPxH, rx * 2, studPxH);
          ctx.strokeRect(sx - rx, sy - studPxH, rx * 2, studPxH);

          ctx.beginPath();
          ctx.ellipse(sx, sy - studPxH, rx, ry, 0, 0, Math.PI * 2);
          ctx.fillStyle = topColor;
          ctx.fill();
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }

      ctx.restore();
    }, [sceneData, palette]);

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      e.stopPropagation();
      dragRef.current = {
        active: true,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startYaw: yawDeg,
        startPitch: pitchDeg,
        moved: false,
      };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive || !dragRef.current.active || dragRef.current.pointerId !== e.pointerId) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.hypot(dx, dy) > 4) {
        dragRef.current.moved = true;
      }
      if (!dragRef.current.moved) return;
      const nextYaw = ((dragRef.current.startYaw - dx * 0.65) % 360 + 360) % 360;
      const nextPitch = Math.max(14, Math.min(68, dragRef.current.startPitch + dy * 0.35));
      onRotateChange?.(Math.round(nextYaw), Math.round(nextPitch));
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive || !dragRef.current.active || dragRef.current.pointerId !== e.pointerId) return;
      const wasMoved = dragRef.current.moved;
      dragRef.current.active = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      if (!wasMoved) {
        onClickCanvas?.();
      }
    };

    return (
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={`w-full h-full object-contain select-none ${interactive ? 'cursor-grab active:cursor-grabbing touch-none' : ''} ${className}`}
        aria-label={interactive ? '可拖曳旋轉的 3D 步驟示意圖' : undefined}
        aria-hidden={!interactive}
      />
    );
  }
);
