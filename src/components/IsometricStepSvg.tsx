import React, { useEffect, useMemo, useRef } from 'react';
import type { ColorDef, PlanBrick } from '../types/brick';
import { SHAPES, rotCells } from '../engine/brickPlanner';

interface Props {
  bricks: PlanBrick[];
  prevBricks?: PlanBrick[];
  palette: ColorDef[];
  boardW: number;
  boardD: number;
  className?: string;
  showAllBright?: boolean;
}

function hexToCss(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

function shadeHex(hex: number, factor: number): string {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 255) * factor)));
  return `rgb(${r},${g},${b})`;
}

interface DrawableBrick {
  brick: PlanBrick;
  isCurrent: boolean;
  cells: [number, number][];
}

const CANVAS_W = 640;
const CANVAS_H = 480;

export const IsometricStepSvg: React.FC<Props> = React.memo(
  ({ bricks, prevBricks = [], palette, boardW, boardD, className = '', showAllBright = false }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const sceneData = useMemo(() => {
      const unit = 12;
      const cos30 = 0.8660254;
      const sin30 = 0.5;
      const brickPxH = unit * 1.15;
      const studPxH = unit * 0.24;

      const proj = (gx: number, gy: number, gz: number): [number, number] => [
        (gx - gz) * unit * cos30,
        (gx + gz) * unit * sin30 - gy * brickPxH,
      ];

      const list: DrawableBrick[] = [];
      for (const b of prevBricks) {
        list.push({
          brick: b,
          isCurrent: showAllBright,
          cells: rotCells(SHAPES[b.shape].cells, b.rot),
        });
      }
      for (const b of bricks) {
        list.push({
          brick: b,
          isCurrent: true,
          cells: rotCells(SHAPES[b.shape].cells, b.rot),
        });
      }

      list.sort((a, b) => {
        if (a.brick.layer !== b.brick.layer) return a.brick.layer - b.brick.layer;
        const da = a.brick.gx + a.brick.bb.w * 0.5 + (a.brick.gz + a.brick.bb.d * 0.5);
        const db = b.brick.gx + b.brick.bb.w * 0.5 + (b.brick.gz + b.brick.bb.d * 0.5);
        return da - db;
      });

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

      for (const item of list) {
        const { gx, gz, layer, bb } = item.brick;
        for (const [cx, cy, cz] of [
          [gx, layer, gz],
          [gx + bb.w, layer + 1.25, gz + bb.d],
          [gx + bb.w, layer + 1.25, gz],
          [gx, layer + 1.25, gz + bb.d],
        ]) {
          const [px, py] = proj(cx, cy, cz);
          expand(px, py);
        }
      }

      const pad = 12;
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

      return { list, proj, vbX, vbY, vbW, vbH, basePoly, unit, studPxH };
    }, [bricks, prevBricks, boardW, boardD, showAllBright]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const { list, proj, vbX, vbY, vbW, vbH, basePoly, unit, studPxH } = sceneData;
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

      const scale = Math.min(CANVAS_W / vbW, CANVAS_H / vbH);
      const offX = (CANVAS_W - vbW * scale) * 0.5 - vbX * scale;
      const offY = (CANVAS_H - vbH * scale) * 0.5 - vbY * scale;

      ctx.save();
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);
      ctx.lineJoin = 'round';

      const drawPoly = (pts: [number, number][]) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      };

      // 底板輪廓
      drawPoly(basePoly);
      ctx.fillStyle = '#151b22';
      ctx.fill();
      ctx.strokeStyle = 'rgba(159,180,204,0.22)';
      ctx.lineWidth = 0.9;
      ctx.stroke();

      const rx = unit * 0.28;
      const ry = unit * 0.16;

      for (const item of list) {
        const b = item.brick;
        const x0 = b.gx;
        const x1 = b.gx + b.bb.w;
        const z0 = b.gz;
        const z1 = b.gz + b.bb.d;
        const y0 = b.layer;
        const y1 = b.layer + 1;

        const baseHex = item.isCurrent ? (palette[b.color]?.hex ?? 0xeceff2) : 0x3b4451;
        const topColor = item.isCurrent ? hexToCss(baseHex) : '#46515f';
        const leftColor = item.isCurrent ? shadeHex(baseHex, 0.82) : '#37404c';
        const rightColor = item.isCurrent ? shadeHex(baseHex, 0.66) : '#2b333d';
        const strokeColor = item.isCurrent ? '#0c1016' : '#20262e';
        const strokeW = item.isCurrent ? 0.95 : 0.6;

        const tFL = proj(x0, y1, z1);
        const tFR = proj(x1, y1, z1);
        const tBR = proj(x1, y1, z0);
        const tBL = proj(x0, y1, z0);

        const bFL = proj(x0, y0, z1);
        const bFR = proj(x1, y0, z1);
        const bBR = proj(x1, y0, z0);

        ctx.globalAlpha = item.isCurrent ? 1 : 0.78;

        // Front-left face (+Z)
        drawPoly([tFL, tFR, bFR, bFL]);
        ctx.fillStyle = leftColor;
        ctx.fill();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeW;
        ctx.stroke();

        // Front-right face (+X)
        drawPoly([tFR, tBR, bBR, bFR]);
        ctx.fillStyle = rightColor;
        ctx.fill();
        ctx.stroke();

        // Top face
        drawPoly([tBL, tBR, tFR, tFL]);
        ctx.fillStyle = topColor;
        ctx.fill();
        ctx.stroke();

        if (item.isCurrent) {
          ctx.strokeStyle = 'rgba(127,227,255,0.45)';
          ctx.lineWidth = 0.65;
          ctx.stroke();
        }

        const studCells = [...item.cells].sort((c1, c2) => c1[0] + c1[1] - (c2[0] + c2[1]));
        for (const [cx, cz] of studCells) {
          const [sx, sy] = proj(x0 + cx + 0.5, y1, z0 + cz + 0.5);
          ctx.fillStyle = leftColor;
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

    return (
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className={`w-full h-full object-contain ${className}`}
        aria-hidden="true"
      />
    );
  }
);
