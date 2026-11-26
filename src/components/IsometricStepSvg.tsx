import React, { useMemo } from 'react';
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

export const IsometricStepSvg: React.FC<Props> = ({
  bricks,
  prevBricks = [],
  palette,
  boardW,
  boardD,
  className = '',
  showAllBright = false,
}) => {
  const rendered = useMemo(() => {
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

    // Painter's algorithm sort: layer ascending, then (gx + gz) back-to-front
    list.sort((a, b) => {
      if (a.brick.layer !== b.brick.layer) return a.brick.layer - b.brick.layer;
      const da = a.brick.gx + a.brick.bb.w * 0.5 + (a.brick.gz + a.brick.bb.d * 0.5);
      const db = b.brick.gx + b.brick.bb.w * 0.5 + (b.brick.gz + b.brick.bb.d * 0.5);
      return da - db;
    });

    // Compute bounding box across base grid + all bricks
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

    // Include board corners for consistent framing
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

    const basePts = [
      proj(0, 0, 0),
      proj(boardW, 0, 0),
      proj(boardW, 0, boardD),
      proj(0, 0, boardD),
    ]
      .map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
      .join(' ');

    return { list, proj, vbX, vbY, vbW, vbH, basePts, unit, studPxH };
  }, [bricks, prevBricks, boardW, boardD, showAllBright]);

  const { list, proj, vbX, vbY, vbW, vbH, basePts, unit, studPxH } = rendered;

  return (
    <svg
      viewBox={`${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`}
      className={`w-full h-full ${className}`}
      aria-hidden="true"
    >
      {/* 底板輪廓 */}
      <polygon
        points={basePts}
        fill="#151b22"
        stroke="rgba(159,180,204,0.22)"
        strokeWidth="0.9"
      />

      {list.map((item, idx) => {
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

        // 8 vertices of bounding prism (all bricks are 1x1, 1x2, or 1x4 rectangles)
        const tFL = proj(x0, y1, z1);
        const tFR = proj(x1, y1, z1);
        const tBR = proj(x1, y1, z0);
        const tBL = proj(x0, y1, z0);

        const bFL = proj(x0, y0, z1);
        const bFR = proj(x1, y0, z1);
        const bBR = proj(x1, y0, z0);

        const topPoly = `${tBL[0].toFixed(1)},${tBL[1].toFixed(1)} ${tBR[0].toFixed(1)},${tBR[1].toFixed(1)} ${tFR[0].toFixed(1)},${tFR[1].toFixed(1)} ${tFL[0].toFixed(1)},${tFL[1].toFixed(1)}`;
        // Front-left face (+Z): tFL -> tFR -> bFR -> bFL
        const leftPoly = `${tFL[0].toFixed(1)},${tFL[1].toFixed(1)} ${tFR[0].toFixed(1)},${tFR[1].toFixed(1)} ${bFR[0].toFixed(1)},${bFR[1].toFixed(1)} ${bFL[0].toFixed(1)},${bFL[1].toFixed(1)}`;
        // Front-right face (+X): tFR -> tBR -> bBR -> bFR
        const rightPoly = `${tFR[0].toFixed(1)},${tFR[1].toFixed(1)} ${tBR[0].toFixed(1)},${tBR[1].toFixed(1)} ${bBR[0].toFixed(1)},${bBR[1].toFixed(1)} ${bFR[0].toFixed(1)},${bFR[1].toFixed(1)}`;

        const studCells = [...item.cells].sort((c1, c2) => c1[0] + c1[1] - (c2[0] + c2[1]));

        return (
          <g key={`${b.index}_${idx}`} opacity={item.isCurrent ? 1 : 0.78}>
            <polygon points={leftPoly} fill={leftColor} stroke={strokeColor} strokeWidth={strokeW} strokeLinejoin="round" />
            <polygon points={rightPoly} fill={rightColor} stroke={strokeColor} strokeWidth={strokeW} strokeLinejoin="round" />
            <polygon points={topPoly} fill={topColor} stroke={strokeColor} strokeWidth={strokeW} strokeLinejoin="round" />
            {item.isCurrent && (
              <polygon
                points={topPoly}
                fill="none"
                stroke="rgba(127,227,255,0.45)"
                strokeWidth="0.65"
                strokeLinejoin="round"
              />
            )}
            {studCells.map(([cx, cz], sIdx) => {
              const [sx, sy] = proj(x0 + cx + 0.5, y1, z0 + cz + 0.5);
              const rx = unit * 0.28;
              const ry = unit * 0.16;
              return (
                <g key={sIdx}>
                  <rect
                    x={sx - rx}
                    y={sy - studPxH}
                    width={rx * 2}
                    height={studPxH}
                    fill={leftColor}
                    stroke={strokeColor}
                    strokeWidth="0.45"
                  />
                  <ellipse
                    cx={sx}
                    cy={sy - studPxH}
                    rx={rx}
                    ry={ry}
                    fill={topColor}
                    stroke={strokeColor}
                    strokeWidth="0.5"
                  />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
};
