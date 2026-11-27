import * as THREE from 'three';
import type { RoomTimeOfDay } from '../types/brick';

export interface RoomDioramaController {
  root: THREE.Group;
  setCurtainOpen(open: boolean): void;
  setTimeOfDay(tod: RoomTimeOfDay): void;
  triggerTidyAnimation(tod: RoomTimeOfDay): void;
  update(dt: number, curtainOpen: boolean, tod: RoomTimeOfDay): void;
  dispose(): void;
}

function makeSkyGradientTexture(topHex: string, midHex: string, horizonHex: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, topHex);
  grad.addColorStop(0.55, midHex);
  grad.addColorStop(1, horizonHex);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createRoomDiorama(options: {
  windowCenterX: number;
  wallZ: number;
  deskMinX: number;
  deskMaxX: number;
  isSoftwareGl: boolean;
  onLightingMix?: (mix: {
    skyHex: number;
    hemiSkyHex: number;
    hemiGroundHex: number;
    hemiIntensity: number;
    keyHex: number;
    keyIntensity: number;
    rimHex: number;
    rimIntensity: number;
    exposure: number;
  }) => void;
}): RoomDioramaController {
  const root = new THREE.Group();
  const { windowCenterX, wallZ, deskMinX, deskMaxX, isSoftwareGl, onLightingMix } = options;

  const disposables: Array<{ dispose(): void }> = [];
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    disposables.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    disposables.push(m);
    return m;
  };
  const trackTex = <T extends THREE.Texture>(t: T): T => {
    disposables.push(t);
    return t;
  };

  const wallWidth = Math.max(88, deskMaxX - deskMinX + 28);
  const wallCx = (deskMinX + deskMaxX) * 0.5;
  const winCx = windowCenterX;
  const winY0 = 1.6;
  const winH = 9.4;
  const winW = 16.4;
  const winHalfW = winW * 0.5;
  const wallBottom = -2.2;
  const wallTop = 21.5;

  // 室內牆面材質（溫潤霧面石膏＋木質護牆板）
  const wallMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x3b332b, roughness: 0.92, metalness: 0.02 })
  );
  const wainscotMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x2c2119, roughness: 0.85, metalness: 0.04 })
  );
  const woodFrameMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x6f4d32, roughness: 0.66, metalness: 0.05 })
  );
  const darkWoodMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x523823, roughness: 0.74, metalness: 0.04 })
  );
  const brassMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xd4a94f, roughness: 0.3, metalness: 0.85 })
  );

  const addWallSegment = (x: number, y: number, w: number, h: number, d = 0.7, mat = wallMat) => {
    if (w <= 0.05 || h <= 0.05) return;
    const m = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(x, y, wallZ);
    m.receiveShadow = !isSoftwareGl;
    root.add(m);
  };

  const wallLeftEdge = wallCx - wallWidth * 0.5;
  const wallRightEdge = wallCx + wallWidth * 0.5;
  const leftSpan = winCx - winHalfW - wallLeftEdge;
  const rightSpan = wallRightEdge - (winCx + winHalfW);

  // 上、下、左、右實牆（中央開窗洞）
  addWallSegment(wallLeftEdge + leftSpan * 0.5, (wallBottom + wallTop) * 0.5, leftSpan, wallTop - wallBottom);
  addWallSegment(winCx + winHalfW + rightSpan * 0.5, (wallBottom + wallTop) * 0.5, rightSpan, wallTop - wallBottom);
  addWallSegment(winCx, (wallBottom + winY0) * 0.5, winW, winY0 - wallBottom);
  addWallSegment(winCx, (winY0 + winH + wallTop) * 0.5, winW, wallTop - (winY0 + winH));

  // 木質踢腳護牆線（貼合書桌後方）
  const trim = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(wallWidth, 1.35, 0.82)),
    wainscotMat
  );
  trim.position.set(wallCx, 0.45, wallZ + 0.06);
  root.add(trim);

  // 窗框與實木深窗台
  const frameT = 0.42;
  const frameDepth = 0.96;
  const sill = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(winW + 1.5, 0.34, 1.55)),
    woodFrameMat
  );
  sill.position.set(winCx, winY0 - 0.14, wallZ + 0.28);
  root.add(sill);

  const topFrame = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(winW + frameT * 2, frameT, frameDepth)),
    woodFrameMat
  );
  topFrame.position.set(winCx, winY0 + winH + frameT * 0.5 - 0.05, wallZ);
  root.add(topFrame);

  for (const side of [-1, 1] as const) {
    const post = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(frameT, winH + frameT, frameDepth)),
      woodFrameMat
    );
    post.position.set(winCx + side * (winHalfW + frameT * 0.5), winY0 + winH * 0.5, wallZ);
    root.add(post);
  }

  // 窗格十字細木條
  const mullionV = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.16, winH, 0.28)),
    woodFrameMat
  );
  mullionV.position.set(winCx, winY0 + winH * 0.5, wallZ);
  root.add(mullionV);

  const mullionH = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(winW, 0.14, 0.28)),
    woodFrameMat
  );
  mullionH.position.set(winCx, winY0 + winH * 0.46, wallZ);
  root.add(mullionH);

  // 窗台上的小多肉盆栽（為室內書桌增添生活感）
  const sillPlant = new THREE.Group();
  const potMesh = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.32, 0.24, 0.42, 12)),
    trackMat(new THREE.MeshStandardMaterial({ color: 0xb55d3d, roughness: 0.72 }))
  );
  potMesh.position.y = 0.21;
  sillPlant.add(potMesh);
  const soilMesh = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.28, 0.28, 0.06, 12)),
    darkWoodMat
  );
  soilMesh.position.y = 0.41;
  sillPlant.add(soilMesh);
  const sillLeafMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x4d9b52, roughness: 0.65 }));
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    const leaf = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.16, 8, 6)), sillLeafMat);
    leaf.scale.set(0.8, 1.5, 0.65);
    leaf.position.set(Math.cos(ang) * 0.14, 0.52 + (i % 2) * 0.06, Math.sin(ang) * 0.14);
    leaf.rotation.z = -Math.cos(ang) * 0.35;
    leaf.rotation.x = Math.sin(ang) * 0.35;
    sillPlant.add(leaf);
  }
  sillPlant.position.set(winCx - winHalfW + 1.15, winY0 + 0.03, wallZ + 0.5);
  root.add(sillPlant);

  // 微反光玻璃
  const glassMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xdff4ff,
      roughness: 0.12,
      metalness: 0.08,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
    })
  );
  const glassPane = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(winW, winH)),
    glassMat
  );
  glassPane.position.set(winCx, winY0 + winH * 0.5, wallZ + 0.02);
  root.add(glassPane);

  // 窗簾桿與兩側布簾
  const rodW = winW + 4.4;
  const rodY = winY0 + winH + 0.85;
  const rodZ = wallZ + 0.72;
  const rod = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.1, 0.1, rodW, 12)),
    brassMat
  );
  rod.rotation.z = Math.PI * 0.5;
  rod.position.set(winCx, rodY, rodZ);
  root.add(rod);

  for (const side of [-1, 1] as const) {
    const finial = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.22, 12, 10)), brassMat);
    finial.position.set(winCx + side * (rodW * 0.5 + 0.14), rodY, rodZ);
    root.add(finial);
  }

  const curtainMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xb98d64, roughness: 0.88, metalness: 0.02 })
  );
  const curtainPleatMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xa1764f, roughness: 0.9, metalness: 0.02 })
  );
  const buildCurtainPanel = () => {
    const g = new THREE.Group();
    const base = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(winW * 0.52, winH + 1.15, 0.22)),
      curtainMat
    );
    g.add(base);
    for (let i = -2; i <= 2; i++) {
      const pleat = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.16, 0.18, winH + 1.12, 8)),
        curtainPleatMat
      );
      pleat.position.set(i * 1.45, 0, 0.08);
      g.add(pleat);
    }
    return g;
  };
  const leftCurtain = buildCurtainPanel();
  const rightCurtain = buildCurtainPanel();
  leftCurtain.position.set(winCx - winHalfW - 0.6, winY0 + winH * 0.5 + 0.1, rodZ);
  rightCurtain.position.set(winCx + winHalfW + 0.6, winY0 + winH * 0.5 + 0.1, rodZ);
  root.add(leftCurtain);
  root.add(rightCurtain);

  // ═══════ 窗外細緻田園風景層（純視覺，零物理剛體）═══════
  const outdoor = new THREE.Group();
  root.add(outdoor);

  const daySkyTex = trackTex(makeSkyGradientTexture('#4e98e6', '#8ec7f8', '#dff2ff'));
  const nightSkyTex = trackTex(makeSkyGradientTexture('#0b132b', '#17254a', '#283d6b'));
  const daySkyMat = trackMat(new THREE.MeshBasicMaterial({ map: daySkyTex }));
  const nightSkyMat = trackMat(new THREE.MeshBasicMaterial({ map: nightSkyTex }));
  const skyBackdropDay = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(86, 40)), daySkyMat);
  skyBackdropDay.position.set(winCx, 10.5, wallZ - 28);
  outdoor.add(skyBackdropDay);

  const skyBackdropNight = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(86, 40)), nightSkyMat);
  skyBackdropNight.position.set(winCx, 10.5, wallZ - 27.95);
  skyBackdropNight.visible = false;
  outdoor.add(skyBackdropNight);

  // 日間太陽、日暈 & 多層立體雲朵
  const dayGroup = new THREE.Group();
  outdoor.add(dayGroup);

  const sunDisc = new THREE.Mesh(
    trackGeo(new THREE.SphereGeometry(1.5, 20, 14)),
    trackMat(new THREE.MeshBasicMaterial({ color: 0xffe484 }))
  );
  sunDisc.position.set(winCx + 7.4, 13.0, wallZ - 25.0);
  dayGroup.add(sunDisc);

  const sunHalo = new THREE.Mesh(
    trackGeo(new THREE.RingGeometry(1.6, 2.5, 28)),
    trackMat(new THREE.MeshBasicMaterial({ color: 0xfff0aa, transparent: true, opacity: 0.32, side: THREE.DoubleSide }))
  );
  sunHalo.position.copy(sunDisc.position);
  dayGroup.add(sunHalo);

  const cloudMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, emissive: 0x262b36 })
  );
  const clouds: THREE.Group[] = [];
  for (let c = 0; c < 4; c++) {
    const cg = new THREE.Group();
    const parts: [number, number, number, number][] = [
      [0, 0, 0, 1.15],
      [-0.95, -0.18, 0.1, 0.85],
      [1.0, -0.14, -0.05, 0.9],
      [0.35, 0.35, 0.08, 0.78],
    ];
    for (const [px, py, pz, r] of parts) {
      const puff = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(r, 12, 10)), cloudMat);
      puff.scale.set(1.3, 0.82, 0.9);
      puff.position.set(px, py, pz);
      cg.add(puff);
    }
    cg.position.set(winCx - 10 + c * 6.5, 11.2 + (c % 2) * 1.15, wallZ - 21.5 - c * 0.9);
    dayGroup.add(cg);
    clouds.push(cg);
  }

  // 夜間月亮、星群與草叢螢火蟲
  const nightGroup = new THREE.Group();
  nightGroup.visible = false;
  outdoor.add(nightGroup);

  const moonDisc = new THREE.Mesh(
    trackGeo(new THREE.SphereGeometry(1.25, 20, 14)),
    trackMat(new THREE.MeshBasicMaterial({ color: 0xfef4c8 }))
  );
  moonDisc.position.set(winCx - 6.6, 12.8, wallZ - 24.5);
  nightGroup.add(moonDisc);

  const moonGlow = new THREE.Mesh(
    trackGeo(new THREE.RingGeometry(1.35, 2.25, 28)),
    trackMat(new THREE.MeshBasicMaterial({ color: 0xdce8ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide }))
  );
  moonGlow.position.copy(moonDisc.position);
  nightGroup.add(moonGlow);

  const starGeo = trackGeo(new THREE.OctahedronGeometry(0.13, 0));
  const starMat = trackMat(new THREE.MeshBasicMaterial({ color: 0xfff8d6 }));
  const starCount = 44;
  const starInstances = new THREE.InstancedMesh(starGeo, starMat, starCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < starCount; i++) {
    const sx = winCx - 20 + ((i * 8.31) % 40);
    const sy = 6.8 + ((i * 4.17) % 9.5);
    dummy.position.set(sx, sy, wallZ - 26.2);
    dummy.scale.setScalar(0.55 + (i % 4) * 0.3);
    dummy.updateMatrix();
    starInstances.setMatrixAt(i, dummy.matrix);
  }
  starInstances.instanceMatrix.needsUpdate = true;
  starInstances.computeBoundingSphere();
  nightGroup.add(starInstances);

  // 夜晚草叢螢火蟲（柔和點狀微光飄浮）
  const fireflyGeo = trackGeo(new THREE.SphereGeometry(0.075, 6, 6));
  const fireflyMat = trackMat(new THREE.MeshBasicMaterial({ color: 0xd9ff73 }));
  const fireflySeeds: Array<{ base: THREE.Vector3; phase: number; speed: number; mesh: THREE.Mesh }> = [];
  for (let f = 0; f < 16; f++) {
    const fm = new THREE.Mesh(fireflyGeo, fireflyMat);
    const bx = winCx - 7.5 + ((f * 3.1) % 15);
    const by = 2.0 + ((f * 0.9) % 2.4);
    const bz = wallZ - 4.2 - ((f * 1.4) % 7.5);
    fm.position.set(bx, by, bz);
    nightGroup.add(fm);
    fireflySeeds.push({
      base: new THREE.Vector3(bx, by, bz),
      phase: f * 1.15,
      speed: 1.1 + (f % 4) * 0.35,
      mesh: fm,
    });
  }

  // 多層起伏草坡與遠山剪影（柔順圓丘取代方塊）
  const grassMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x5ca647, roughness: 0.9, metalness: 0.02 })
  );
  const hillMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x45853b, roughness: 0.92, metalness: 0.02 })
  );
  const farMountainMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x567b72, roughness: 0.95, metalness: 0.01 })
  );

  const ground = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(82, 1.4, 34)), grassMat);
  ground.position.set(winCx, 0.7, wallZ - 16);
  outdoor.add(ground);

  const addMeadowMound = (x: number, y: number, z: number, rx: number, ry: number, rz: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(1, 20, 14)), mat);
    m.scale.set(rx, ry, rz);
    m.position.set(x, y, z);
    outdoor.add(m);
  };
  addMeadowMound(winCx - 9.5, 1.0, wallZ - 15.5, 13.5, 2.3, 6.2, hillMat);
  addMeadowMound(winCx + 10.5, 1.0, wallZ - 17.0, 14.5, 2.7, 6.8, hillMat);
  addMeadowMound(winCx - 1.5, 0.9, wallZ - 21.0, 19.0, 3.6, 5.5, farMountainMat);
  addMeadowMound(winCx + 15.5, 0.8, wallZ - 23.0, 16.0, 4.4, 5.5, farMountainMat);
  addMeadowMound(winCx - 16.5, 0.8, wallZ - 23.5, 16.0, 4.1, 5.5, farMountainMat);

  // 庭院彎曲石板小徑
  const stoneMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x9fa39c, roughness: 0.88, metalness: 0.02 })
  );
  for (let s = 0; s < 8; s++) {
    const stone = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.48, 0.56, 0.14, 9)), stoneMat);
    stone.scale.set(1.15, 1, 0.85);
    stone.position.set(
      winCx - 0.6 + Math.sin(s * 0.55) * 1.4,
      1.42,
      wallZ - 2.6 - s * 1.35
    );
    stone.rotation.y = s * 0.4;
    outdoor.add(stone);
  }

  // 細緻牧場木圍欄（立柱頂帽＋雙橫樑＋斜撐）
  const fenceMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x916742, roughness: 0.84, metalness: 0.04 })
  );
  const fenceZ = wallZ - 4.8;
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue; // 中央留出踏步小道缺口
    const px = winCx + i * 2.3;
    const post = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.24, 1.35, 0.24)), fenceMat);
    post.position.set(px, 1.9, fenceZ);
    outdoor.add(post);
    const cap = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(0.2, 0.22, 4)), fenceMat);
    cap.rotation.y = Math.PI * 0.25;
    cap.position.set(px, 2.68, fenceZ);
    outdoor.add(cap);
  }
  for (const sideX of [-1, 1] as const) {
    for (const ry of [1.72, 2.24]) {
      const rail = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(7.2, 0.13, 0.11)), fenceMat);
      rail.position.set(winCx + sideX * 5.75, ry, fenceZ);
      outdoor.add(rail);
    }
  }

  // 遠處紅瓦田園小屋（夜晚窗戶透出暖黃燈光）
  const cottage = new THREE.Group();
  const cottageWallMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xf1e6d2, roughness: 0.82 }));
  const roofMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xb84735, roughness: 0.68 }));
  const cottageWinMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x7da9c8, emissive: 0x000000, roughness: 0.25 })
  );
  const cBody = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.8, 1.85, 2.2)), cottageWallMat);
  cBody.position.y = 0.92;
  cottage.add(cBody);
  const cRoof = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(2.35, 1.4, 4)), roofMat);
  cRoof.rotation.y = Math.PI * 0.25;
  cRoof.position.y = 2.5;
  cottage.add(cRoof);
  const cChimney = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.36, 0.85, 0.36)), roofMat);
  cChimney.position.set(0.75, 2.75, -0.3);
  cottage.add(cChimney);
  for (const wx of [-0.65, 0.65]) {
    const cw = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.52, 0.56, 0.08)), cottageWinMat);
    cw.position.set(wx, 1.0, 1.11);
    cottage.add(cw);
  }
  const cDoor = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.56, 0.95, 0.08)), darkWoodMat);
  cDoor.position.set(0, 0.48, 1.11);
  cottage.add(cDoor);
  cottage.position.set(winCx + 7.4, 1.4, wallZ - 15.2);
  cottage.rotation.y = -0.35;
  outdoor.add(cottage);

  // 草叢與點綴野花（InstancedMesh 高效批次渲染）
  const bushMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x3b843b, roughness: 0.82 }));
  const bushPositions: [number, number, number][] = [
    [winCx - 5.5, 1.55, wallZ - 4.2],
    [winCx - 4.7, 1.48, wallZ - 4.0],
    [winCx + 5.3, 1.58, wallZ - 4.3],
    [winCx + 6.2, 1.5, wallZ - 4.8],
    [winCx + 2.5, 1.5, wallZ - 7.8],
  ];
  for (const [bx, by, bz] of bushPositions) {
    const b1 = new THREE.Mesh(trackGeo(new THREE.IcosahedronGeometry(0.65, 1)), bushMat);
    b1.scale.set(1.2, 0.85, 1.0);
    b1.position.set(bx, by, bz);
    outdoor.add(b1);
  }

  const flowerGeo = trackGeo(new THREE.IcosahedronGeometry(0.11, 0));
  const flowerMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65 }));
  const flowerCount = 34;
  const flowerInstances = new THREE.InstancedMesh(flowerGeo, flowerMat, flowerCount);
  const flowerPalette = [0xffdf59, 0xff8da1, 0xffffff, 0xb8a3ff];
  const colorTmp = new THREE.Color();
  for (let i = 0; i < flowerCount; i++) {
    const fx = winCx - 8.5 + ((i * 5.37) % 17);
    const fz = wallZ - 2.4 - ((i * 2.91) % 9.2);
    dummy.position.set(fx, 1.46, fz);
    dummy.scale.setScalar(0.8 + (i % 3) * 0.25);
    dummy.updateMatrix();
    flowerInstances.setMatrixAt(i, dummy.matrix);
    colorTmp.setHex(flowerPalette[i % flowerPalette.length]);
    flowerInstances.setColorAt(i, colorTmp);
  }
  flowerInstances.instanceMatrix.needsUpdate = true;
  if (flowerInstances.instanceColor) flowerInstances.instanceColor.needsUpdate = true;
  flowerInstances.computeBoundingSphere();
  outdoor.add(flowerInstances);

  // 複合多段枝葉大樹（圓錐樹幹＋側枝＋多球錯落樹冠）
  const trunkMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x6b462b, roughness: 0.88, metalness: 0.02 })
  );
  const leafMatA = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x3b7a38, roughness: 0.78, metalness: 0.02 })
  );
  const leafMatB = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x529b45, roughness: 0.72, metalness: 0.02 })
  );
  const swayCanopies: THREE.Group[] = [];

  const buildTree = (scale = 1, withPerchBranch = false) => {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.32, 0.54, 4.1, 10)), trunkMat);
    trunk.position.y = 2.05;
    g.add(trunk);

    const sideLimb = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.14, 0.24, 1.7, 8)), trunkMat);
    sideLimb.position.set(0.65, 3.3, 0.15);
    sideLimb.rotation.z = -0.68;
    g.add(sideLimb);

    const crown = new THREE.Group();
    const crownSpecs: Array<[number, number, number, number, THREE.Material]> = [
      [0, 4.4, 0, 1.75, leafMatA],
      [-1.05, 4.05, 0.35, 1.25, leafMatB],
      [1.1, 4.15, -0.25, 1.32, leafMatA],
      [0.2, 5.45, 0.15, 1.38, leafMatB],
      [-0.45, 5.15, -0.45, 1.1, leafMatA],
    ];
    for (const [cx, cy, cz, r, mat] of crownSpecs) {
      const cluster = new THREE.Mesh(trackGeo(new THREE.IcosahedronGeometry(r, 1)), mat);
      cluster.scale.set(1.12, 0.9, 1.08);
      cluster.position.set(cx, cy, cz);
      crown.add(cluster);
    }
    g.add(crown);
    swayCanopies.push(crown);

    if (withPerchBranch) {
      const branch = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.14, 0.22, 2.2, 8)), trunkMat);
      branch.rotation.z = Math.PI * 0.44;
      branch.position.set(-1.15, 3.25, 0.32);
      g.add(branch);
    }
    g.scale.setScalar(scale);
    return g;
  };

  const mainTree = buildTree(1.06, true);
  mainTree.position.set(winCx + 4.9, 1.35, wallZ - 9.0);
  outdoor.add(mainTree);

  const leftTree = buildTree(0.92, false);
  leftTree.position.set(winCx - 6.6, 1.35, wallZ - 11.4);
  outdoor.add(leftTree);

  const farTree = buildTree(0.76, false);
  farTree.position.set(winCx + 0.9, 1.45, wallZ - 15.8);
  outdoor.add(farTree);

  // 白天主角：圓潤複合造型乳牛（身體＋乳斑＋四肢蹄＋可擺動頸頭＋尾巴）
  const cowGroup = new THREE.Group();
  const cowWhiteMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.68 }));
  const cowSpotMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x2a2726, roughness: 0.82 }));
  const cowPinkMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xeaa3ad, roughness: 0.62 }));
  const cowHornMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xd9c28a, roughness: 0.52 }));

  const cowBody = new THREE.Mesh(trackGeo(new THREE.CapsuleGeometry(0.58, 1.15, 8, 14)), cowWhiteMat);
  cowBody.rotation.z = Math.PI * 0.5;
  cowBody.position.set(0, 1.24, 0);
  cowGroup.add(cowBody);

  const spot1 = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.45, 10, 8)), cowSpotMat);
  spot1.scale.set(1.15, 0.88, 1.24);
  spot1.position.set(-0.22, 1.36, 0);
  cowGroup.add(spot1);
  const spot2 = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.36, 10, 8)), cowSpotMat);
  spot2.scale.set(0.95, 0.8, 1.24);
  spot2.position.set(0.55, 1.22, 0.08);
  cowGroup.add(spot2);

  const cowLegPivots: THREE.Group[] = [];
  for (const [lx, lz] of [[-0.66, 0.32], [-0.66, -0.32], [0.66, 0.32], [0.66, -0.32]]) {
    const legPivot = new THREE.Group();
    legPivot.position.set(lx, 0.82, lz);
    const leg = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.14, 0.12, 0.78, 8)), cowWhiteMat);
    leg.position.set(0, -0.38, 0);
    legPivot.add(leg);
    const hoof = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.13, 0.14, 0.14, 8)), cowSpotMat);
    hoof.position.set(0, -0.75, 0);
    legPivot.add(hoof);
    cowGroup.add(legPivot);
    cowLegPivots.push(legPivot);
  }

  const cowHeadPivot = new THREE.Group();
  cowHeadPivot.position.set(-0.98, 1.38, 0);
  const cowNeck = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.28, 0.36, 0.58, 10)), cowWhiteMat);
  cowNeck.rotation.z = 0.65;
  cowNeck.position.set(-0.18, 0.12, 0);
  cowHeadPivot.add(cowNeck);

  const cowHead = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.76, 0.66, 0.68)), cowWhiteMat);
  cowHead.position.set(-0.48, 0.18, 0);
  cowHeadPivot.add(cowHead);
  const cowMuzzle = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.42, 0.36, 0.66)), cowPinkMat);
  cowMuzzle.position.set(-0.82, 0.04, 0);
  cowHeadPivot.add(cowMuzzle);
  for (const side of [-1, 1] as const) {
    const ear = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.16, 0.18, 0.34)), cowSpotMat);
    ear.position.set(-0.32, 0.38, side * 0.46);
    ear.rotation.x = side * 0.25;
    cowHeadPivot.add(ear);
    const horn = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(0.08, 0.28, 8)), cowHornMat);
    horn.position.set(-0.35, 0.58, side * 0.22);
    horn.rotation.x = side * 0.28;
    cowHeadPivot.add(horn);
    const eye = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.07, 8, 6)), cowSpotMat);
    eye.position.set(-0.62, 0.28, side * 0.35);
    cowHeadPivot.add(eye);
  }
  cowGroup.add(cowHeadPivot);

  const cowTailPivot = new THREE.Group();
  cowTailPivot.position.set(1.06, 1.46, 0);
  const cowTail = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.05, 0.04, 0.72, 6)), cowWhiteMat);
  cowTail.position.y = -0.34;
  cowTailPivot.add(cowTail);
  const tailTuft = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.1, 8, 6)), cowSpotMat);
  tailTuft.position.y = -0.7;
  cowTailPivot.add(tailTuft);
  cowGroup.add(cowTailPivot);

  cowGroup.position.set(winCx - 2.4, 1.38, wallZ - 8.2);
  cowGroup.rotation.y = 0.42;
  dayGroup.add(cowGroup);

  // 夜晚主角：棲息枝頭的大眼貓頭鷹（複合羽翼、臉盤、眨眼動作）
  const owlGroup = new THREE.Group();
  const owlBodyMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x7b563e, roughness: 0.78 }));
  const owlWingMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x5c3e2b, roughness: 0.8 }));
  const owlBellyMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xe3d1b3, roughness: 0.82 }));
  const owlEyeMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xffd04a, emissive: 0xd99b16, roughness: 0.25 })
  );
  const owlPupilMat = trackMat(new THREE.MeshBasicMaterial({ color: 0x151210 }));
  const owlBeakMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xf4a532, roughness: 0.45 }));

  const owlBody = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.46, 14, 12)), owlBodyMat);
  owlBody.scale.set(0.92, 1.18, 0.86);
  owlBody.position.y = 0.48;
  owlGroup.add(owlBody);

  const owlBelly = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.34, 12, 10)), owlBellyMat);
  owlBelly.scale.set(0.88, 1.05, 0.48);
  owlBelly.position.set(0, 0.44, 0.28);
  owlGroup.add(owlBelly);

  const owlWingPivots: Array<{ pivot: THREE.Group; side: -1 | 1 }> = [];
  for (const side of [-1, 1] as const) {
    const wingPivot = new THREE.Group();
    wingPivot.position.set(side * 0.36, 0.62, -0.02);
    const wing = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.32, 10, 8)), owlWingMat);
    wing.scale.set(0.38, 1.28, 0.84);
    wing.position.set(side * 0.06, -0.18, 0);
    wing.rotation.z = side * 0.12;
    wingPivot.add(wing);
    owlGroup.add(wingPivot);
    owlWingPivots.push({ pivot: wingPivot, side });

    const talon = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 0.08, 0.24)), owlBeakMat);
    talon.position.set(side * 0.16, 0.04, 0.12);
    owlGroup.add(talon);
  }

  const owlHeadPivot = new THREE.Group();
  owlHeadPivot.position.set(0, 1.0, 0);
  const owlHead = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.42, 14, 12)), owlBodyMat);
  owlHead.scale.set(1.06, 0.86, 0.94);
  owlHead.position.y = 0.2;
  owlHeadPivot.add(owlHead);

  const owlBeak = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(0.11, 0.22, 6)), owlBeakMat);
  owlBeak.rotation.x = Math.PI * 0.55;
  owlBeak.position.set(0, 0.14, 0.42);
  owlHeadPivot.add(owlBeak);

  const owlEyelids: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const tuft = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(0.1, 0.26, 5)), owlWingMat);
    tuft.position.set(side * 0.3, 0.52, 0.06);
    tuft.rotation.z = -side * 0.32;
    owlHeadPivot.add(tuft);

    const faceDisc = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 12)), owlBellyMat);
    faceDisc.rotation.x = Math.PI * 0.5;
    faceDisc.position.set(side * 0.19, 0.24, 0.33);
    owlHeadPivot.add(faceDisc);

    const eye = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.13, 10, 8)), owlEyeMat);
    eye.scale.set(1, 1, 0.55);
    eye.position.set(side * 0.19, 0.25, 0.36);
    owlHeadPivot.add(eye);

    const pupil = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.065, 8, 6)), owlPupilMat);
    pupil.scale.set(1, 1, 0.55);
    pupil.position.set(side * 0.19, 0.25, 0.41);
    owlHeadPivot.add(pupil);

    const eyelid = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.26, 0.24, 0.06)), owlBodyMat);
    eyelid.position.set(side * 0.19, 0.26, 0.415);
    eyelid.scale.y = 0.01;
    owlHeadPivot.add(eyelid);
    owlEyelids.push(eyelid);
  }
  owlGroup.add(owlHeadPivot);

  owlGroup.position.set(winCx + 3.25, 4.92, wallZ - 8.66);
  owlGroup.rotation.y = -0.28;
  nightGroup.add(owlGroup);

  let targetCurtainOpen = true;
  let curtainProgress = 1;
  let targetTimeOfDay: RoomTimeOfDay = 'day';
  let nightBlend = 0;
  let elapsed = 0;

  const cowRestPos = new THREE.Vector3(winCx - 2.4, 1.38, wallZ - 8.2);
  const cowRestRotY = 0.42;
  const owlRestPos = new THREE.Vector3(winCx + 3.25, 4.92, wallZ - 8.66);
  const owlRestRotY = -0.28;

  let tidyAnim: { kind: RoomTimeOfDay; t: number; duration: number } | null = null;

  const dayGrass = new THREE.Color(0x5ca647);
  const nightGrass = new THREE.Color(0x1d3526);
  const dayHill = new THREE.Color(0x45853b);
  const nightHill = new THREE.Color(0x162922);
  const dayFar = new THREE.Color(0x567b72);
  const nightFar = new THREE.Color(0x142033);
  const dayLeafA = new THREE.Color(0x3b7a38);
  const nightLeafA = new THREE.Color(0x183424);
  const dayLeafB = new THREE.Color(0x529b45);
  const nightLeafB = new THREE.Color(0x20422d);
  const dayBush = new THREE.Color(0x3b843b);
  const nightBush = new THREE.Color(0x163222);

  const smoothstep01 = (v: number): number => {
    const c = Math.max(0, Math.min(1, v));
    return c * c * (3 - 2 * c);
  };

  const applyMix = () => {
    grassMat.color.copy(dayGrass).lerp(nightGrass, nightBlend);
    hillMat.color.copy(dayHill).lerp(nightHill, nightBlend);
    farMountainMat.color.copy(dayFar).lerp(nightFar, nightBlend);
    leafMatA.color.copy(dayLeafA).lerp(nightLeafA, nightBlend);
    leafMatB.color.copy(dayLeafB).lerp(nightLeafB, nightBlend);
    bushMat.color.copy(dayBush).lerp(nightBush, nightBlend);

    // 遠處農舍窗戶夜間點燈
    cottageWinMat.emissive.setHex(nightBlend > 0.45 ? 0xffb84d : 0x000000);
    cottageWinMat.emissiveIntensity = nightBlend > 0.45 ? (nightBlend - 0.45) * 1.8 : 0;

    skyBackdropDay.visible = nightBlend < 0.55;
    skyBackdropNight.visible = nightBlend >= 0.45;
    dayGroup.visible = nightBlend < 0.7 || tidyAnim?.kind === 'day';
    nightGroup.visible = nightBlend >= 0.3 || tidyAnim?.kind === 'night';

    const scaleX = THREE.MathUtils.lerp(1.02, 0.24, curtainProgress);
    const offset = THREE.MathUtils.lerp(winHalfW * 0.48, winHalfW + 1.15, curtainProgress);
    leftCurtain.scale.x = scaleX;
    rightCurtain.scale.x = scaleX;
    leftCurtain.position.x = winCx - offset;
    rightCurtain.position.x = winCx + offset;

    if (onLightingMix) {
      const openFactor = curtainProgress;
      const isNightFactor = nightBlend;
      const keyIntensity =
        THREE.MathUtils.lerp(0.82, 1.56, openFactor) * THREE.MathUtils.lerp(1.0, 0.72, isNightFactor);
      const hemiIntensity =
        THREE.MathUtils.lerp(0.38, 0.62, openFactor) * THREE.MathUtils.lerp(1.0, 0.78, isNightFactor);
      onLightingMix({
        skyHex: isNightFactor > 0.5 ? 0x10131d : 0x18130f,
        hemiSkyHex: isNightFactor > 0.5 ? 0x7e9be0 : 0xe3efff,
        hemiGroundHex: isNightFactor > 0.5 ? 0x151822 : 0x271d14,
        hemiIntensity,
        keyHex: isNightFactor > 0.5 ? 0xdbe6ff : 0xfff3e0,
        keyIntensity,
        rimHex: isNightFactor > 0.5 ? 0x7599ff : 0x9ec4ff,
        rimIntensity: THREE.MathUtils.lerp(0.32, 0.46, isNightFactor),
        exposure: THREE.MathUtils.lerp(0.78, 0.94, openFactor * (1 - isNightFactor * 0.35)),
      });
    }
  };

  applyMix();

  return {
    root,
    setCurtainOpen(open: boolean) {
      targetCurtainOpen = open;
    },
    setTimeOfDay(tod: RoomTimeOfDay) {
      targetTimeOfDay = tod;
    },
    triggerTidyAnimation(tod: RoomTimeOfDay) {
      tidyAnim = { kind: tod, t: 0, duration: 3.3 };
    },
    update(dt: number, curtainOpen: boolean, tod: RoomTimeOfDay) {
      targetCurtainOpen = curtainOpen;
      targetTimeOfDay = tod;
      elapsed += dt;

      if (tidyAnim) {
        tidyAnim.t += dt;
        if (tidyAnim.t >= tidyAnim.duration) {
          tidyAnim = null;
        }
      }

      // 動物進房整理時暫時微掀窗簾，結束後自動還原
      const baseC = targetCurtainOpen ? 1 : 0;
      const targetC = tidyAnim ? Math.max(baseC, 0.88) : baseC;
      const targetN = targetTimeOfDay === 'night' ? 1 : 0;
      const k = 1 - Math.exp(-7 * dt);
      curtainProgress += (targetC - curtainProgress) * k;
      nightBlend += (targetN - nightBlend) * k;

      // 微風輕拂樹冠
      swayCanopies.forEach((crown, idx) => {
        crown.rotation.z = Math.sin(elapsed * 0.95 + idx * 1.4) * 0.028;
      });

      // 白天雲朵緩慢飄過＋乳牛低頭吃草／或進場靠近鏡頭整理桌面
      if (dayGroup.visible) {
        clouds.forEach((cg, idx) => {
          cg.position.x = winCx - 14 + (((elapsed * (0.24 + idx * 0.07) + idx * 7.2) % 28));
        });

        if (tidyAnim && tidyAnim.kind === 'day') {
          const p = tidyAnim.t / tidyAnim.duration;
          const deskTarget = new THREE.Vector3(winCx - 1.6, 0.95, 1.35);
          const sillPos = new THREE.Vector3(winCx - 0.5, 2.35, wallZ + 0.3);

          if (p < 0.34) {
            // 從草地穿過圍欄缺口跨上窗台再大步走向書桌與鏡頭
            const u = smoothstep01(p / 0.34);
            if (u < 0.45) {
              const s = smoothstep01(u / 0.45);
              cowGroup.position.lerpVectors(cowRestPos, sillPos, s);
              cowGroup.position.y += Math.sin(s * Math.PI) * 0.75;
            } else {
              const s = smoothstep01((u - 0.45) / 0.55);
              cowGroup.position.lerpVectors(sillPos, deskTarget, s);
              cowGroup.position.y += Math.sin(s * Math.PI) * 1.15;
            }
            cowGroup.rotation.y = THREE.MathUtils.lerp(cowRestRotY, Math.PI * 0.52, u);
            cowGroup.scale.setScalar(THREE.MathUtils.lerp(1.0, 1.32, u));
            cowHeadPivot.rotation.z = 0.08 + Math.sin(elapsed * 10) * 0.14;
            cowHeadPivot.rotation.y = Math.sin(elapsed * 4) * 0.14;
            cowLegPivots.forEach((lp, idx) => {
              lp.rotation.z = Math.sin(elapsed * 16 + (idx < 2 ? 0 : Math.PI)) * 0.48;
            });
          } else if (p < 0.7) {
            // 在桌面靠近玩家處左右低頭撥弄把積木推回盤籃
            const u = (p - 0.34) / 0.36;
            const sweep = Math.sin(u * Math.PI * 2.5);
            cowGroup.position.set(
              deskTarget.x - 1.8 * Math.sin(u * Math.PI) + sweep * 0.85,
              deskTarget.y + Math.abs(Math.sin(u * Math.PI * 4)) * 0.18,
              deskTarget.z + Math.sin(u * Math.PI) * 1.25
            );
            cowGroup.rotation.y = Math.PI * 0.52 + sweep * 0.45;
            cowGroup.scale.setScalar(1.32);
            cowHeadPivot.rotation.z = 0.58 + Math.sin(u * Math.PI * 6) * 0.25;
            cowHeadPivot.rotation.y = sweep * 0.42;
            cowLegPivots.forEach((lp, idx) => {
              lp.rotation.z = Math.sin(elapsed * 12 + idx) * 0.22;
            });
          } else {
            // 整理完成轉身躍出窗外回到草地
            const u = smoothstep01((p - 0.7) / 0.3);
            if (u < 0.52) {
              const s = smoothstep01(u / 0.52);
              cowGroup.position.lerpVectors(deskTarget, sillPos, s);
              cowGroup.position.y += Math.sin(s * Math.PI) * 1.1;
              cowGroup.rotation.y = THREE.MathUtils.lerp(Math.PI * 0.52, -Math.PI * 0.5, Math.min(1, s * 1.4));
            } else {
              const s = smoothstep01((u - 0.52) / 0.48);
              cowGroup.position.lerpVectors(sillPos, cowRestPos, s);
              cowGroup.position.y += Math.sin(s * Math.PI) * 0.7;
              cowGroup.rotation.y = THREE.MathUtils.lerp(-Math.PI * 0.5, cowRestRotY, s);
            }
            cowGroup.scale.setScalar(THREE.MathUtils.lerp(1.32, 1.0, u));
            cowHeadPivot.rotation.z = 0.15;
            cowHeadPivot.rotation.y = 0;
            cowLegPivots.forEach((lp, idx) => {
              lp.rotation.z = Math.sin(elapsed * 16 + (idx < 2 ? 0 : Math.PI)) * 0.45;
            });
          }
          cowTailPivot.rotation.z = Math.sin(elapsed * 8) * 0.42;
        } else {
          cowGroup.position.copy(cowRestPos);
          cowGroup.rotation.y = cowRestRotY;
          cowGroup.scale.setScalar(1);
          cowLegPivots.forEach(lp => {
            lp.rotation.z = 0;
          });
          const cycle = Math.sin(elapsed * 1.15);
          cowHeadPivot.rotation.z = 0.25 + Math.max(0, cycle) * 0.45;
          cowHeadPivot.rotation.y = Math.sin(elapsed * 0.55) * 0.2;
          cowTailPivot.rotation.z = Math.sin(elapsed * 3.1) * 0.24;
        }
      }

      // 夜晚貓頭鷹轉頭眨眼／或展翅飛進書桌上空俯衝整理＋螢火蟲飛舞
      if (nightGroup.visible) {
        if (tidyAnim && tidyAnim.kind === 'night') {
          const p = tidyAnim.t / tidyAnim.duration;
          const hoverTarget = new THREE.Vector3(winCx - 1.2, 2.75, 1.85);
          const windowPassPos = new THREE.Vector3(winCx + 0.8, 3.85, wallZ + 0.4);
          const flap = Math.sin(elapsed * 26);

          if (p < 0.34) {
            const u = smoothstep01(p / 0.34);
            if (u < 0.45) {
              const s = smoothstep01(u / 0.45);
              owlGroup.position.lerpVectors(owlRestPos, windowPassPos, s);
            } else {
              const s = smoothstep01((u - 0.45) / 0.55);
              owlGroup.position.lerpVectors(windowPassPos, hoverTarget, s);
            }
            owlGroup.rotation.y = THREE.MathUtils.lerp(owlRestRotY, -0.15, u);
            owlGroup.rotation.x = 0.28 * Math.sin(u * Math.PI);
            owlGroup.rotation.z = Math.sin(elapsed * 8) * 0.08;
            owlGroup.scale.setScalar(THREE.MathUtils.lerp(1.0, 1.42, u));
          } else if (p < 0.7) {
            const u = (p - 0.34) / 0.36;
            const figureX = Math.sin(u * Math.PI * 2) * 2.8;
            const diveY = Math.sin(u * Math.PI * 2) * 0.48;
            owlGroup.position.set(
              hoverTarget.x + figureX,
              hoverTarget.y + diveY,
              hoverTarget.z + Math.cos(u * Math.PI * 2) * 0.9
            );
            owlGroup.rotation.y = -Math.cos(u * Math.PI * 2) * 0.35;
            owlGroup.rotation.z = -Math.cos(u * Math.PI * 2) * 0.24;
            owlGroup.rotation.x = 0.16;
            owlGroup.scale.setScalar(1.42);
          } else {
            const u = smoothstep01((p - 0.7) / 0.3);
            if (u < 0.5) {
              const s = smoothstep01(u / 0.5);
              owlGroup.position.lerpVectors(hoverTarget, windowPassPos, s);
              owlGroup.rotation.y = THREE.MathUtils.lerp(0, Math.PI, Math.min(1, s * 1.4));
            } else {
              const s = smoothstep01((u - 0.5) / 0.5);
              owlGroup.position.lerpVectors(windowPassPos, owlRestPos, s);
              owlGroup.rotation.y = THREE.MathUtils.lerp(Math.PI, owlRestRotY, s);
            }
            owlGroup.rotation.x = 0.2 * (1 - u);
            owlGroup.rotation.z = 0;
            owlGroup.scale.setScalar(THREE.MathUtils.lerp(1.42, 1.0, u));
          }

          owlWingPivots.forEach(({ pivot, side }) => {
            pivot.rotation.z = side * (0.85 + flap * 0.65);
          });
          owlHeadPivot.rotation.y = Math.sin(elapsed * 4) * 0.25;
          owlHeadPivot.rotation.z = 0;
          for (const lid of owlEyelids) lid.scale.y = 0.01;
        } else {
          owlGroup.position.copy(owlRestPos);
          owlGroup.rotation.set(0, owlRestRotY, 0);
          owlGroup.scale.setScalar(1);
          owlWingPivots.forEach(({ pivot }) => {
            pivot.rotation.z = 0;
          });
          owlHeadPivot.rotation.y = Math.sin(elapsed * 0.9) * 0.45;
          owlHeadPivot.rotation.z = Math.sin(elapsed * 1.8) * 0.07;
          const blinkPhase = elapsed % 4.2;
          const blinkScale = blinkPhase > 4.02 ? Math.sin(((blinkPhase - 4.02) / 0.18) * Math.PI) : 0.01;
          for (const lid of owlEyelids) {
            lid.scale.y = Math.max(0.01, blinkScale);
          }
        }
        for (const ff of fireflySeeds) {
          ff.mesh.position.x = ff.base.x + Math.sin(elapsed * ff.speed + ff.phase) * 0.55;
          ff.mesh.position.y = ff.base.y + Math.sin(elapsed * (ff.speed * 1.4) + ff.phase) * 0.35;
          ff.mesh.position.z = ff.base.z + Math.cos(elapsed * ff.speed * 0.8 + ff.phase) * 0.45;
        }
      }

      applyMix();
    },
    dispose() {
      for (const d of disposables) {
        d.dispose();
      }
    },
  };
}
