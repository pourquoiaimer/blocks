import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ShapeKey } from '../types/brick';
import { BRICK_H, SHAPES, STUD_H, STUD_R, W, bboxOf, outlineLoop } from './brickPlanner';

export interface CachedBrickGeo {
  geo: THREE.BufferGeometry;
  w: number;
  d: number;
}

const geoCache = new Map<ShapeKey, CachedBrickGeo>();

/**
 * 幾何快取固定不旋轉（旋轉一律交由 Rapier body quaternion 處理，避免雙重旋轉歪斜）
 * 加入微倒角 (bevel) 與細微接縫內縮，讓相鄰積木拼在一起時看得到真實積木縫線與高光邊緣
 */
export function brickGeometry(shapeKey: ShapeKey): CachedBrickGeo {
  const hit = geoCache.get(shapeKey);
  if (hit) return hit;

  const cells = SHAPES[shapeKey].cells;
  const bb = bboxOf(cells);
  const cx = bb.w / 2;
  const cz = bb.d / 2;
  const parts: THREE.BufferGeometry[] = [];
  const pushGeo = (g: THREE.BufferGeometry) => {
    parts.push(g.index ? g.toNonIndexed() : g);
  };

  const SEAM = 0.014;
  const BEVEL = 0.015;
  const bodyDepth = BRICK_H - BEVEL * 2;

  const loop = outlineLoop(cells);
  if (loop) {
    const shape = new THREE.Shape();
    loop.forEach((key, i) => {
      const [x, z] = key.split(',').map(Number);
      // 依外圍接縫微內縮，讓積木與積木之間保持真實縫線
      const sx = (W(x) - W(cx)) * 0.978;
      const sy = -(W(z) - W(cz)) * 0.978;
      if (i === 0) shape.moveTo(sx, sy);
      else shape.lineTo(sx, sy);
    });
    shape.closePath();

    const body = new THREE.ExtrudeGeometry(shape, {
      depth: bodyDepth,
      bevelEnabled: true,
      bevelThickness: BEVEL,
      bevelSize: SEAM,
      bevelSegments: 1,
    });
    body.rotateX(-Math.PI / 2);
    body.translate(0, -bodyDepth / 2, 0);
    pushGeo(body);
  }

  for (const [x, z] of cells) {
    const stud = new THREE.CylinderGeometry(STUD_R * 0.96, STUD_R, STUD_H, 12, 1, false);
    stud.translate(W(x + 0.5) - W(cx), BRICK_H / 2 + STUD_H / 2, W(z + 0.5) - W(cz));
    pushGeo(stud);
  }

  const merged = mergeGeometries(parts);
  parts.forEach(p => p.dispose());
  const cached: CachedBrickGeo = { geo: merged, w: bb.w, d: bb.d };
  geoCache.set(shapeKey, cached);
  return cached;
}

export function disposeGeometryCache(): void {
  for (const entry of geoCache.values()) {
    entry.geo.dispose();
  }
  geoCache.clear();
}
