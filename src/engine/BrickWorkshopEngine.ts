import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  BRICK_H,
  CELL,
  SHAPES,
  W,
  bboxOf,
  buildPlan,
  rotCells,
  worldCells,
} from './brickPlanner';
import { brickGeometry } from './brickGeometry';
import { playClick, setAudioEnabled } from './audio';
import type {
  BrickModel,
  ColorDef,
  FeelSettings,
  PlanBrick,
  SavedBrickRecord,
  ShapeKey,
  WorkshopHudSnapshot,
} from '../types/brick';

export interface BrickInstance {
  id: number;
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  mesh: THREE.Mesh;
  shapeKey: ShapeKey;
  colorIdx: number;
  rot: number;
  bb: { w: number; d: number };
  state: 'pool' | 'held' | 'placed' | 'pressed';
  cellsWorld: string[] | null;
  snapAnim: number;
  trayIndex: number;
  offset: THREE.Vector3;
}

interface TrayZone {
  index: number;
  x0: number;
  z0: number;
  w: number;
  d: number;
  cx: number;
  cz: number;
  widthWorld: number;
  depthWorld: number;
  floorMesh: THREE.Mesh;
  rimMesh: THREE.LineSegments;
}

interface PourItem {
  shape: ShapeKey;
  color: number;
  trayIndex: number;
  slotIdx: number;
}

interface ActivePour {
  packIdx: number;
  tray: TrayZone;
  items: PourItem[];
  elapsed: number;
  spawnAccum: number;
  spawnedCount: number;
  pouchGroup: THREE.Group;
  tearStrip: THREE.Mesh;
  bagBody: THREE.Mesh;
}

export interface EngineCallbacks {
  onSnapshot: (snap: WorkshopHudSnapshot) => void;
  onFps?: (fps: number) => void;
  onAutoSave: (records: SavedBrickRecord[], openedPacks: boolean[]) => void;
  onContextLost: () => void;
}

const TRAY_FLOOR_TOP = 0.24;
const BUILD_TOP_Y = 0.12;
const FINGER_R = CELL * 0.8;

// Pre-allocated scratch objects to avoid per-frame GC in animate()
const _hitVec = new THREE.Vector3();
const _dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ndc = new THREE.Vector2();

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.RENDERER;
    const gpu = String(param || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

let rapierReady: Promise<void> | null = null;
function ensureRapier(): Promise<void> {
  if (!rapierReady) {
    rapierReady = RAPIER.init();
  }
  return rapierReady;
}

export class BrickWorkshopEngine {
  private container: HTMLElement;
  private callbacks: EngineCallbacks;
  private model: BrickModel;
  private isSandbox: boolean;
  private palette: ColorDef[];
  private plan: PlanBrick[];
  private feel: FeelSettings;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private world!: RAPIER.World;
  private pmremEnv: THREE.Texture | null = null;

  // Shared materials by color index and visual highlight state
  private baseMaterials = new Map<number, THREE.MeshStandardMaterial>();
  private placedMaterials = new Map<number, THREE.MeshStandardMaterial>();
  private hoverPoolMaterials = new Map<number, THREE.MeshStandardMaterial>();
  private hoverPressedMaterials = new Map<number, THREE.MeshStandardMaterial>();

  private isSoftwareGl = false;
  private disposed = false;
  private frameId = 0;
  private clock = new THREE.Clock();
  private accPhysics = 0;

  private bricks: BrickInstance[] = [];
  private seq = 0;
  private uf = new Map<BrickInstance, BrickInstance>();
  private openedPacks: boolean[] = [];

  private trays: TrayZone[] = [];
  private activeTray = 0;
  private viewKey: 'build' | 'wide' | 'tray' = 'build';
  private camTween: {
    p0: THREE.Vector3;
    t0: THREE.Vector3;
    p1: THREE.Vector3;
    t1: THREE.Vector3;
    k: number;
  } | null = null;

  private bX0 = 0;
  private bZ0 = 0;
  private padCx = 0;
  private padCz = 0;
  private boardW = 16;
  private boardD = 12;

  private raycaster = new THREE.Raycaster();
  private ghostMesh!: THREE.Mesh;
  private dropLine!: THREE.Mesh;
  private dropRing!: THREE.Mesh;
  private guideGroup = new THREE.Group();
  private currentGuideBricks: PlanBrick[] = [];

  // 3D 待拆零件袋 & 傾倒動畫
  private waitingPouchGroup: THREE.Group | null = null;
  private waitingPouchPackIdx: number | null = null;
  private activePour: ActivePour | null = null;

  private fingerBody!: RAPIER.RigidBody;
  private fingerMesh!: THREE.Mesh;

  private held: BrickInstance | null = null;
  private heldGroup: BrickInstance[] = [];
  private hovering: BrickInstance[] = [];
  private hoverKey = '';
  private hoverDirty = false;
  private hoverAccum = 0;

  private fingerMode = false;
  private fingerTarget = new THREE.Vector3();
  private pointerReady = false;
  private targetPos = new THREE.Vector3();
  private visualPos = new THREE.Vector3();
  private snapValid = false;
  private snapGx = 0;
  private snapGz = 0;
  private snapY = BUILD_TOP_Y;
  private singlePluckMode = false;

  private activePointers = new Map<number, { x: number; y: number }>();
  private downScreen = { x: 0, y: 0 };
  private downWasPlaced = false;
  private downOnTrayFloor: number | null = null;
  private downOnPouch: number | null = null;
  private dragMoved = false;

  private fpsAcc = 0;
  private fpsFrames = 0;
  private lastMatchedIndices: number[] = [];
  private completedTriggered = false;
  private saveTimer: number | null = null;

  private boundPointerDown!: (e: PointerEvent) => void;
  private boundPointerMove!: (e: PointerEvent) => void;
  private boundPointerUp!: (e: PointerEvent) => void;
  private boundKeyDown!: (e: KeyboardEvent) => void;
  private boundResize!: () => void;
  private boundBlur!: () => void;

  constructor(
    container: HTMLElement,
    model: BrickModel,
    feel: FeelSettings,
    callbacks: EngineCallbacks,
    options?: { isSandbox?: boolean; sandboxPalette?: ColorDef[] }
  ) {
    this.container = container;
    this.model = model;
    this.feel = { ...feel };
    this.callbacks = callbacks;
    this.isSandbox = Boolean(options?.isSandbox);
    this.palette = this.isSandbox && options?.sandboxPalette ? options.sandboxPalette : model.palette;
    this.plan = this.isSandbox ? [] : buildPlan(model);
    this.openedPacks = this.isSandbox ? [] : model.packs.map(() => false);
    this.boardW = model.board.w;
    this.boardD = model.board.d;
    setAudioEnabled(this.feel.soundEnabled);
  }

  async init(savedBricks?: SavedBrickRecord[], savedOpenedPacks?: boolean[]): Promise<void> {
    await ensureRapier();
    if (this.disposed) return;

    this.isSoftwareGl = detectSoftwareWebGL();
    const w = this.container.clientWidth || window.innerWidth || 1024;
    const h = this.container.clientHeight || window.innerHeight || 768;

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      this.callbacks.onContextLost();
    });
    this.container.appendChild(canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1512);
    this.scene.fog = new THREE.Fog(0x1a1512, 34, 68);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmremEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.pmremEnv;
    pmrem.dispose();

    this.initMaterialLibrary();
    this.setupPhysicsAndEnvironment();
    this.setupLighting();
    this.setupGuides();

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 140);
    const buildView = this.getViewPreset('build');
    this.camera.position.copy(buildView.pos);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(buildView.tgt);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = 1.33;
    this.controls.minDistance = 4.5;
    this.controls.maxDistance = 46;
    this.controls.mouseButtons = {
      LEFT: -1 as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = {
      ONE: -1 as unknown as THREE.TOUCH,
      TWO: THREE.TOUCH.DOLLY_ROTATE,
    };
    this.controls.addEventListener('start', () => {
      this.camTween = null;
    });
    this.controls.update();

    this.bindEvents();

    if (savedBricks && savedBricks.length > 0) {
      this.restoreSavedBricks(savedBricks, savedOpenedPacks);
      this.refreshWaitingPouch();
    } else if (this.isSandbox) {
      this.spawnSandboxStarterSet();
    } else if (this.openedPacks.length > 0) {
      // 開局即以「撕開第一包倒入盤中」的流暢動畫呈現
      this.openPack(0, false);
    }

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.emitSnapshot();
    this.clock.start();
    this.tick();
  }

  private initMaterialLibrary(): void {
    const makeMat = (hex: number, roughness: number, emissive: number): THREE.MeshStandardMaterial => {
      if (this.isSoftwareGl) {
        return new THREE.MeshStandardMaterial({
          color: hex,
          roughness,
          metalness: 0.02,
          emissive,
        });
      }
      return new THREE.MeshPhysicalMaterial({
        color: hex,
        roughness,
        metalness: 0.02,
        clearcoat: 0.46,
        clearcoatRoughness: 0.22,
        reflectivity: 0.65,
        emissive,
      });
    };

    this.palette.forEach((def, idx) => {
      const hex = def.hex ?? 0xeceff2;
      const isDark = hex < 0x353535;
      const roughness = isDark ? 0.44 : 0.30;
      this.baseMaterials.set(idx, makeMat(hex, roughness, 0x000000));
      this.placedMaterials.set(idx, makeMat(hex, roughness, 0x1f3644));
      this.hoverPoolMaterials.set(idx, makeMat(hex, roughness, 0x1d4a5e));
      this.hoverPressedMaterials.set(idx, makeMat(hex, roughness, 0x2f5e8c));
    });
  }

  private getMaterialForBrick(b: BrickInstance, hoverMode: 'none' | 'pool' | 'pressed'): THREE.MeshStandardMaterial {
    if (hoverMode === 'pressed') {
      return this.hoverPressedMaterials.get(b.colorIdx) ?? this.baseMaterials.get(0)!;
    }
    if (hoverMode === 'pool') {
      return this.hoverPoolMaterials.get(b.colorIdx) ?? this.baseMaterials.get(0)!;
    }
    if (b.state === 'placed') {
      return this.placedMaterials.get(b.colorIdx) ?? this.baseMaterials.get(0)!;
    }
    return this.baseMaterials.get(b.colorIdx) ?? this.baseMaterials.get(0)!;
  }

  private setupLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0xe6eeff, 0x2c241c, 1.25));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.25);
    key.position.set(this.padCx + 3, 16, this.padCz + 8);
    key.target.position.set(this.padCx - 2, 0, this.padCz);
    this.scene.add(key.target);

    key.castShadow = !this.isSoftwareGl;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 44;
    key.shadow.camera.left = -15;
    key.shadow.camera.right = 15;
    key.shadow.camera.top = 13;
    key.shadow.camera.bottom = -13;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xa8c8ff, 0.48);
    fill.position.set(this.padCx - 14, 8, this.padCz - 9);
    this.scene.add(fill);
  }

  private setupPhysicsAndEnvironment(): void {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    try {
      this.world.integrationParameters.numSolverIterations = 4;
    } catch {
      // ignore if unsupported
    }

    const trayCount = this.isSandbox
      ? 2
      : Math.max(1, ...this.model.packs.map(p => p.trayIndex + 1));

    const BUILD = { x0: 0, z0: -6.6, w: this.boardW + 4, d: this.boardD + 4 };
    const uX0 = BUILD.x0 + (BUILD.w - this.boardW) / 2;
    const uZ0 = BUILD.z0 + (BUILD.d - this.boardD) / 2;
    this.bX0 = W(uX0);
    this.bZ0 = W(uZ0);
    this.padCx = this.bX0 + W(this.boardW) / 2;
    this.padCz = this.bZ0 + W(this.boardD) / 2;

    const deskW = trayCount > 1 ? 48 : 34;
    const deskD = 28;
    const deskCenterX = trayCount > 1 ? -6.0 : -1.5;
    const deskMat = new THREE.MeshStandardMaterial({
      color: 0x4a3728,
      roughness: 0.88,
      metalness: 0.02,
    });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(deskW, 0.6, deskD), deskMat);
    desk.position.set(deskCenterX, -0.3, 0);
    desk.receiveShadow = true;
    this.scene.add(desk);

    for (let i = 0; i < 24; i++) {
      const y = 0.002 + i * 0.0004;
      const z = -deskD / 2 + (i + 0.5) * (deskD / 24);
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(deskCenterX - deskW / 2, y, z),
        new THREE.Vector3(deskCenterX + deskW / 2, y, z),
      ]);
      this.scene.add(
        new THREE.Line(
          g,
          new THREE.LineBasicMaterial({ color: 0x5b452f, transparent: true, opacity: 0.3 })
        )
      );
    }

    const deskBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(deskCenterX, -0.3, 0)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(deskW / 2, 0.3, deskD / 2).setFriction(0.95).setRestitution(0),
      deskBody
    );

    // 組裝墊（正中心）
    const padW = W(this.boardW) + CELL * 1.2;
    const padD = W(this.boardD) + CELL * 1.2;
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(padW, 0.08, padD),
      new THREE.MeshStandardMaterial({ color: 0x2f3a44, roughness: 0.94, metalness: 0.02 })
    );
    pad.position.set(this.padCx, BUILD_TOP_Y - 0.04, this.padCz);
    pad.receiveShadow = true;
    this.scene.add(pad);

    const padBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(this.padCx, BUILD_TOP_Y - 0.04, this.padCz)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(padW / 2, 0.04, padD / 2).setFriction(0.95).setRestitution(0),
      padBody
    );

    // 組裝墊格線
    const gridMat = new THREE.LineBasicMaterial({ color: 0x9fb4cc, transparent: true, opacity: 0.34 });
    for (let i = 0; i <= this.boardW; i++) {
      this.scene.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(this.bX0 + W(i), BUILD_TOP_Y + 0.002, this.bZ0),
            new THREE.Vector3(this.bX0 + W(i), BUILD_TOP_Y + 0.002, this.bZ0 + W(this.boardD)),
          ]),
          gridMat
        )
      );
    }
    for (let i = 0; i <= this.boardD; i++) {
      this.scene.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(this.bX0, BUILD_TOP_Y + 0.002, this.bZ0 + W(i)),
            new THREE.Vector3(this.bX0 + W(this.boardW), BUILD_TOP_Y + 0.002, this.bZ0 + W(i)),
          ]),
          gridMat
        )
      );
    }

    // 托盤貼近組裝區左側，方便手機單手拖曳
    const trayCoords = [
      { x0: -8.8, z0: -4.6, w: 14, d: 17 },
      { x0: -17.8, z0: -4.6, w: 14, d: 17 },
      { x0: -8.8, z0: -15.4, w: 14, d: 17 },
    ];
    const trayMat = new THREE.MeshStandardMaterial({ color: 0x3d4a5a, roughness: 0.72, metalness: 0.1 });
    const wallH = CELL * 2.2;
    const wt = CELL * 0.42;

    this.trays = [];
    for (let idx = 0; idx < trayCount; idx++) {
      const spec = trayCoords[idx] ?? trayCoords[0];
      const tw = W(spec.w);
      const td = W(spec.d);
      const cx = spec.x0 + tw / 2;
      const cz = spec.z0 + td / 2;

      const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(tw, 0.16, td), trayMat);
      floorMesh.position.set(cx, TRAY_FLOOR_TOP - 0.08, cz);
      floorMesh.receiveShadow = true;
      floorMesh.userData.trayIndex = idx;
      this.scene.add(floorMesh);

      const floorBody = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(cx, TRAY_FLOOR_TOP - 0.08, cz)
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(tw / 2, 0.08, td / 2).setFriction(0.85).setRestitution(0.02),
        floorBody
      );

      const walls = [
        { x: cx, z: cz + td / 2 + wt / 2, hx: tw / 2 + wt, hz: wt / 2 },
        { x: cx, z: cz - td / 2 - wt / 2, hx: tw / 2 + wt, hz: wt / 2 },
        { x: cx + tw / 2 + wt / 2, z: cz, hx: wt / 2, hz: td / 2 },
        { x: cx - tw / 2 - wt / 2, z: cz, hx: wt / 2, hz: td / 2 },
      ];
      for (const wall of walls) {
        const b = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(wall.x, wallH / 2 + TRAY_FLOOR_TOP, wall.z)
        );
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(wall.hx, wallH / 2, wall.hz).setFriction(0.4).setRestitution(0),
          b
        );
        const m = new THREE.Mesh(new THREE.BoxGeometry(wall.hx * 2, wallH, wall.hz * 2), trayMat);
        m.position.set(wall.x, wallH / 2 + TRAY_FLOOR_TOP, wall.z);
        m.castShadow = !this.isSoftwareGl;
        m.receiveShadow = true;
        this.scene.add(m);
      }

      const rimGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(tw + wt * 2, wallH + 0.04, td + wt * 2));
      const rimMesh = new THREE.LineSegments(
        rimGeo,
        new THREE.LineBasicMaterial({
          color: 0x7fe3ff,
          transparent: true,
          opacity: idx === this.activeTray ? 0.55 : 0.14,
        })
      );
      rimMesh.position.set(cx, wallH / 2 + TRAY_FLOOR_TOP, cz);
      this.scene.add(rimMesh);

      this.trays.push({
        index: idx,
        x0: spec.x0,
        z0: spec.z0,
        w: spec.w,
        d: spec.d,
        cx,
        cz,
        widthWorld: tw,
        depthWorld: td,
        floorMesh,
        rimMesh,
      });
    }

    // 手指翻找球體
    this.fingerBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 40, 0)
        .setGravityScale(0)
        .setLinearDamping(7)
        .setAngularDamping(8)
        .lockRotations()
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(FINGER_R).setDensity(3.2).setFriction(0.15).setRestitution(0),
      this.fingerBody
    );
    this.fingerMesh = new THREE.Mesh(
      new THREE.SphereGeometry(FINGER_R, 14, 10),
      new THREE.MeshBasicMaterial({
        color: 0x8fe7ff,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      })
    );
    this.fingerMesh.visible = false;
    this.scene.add(this.fingerMesh);
  }

  private setupGuides(): void {
    const ghostMat = new THREE.MeshBasicMaterial({
      color: 0x6cf0a8,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ghostMesh = new THREE.Mesh(brickGeometry('1x1').geo, ghostMat);
    this.ghostMesh.visible = false;
    this.ghostMesh.renderOrder = 10;
    this.scene.add(this.ghostMesh);

    this.dropLine = new THREE.Mesh(
      new THREE.CylinderGeometry(0.038, 0.038, 1, 8),
      new THREE.MeshBasicMaterial({
        color: 0x6cf0a8,
        transparent: true,
        opacity: 0.65,
        depthTest: false,
      })
    );
    this.dropLine.visible = false;
    this.dropLine.renderOrder = 20;
    this.scene.add(this.dropLine);

    this.dropRing = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.3, 20),
      new THREE.MeshBasicMaterial({
        color: 0x6cf0a8,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthTest: false,
      })
    );
    this.dropRing.rotation.x = -Math.PI / 2;
    this.dropRing.visible = false;
    this.dropRing.renderOrder = 21;
    this.scene.add(this.dropRing);

    this.scene.add(this.guideGroup);
  }

  private buildPouchVisual(packIdx: number): {
    group: THREE.Group;
    tearStrip: THREE.Mesh;
    bagBody: THREE.Mesh;
  } {
    const group = new THREE.Group();
    const bagMat = new THREE.MeshStandardMaterial({
      color: 0xe6f0fa,
      roughness: 0.3,
      metalness: 0.05,
      transparent: true,
      opacity: 0.68,
    });
    const bagBody = new THREE.Mesh(new THREE.BoxGeometry(1.75, 2.05, 0.65), bagMat);
    bagBody.castShadow = !this.isSoftwareGl;
    bagBody.userData.pouchPackIdx = packIdx;
    group.add(bagBody);

    // 封口撕開條（亮青提示色）
    const stripMat = new THREE.MeshStandardMaterial({
      color: 0x7fe3ff,
      roughness: 0.4,
      metalness: 0.1,
    });
    const tearStrip = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.2, 0.7), stripMat);
    tearStrip.position.set(0, 1.08, 0);
    tearStrip.userData.pouchPackIdx = packIdx;
    group.add(tearStrip);

    // 袋內裝填 3 顆代表色迷你積木，一眼看出袋裡是什麼零件
    const specs = this.plan.filter(p => p.packIndex === packIdx);
    const sampleColors = [...new Set(specs.map(s => s.color))].slice(0, 3);
    sampleColors.forEach((cIdx, idx) => {
      const miniMat = this.baseMaterials.get(cIdx) ?? this.baseMaterials.get(0)!;
      const mini = new THREE.Mesh(brickGeometry('1x2').geo, miniMat);
      mini.scale.setScalar(0.55);
      mini.position.set((idx - 1) * 0.42, -0.25 + idx * 0.22, 0);
      mini.rotation.set(0.3 * idx, 0.5 * idx, 0.2);
      mini.userData.pouchPackIdx = packIdx;
      group.add(mini);
    });

    return { group, tearStrip, bagBody };
  }

  private refreshWaitingPouch(): void {
    if (this.waitingPouchGroup) {
      this.scene.remove(this.waitingPouchGroup);
      this.waitingPouchGroup = null;
      this.waitingPouchPackIdx = null;
    }
    if (this.isSandbox || this.activePour) return;

    const nextIdx = this.openedPacks.findIndex(v => !v);
    if (nextIdx < 0) return;

    const targetSpec = this.plan.find(p => p.packIndex === nextIdx);
    const tray = this.trays[targetSpec?.trayIndex ?? 0] ?? this.trays[0];
    const { group } = this.buildPouchVisual(nextIdx);
    group.position.set(tray.cx - tray.widthWorld * 0.25, TRAY_FLOOR_TOP + 2.35, tray.cz - tray.depthWorld * 0.28);
    group.rotation.set(0.18, 0.25, -0.08);
    this.scene.add(group);
    this.waitingPouchGroup = group;
    this.waitingPouchPackIdx = nextIdx;
  }

  /**
   * 視角預設：以「組裝區正中心 (padCx, 1.15, padCz)」為 OrbitControls 核心軸點
   */
  private getViewPreset(key: 'build' | 'wide' | 'tray'): { pos: THREE.Vector3; tgt: THREE.Vector3 } {
    const w = this.container.clientWidth || window.innerWidth || 1024;
    const h = this.container.clientHeight || window.innerHeight || 768;
    const aspect = w / Math.max(1, h);
    const mobileScale = aspect < 1.05 ? 1.32 : aspect < 1.35 ? 1.14 : 1.0;

    const tray = this.trays[this.activeTray] ?? this.trays[0];

    if (key === 'build') {
      return {
        tgt: new THREE.Vector3(this.padCx, 1.15, this.padCz),
        pos: new THREE.Vector3(
          this.padCx - 2.3 * mobileScale,
          11.4 * mobileScale,
          this.padCz + 12.0 * mobileScale
        ),
      };
    }
    if (key === 'tray' && tray) {
      return {
        tgt: new THREE.Vector3(tray.cx + 0.8, 0.6, tray.cz),
        pos: new THREE.Vector3(tray.cx + 2.0, 10.6 * mobileScale, tray.cz + 10.2 * mobileScale),
      };
    }

    const minX = this.trays.reduce((m, t) => Math.min(m, t.cx), -2);
    const midX = (minX + this.padCx) / 2 + 1.0;
    return {
      tgt: new THREE.Vector3(midX, 0.7, (this.padCz + (tray?.cz ?? 0)) * 0.45),
      pos: new THREE.Vector3(
        midX,
        (this.trays.length > 1 ? 21.0 : 18.0) * mobileScale,
        20.0 * mobileScale
      ),
    };
  }

  public switchView(next?: 'build' | 'wide' | 'tray'): void {
    if (next) {
      this.viewKey = next;
    } else {
      this.viewKey =
        this.viewKey === 'build'
          ? 'wide'
          : this.viewKey === 'wide' && this.trays.length > 1
            ? 'tray'
            : 'build';
    }
    this.tweenCameraTo(this.getViewPreset(this.viewKey));
    this.emitSnapshot();
  }

  public focusTray(trayIdx: number): void {
    const clamped = Math.max(0, Math.min(this.trays.length - 1, trayIdx));
    this.activeTray = clamped;
    this.trays.forEach((t, i) => {
      const mat = t.rimMesh.material as THREE.LineBasicMaterial;
      mat.opacity = i === clamped ? 0.65 : 0.14;
    });
    this.viewKey = 'tray';
    this.tweenCameraTo(this.getViewPreset('tray'));
    this.emitSnapshot();
  }

  private tweenCameraTo(to: { pos: THREE.Vector3; tgt: THREE.Vector3 }): void {
    this.camTween = {
      p0: this.camera.position.clone(),
      t0: this.controls.target.clone(),
      p1: to.pos.clone(),
      t1: to.tgt.clone(),
      k: 0,
    };
  }

  private createBrick(
    shapeKey: ShapeKey,
    colorIdx: number,
    pos: { x: number; y: number; z: number },
    rot: number,
    trayIndex = 0,
    enableCcd = false
  ): BrickInstance {
    const { geo } = brickGeometry(shapeKey);
    const mat = this.baseMaterials.get(colorIdx) ?? this.baseMaterials.get(0)!;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !this.isSoftwareGl;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const cells = SHAPES[shapeKey].cells;
    const bb = bboxOf(cells);
    const cx = bb.w / 2;
    const cz = bb.d / 2;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({
          x: 0,
          y: Math.sin((rot * Math.PI) / 360),
          z: 0,
          w: Math.cos((rot * Math.PI) / 360),
        })
        .setLinearDamping(0.28)
        .setAngularDamping(0.72)
        .setCcdEnabled(enableCcd)
    );
    const colliders: RAPIER.Collider[] = [];
    for (const [x, z] of cells) {
      colliders.push(
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid((CELL / 2) * 0.97, BRICK_H / 2, (CELL / 2) * 0.97)
            .setTranslation(W(x + 0.5) - W(cx), 0, W(z + 0.5) - W(cz))
            .setDensity(0.6)
            .setFriction(0.9)
            .setRestitution(0.02),
          body
        )
      );
    }

    const brick: BrickInstance = {
      id: this.seq++,
      body,
      colliders,
      mesh,
      shapeKey,
      colorIdx,
      rot,
      bb,
      state: 'pool',
      cellsWorld: null,
      snapAnim: 0,
      trayIndex,
      offset: new THREE.Vector3(),
    };
    mesh.userData.brick = brick;
    this.bricks.push(brick);
    return brick;
  }

  private setColliders(b: BrickInstance, on: boolean): void {
    for (const c of b.colliders) c.setEnabled(on);
  }

  /**
   * 拆包並以「撕開零件袋 -> 傾倒積木嘩啦啦掉進托盤」的物理動畫分批落盤
   */
  public openPack(packIdx: number, instant = false): void {
    if (this.isSandbox || this.openedPacks[packIdx]) return;
    this.openedPacks[packIdx] = true;

    const specs = this.plan.filter(p => p.packIndex === packIdx);
    const firstTray = this.trays[specs[0]?.trayIndex ?? 0] ?? this.trays[0];

    if (instant) {
      const margin = W(1.3);
      specs.forEach((spec, k) => {
        const tray = this.trays[spec.trayIndex] ?? firstTray;
        const col = k % 5;
        const row = Math.floor(k / 5) % 6;
        const x =
          tray.x0 +
          margin +
          ((col + 0.5) / 5) * Math.max(0.1, tray.widthWorld - margin * 2) +
          (Math.random() - 0.5) * 0.25;
        const z =
          tray.z0 +
          margin +
          ((row + 0.5) / 6) * Math.max(0.1, tray.depthWorld - margin * 2) +
          (Math.random() - 0.5) * 0.25;
        const y = TRAY_FLOOR_TOP + BRICK_H * (1.2 + Math.floor(k / 30) * 1.1);
        const rot = [0, 90, 180, 270][Math.floor(Math.random() * 4)];
        this.createBrick(spec.shape, spec.color, { x, y, z }, rot, tray.index, false);
      });
      this.refreshWaitingPouch();
      this.emitSnapshot();
      return;
    }

    // 若前一個拆包還沒倒完，先把剩餘的直接落盤
    if (this.activePour) {
      this.flushActivePour();
    }
    if (this.waitingPouchGroup) {
      this.scene.remove(this.waitingPouchGroup);
      this.waitingPouchGroup = null;
      this.waitingPouchPackIdx = null;
    }

    const { group, tearStrip, bagBody } = this.buildPouchVisual(packIdx);
    group.position.set(firstTray.cx, TRAY_FLOOR_TOP + 4.4, firstTray.cz - 0.4);
    this.scene.add(group);

    // 隨機洗勻順序讓倒出來的積木看起來自然
    const shuffled = [...specs].sort(() => Math.random() - 0.5);
    this.activePour = {
      packIdx,
      tray: firstTray,
      items: shuffled.map((s, idx) => ({
        shape: s.shape,
        color: s.color,
        trayIndex: s.trayIndex,
        slotIdx: idx,
      })),
      elapsed: 0,
      spawnAccum: 0,
      spawnedCount: 0,
      pouchGroup: group,
      tearStrip,
      bagBody,
    };

    playClick('pick');
    this.emitSnapshot();
  }

  private flushActivePour(): void {
    const pour = this.activePour;
    if (!pour) return;
    while (pour.spawnedCount < pour.items.length) {
      this.spawnPourBrick(pour, pour.items[pour.spawnedCount]);
      pour.spawnedCount++;
    }
    this.scene.remove(pour.pouchGroup);
    this.activePour = null;
    this.refreshWaitingPouch();
    this.scheduleAutoSave();
    this.emitSnapshot();
  }

  private spawnPourBrick(pour: ActivePour, item: PourItem): void {
    const tray = this.trays[item.trayIndex] ?? pour.tray;
    const margin = W(1.4);
    const angle = item.slotIdx * 2.39996;
    const radius = Math.min(1, Math.sqrt((item.slotIdx % 25) / 25)) * 0.42;
    const x =
      pour.pouchGroup.position.x * 0.5 +
      tray.cx * 0.5 +
      Math.cos(angle) * (tray.widthWorld - margin * 2) * radius;
    const z =
      pour.pouchGroup.position.z * 0.5 +
      tray.cz * 0.5 +
      Math.sin(angle) * (tray.depthWorld - margin * 2) * radius;
    const y = TRAY_FLOOR_TOP + 3.1 + (item.slotIdx % 4) * 0.38;
    const rot = [0, 90, 180, 270][Math.floor(Math.random() * 4)];
    const b = this.createBrick(item.shape, item.color, { x, y, z }, rot, tray.index, false);
    b.body.setLinvel(
      {
        x: (Math.random() - 0.5) * 2.4,
        y: -2.2 - Math.random() * 1.4,
        z: (Math.random() - 0.5) * 2.4,
      },
      true
    );
    b.body.setAngvel(
      {
        x: (Math.random() - 0.5) * 4,
        y: (Math.random() - 0.5) * 5,
        z: (Math.random() - 0.5) * 4,
      },
      true
    );
  }

  private updateActivePour(dt: number): void {
    const pour = this.activePour;
    if (!pour) return;
    pour.elapsed += dt;

    // 階段 1 (0 ~ 0.22s): 撕開封口條
    if (pour.elapsed < 0.22) {
      const k = pour.elapsed / 0.22;
      pour.tearStrip.position.x = k * 1.3;
      pour.tearStrip.position.y = 1.08 + k * 0.45;
      pour.tearStrip.rotation.z = -k * 0.55;
      return;
    }

    // 階段 2 (0.22 ~ 1.05s): 袋身倒轉並沿托盤擺動傾倒積木
    pour.tearStrip.visible = false;
    const pourTime = pour.elapsed - 0.22;
    const tilt = Math.min(1, pourTime / 0.22);
    pour.pouchGroup.rotation.z = tilt * Math.PI * 0.88;
    pour.pouchGroup.position.x = pour.tray.cx + Math.sin(pourTime * 7.5) * 1.35;
    pour.pouchGroup.position.z = pour.tray.cz + Math.cos(pourTime * 5.2) * 1.25;

    if (pour.spawnedCount < pour.items.length) {
      pour.spawnAccum += dt;
      const interval = 0.024;
      while (pour.spawnAccum >= interval && pour.spawnedCount < pour.items.length) {
        pour.spawnAccum -= interval;
        this.spawnPourBrick(pour, pour.items[pour.spawnedCount]);
        if (pour.spawnedCount % 3 === 0) playClick('pour');
        pour.spawnedCount++;
      }
      return;
    }

    // 階段 3: 倒完後上提消失
    const endK = Math.min(1, (pourTime - pour.items.length * 0.024) / 0.3);
    pour.pouchGroup.position.y += dt * 4.5;
    (pour.bagBody.material as THREE.MeshStandardMaterial).opacity = Math.max(0, 0.68 * (1 - endK));
    if (endK >= 1) {
      this.scene.remove(pour.pouchGroup);
      this.activePour = null;
      this.refreshWaitingPouch();
      this.scheduleAutoSave();
      this.emitSnapshot();
    }
  }

  /**
   * 撥開／搖勻目前托盤裡的積木，讓壓在底下的零件翻出來
   */
  public stirTray(): void {
    const tray = this.trays[this.activeTray] ?? this.trays[0];
    let stirred = 0;
    for (const b of this.bricks) {
      if (b.state !== 'pool') continue;
      const t = b.body.translation();
      if (
        t.x >= tray.x0 - 0.5 &&
        t.x <= tray.x0 + tray.widthWorld + 0.5 &&
        t.z >= tray.z0 - 0.5 &&
        t.z <= tray.z0 + tray.depthWorld + 0.5
      ) {
        b.body.wakeUp();
        const dx = tray.cx - t.x;
        const dz = tray.cz - t.z;
        b.body.setLinvel(
          {
            x: dx * 0.6 + (Math.random() - 0.5) * 3.5,
            y: 1.8 + Math.random() * 1.6,
            z: dz * 0.6 + (Math.random() - 0.5) * 3.5,
          },
          true
        );
        b.body.setAngvel(
          {
            x: (Math.random() - 0.5) * 4,
            y: (Math.random() - 0.5) * 6,
            z: (Math.random() - 0.5) * 4,
          },
          true
        );
        stirred++;
      }
    }
    if (stirred > 0) {
      playClick('shake');
    }
  }

  public spawnSandboxBrick(shape: ShapeKey, colorIdx: number, count = 4): void {
    const tray = this.trays[this.activeTray] ?? this.trays[0];
    const margin = W(1.4);
    for (let k = 0; k < count; k++) {
      const x = tray.x0 + margin + Math.random() * Math.max(0.05, tray.widthWorld - margin * 2);
      const z = tray.z0 + margin + Math.random() * Math.max(0.05, tray.depthWorld - margin * 2);
      const y = TRAY_FLOOR_TOP + BRICK_H * (2.2 + k * 0.9) + 0.4;
      const rot = [0, 90, 180, 270][Math.floor(Math.random() * 4)];
      this.createBrick(shape, colorIdx, { x, y, z }, rot, tray.index);
    }
    playClick('pour');
    this.scheduleAutoSave();
    this.emitSnapshot();
  }

  private spawnSandboxStarterSet(): void {
    const shapes: ShapeKey[] = ['1x1', '1x2', '1x4'];
    this.palette.forEach((_, colorIdx) => {
      const trayIdx = colorIdx % Math.max(1, this.trays.length);
      const tray = this.trays[trayIdx] ?? this.trays[0];
      const margin = W(1.4);
      shapes.forEach((shape, sIdx) => {
        for (let n = 0; n < 3; n++) {
          const x = tray.x0 + margin + Math.random() * Math.max(0.05, tray.widthWorld - margin * 2);
          const z = tray.z0 + margin + Math.random() * Math.max(0.05, tray.depthWorld - margin * 2);
          const y = TRAY_FLOOR_TOP + BRICK_H * (2.0 + ((sIdx * 3 + n) % 8) * 0.75) + 0.4;
          const rot = [0, 90, 180, 270][Math.floor(Math.random() * 4)];
          this.createBrick(shape, colorIdx, { x, y, z }, rot, trayIdx);
        }
      });
    });
  }

  private restoreSavedBricks(records: SavedBrickRecord[], savedOpened?: boolean[]): void {
    if (savedOpened && savedOpened.length === this.openedPacks.length) {
      this.openedPacks = [...savedOpened];
    }
    for (const rec of records) {
      const trayIdx = rec.trayIndex ?? 0;
      const b = this.createBrick(
        rec.shape,
        rec.color,
        { x: rec.pos[0], y: rec.pos[1], z: rec.pos[2] },
        rec.rot,
        trayIdx
      );
      if (rec.state === 'pressed' || rec.state === 'placed') {
        if (rec.gx !== undefined && rec.gz !== undefined) {
          if (rec.state === 'pressed') {
            this.pressBrickAt(b, rec.gx, rec.gz, rec.pos[1], true);
          } else {
            this.lightPlaceBrickAt(b, rec.gx, rec.gz, rec.pos[1], true);
          }
        }
      } else {
        b.body.setRotation(
          { x: rec.quat[0], y: rec.quat[1], z: rec.quat[2], w: rec.quat[3] },
          true
        );
      }
    }
  }

  public exportRecords(): { records: SavedBrickRecord[]; openedPacks: boolean[] } {
    if (this.activePour) {
      this.flushActivePour();
    }
    const records: SavedBrickRecord[] = this.bricks.map(b => {
      const t = b.body.translation();
      const r = b.body.rotation();
      const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
      const gx = Math.round((t.x - this.bX0) / CELL - bb.w / 2);
      const gz = Math.round((t.z - this.bZ0) / CELL - bb.d / 2);
      const st = b.state === 'held' ? 'pool' : b.state;
      return {
        shape: b.shapeKey,
        color: b.colorIdx,
        rot: b.rot,
        state: st,
        gx: st === 'pool' ? undefined : gx,
        gz: st === 'pool' ? undefined : gz,
        pos: [Number(t.x.toFixed(3)), Number(t.y.toFixed(3)), Number(t.z.toFixed(3))],
        quat: [
          Number(r.x.toFixed(4)),
          Number(r.y.toFixed(4)),
          Number(r.z.toFixed(4)),
          Number(r.w.toFixed(4)),
        ],
        trayIndex: b.trayIndex,
      };
    });
    return { records, openedPacks: [...this.openedPacks] };
  }

  public updateFeel(next: FeelSettings): void {
    this.feel = { ...next };
    setAudioEnabled(this.feel.soundEnabled);
    this.refreshStepGuideMeshes();
  }

  public setSinglePluckMode(on: boolean): void {
    this.singlePluckMode = on;
    this.emitSnapshot();
  }

  public rotateHeld(): void {
    if (!this.held || this.heldGroup.length > 1) return;
    const b = this.held;
    b.rot = (b.rot + 90) % 360;
    b.bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
    const q = (b.rot * Math.PI) / 180;
    b.body.setRotation({ x: 0, y: Math.sin(q / 2), z: 0, w: Math.cos(q / 2) }, true);
    this.ghostMesh.rotation.y = q;
    playClick('rot');
  }

  public setGuideBricks(stepBricks: PlanBrick[]): void {
    this.currentGuideBricks = stepBricks;
    this.refreshStepGuideMeshes();
  }

  private refreshStepGuideMeshes(): void {
    while (this.guideGroup.children.length > 0) {
      const child = this.guideGroup.children[0] as THREE.LineSegments;
      this.guideGroup.remove(child);
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }

    if (!this.feel.showStepGuide || this.isSandbox || this.currentGuideBricks.length === 0) return;
    const matchedSet = new Set(this.lastMatchedIndices);

    for (const p of this.currentGuideBricks) {
      if (matchedSet.has(p.index)) continue;
      const wx = this.bX0 + W(p.gx + p.bb.w / 2);
      const wz = this.bZ0 + W(p.gz + p.bb.d / 2);
      const y = BUILD_TOP_Y + BRICK_H * (p.layer + 0.5);
      const colHex = this.palette[p.color]?.hex ?? 0x7fe3ff;

      const geo = new THREE.EdgesGeometry(
        new THREE.BoxGeometry(W(p.bb.w) * 0.96, BRICK_H * 0.94, W(p.bb.d) * 0.96)
      );
      const mat = new THREE.LineBasicMaterial({
        color: colHex === 0x22262b ? 0x7fe3ff : colHex,
        transparent: true,
        opacity: 0.55,
      });
      const wire = new THREE.LineSegments(geo, mat);
      wire.position.set(wx, y, wz);
      this.guideGroup.add(wire);
    }
  }

  public autoBuildAll(): number {
    if (this.isSandbox) return 0;
    for (let i = 0; i < this.openedPacks.length; i++) {
      this.openPack(i, true);
    }
    let built = 0;
    for (const p of this.plan) {
      const already = this.lastMatchedIndices.includes(p.index);
      if (already) continue;
      const b = this.bricks.find(
        x => x.state === 'pool' && x.colorIdx === p.color && x.shapeKey === p.shape
      );
      if (!b) continue;
      b.rot = p.rot;
      this.pressBrickAt(b, p.gx, p.gz, BUILD_TOP_Y + BRICK_H * (p.layer + 0.5), true);
      built++;
    }
    this.scheduleAutoSave();
    this.emitSnapshot();
    return built;
  }

  private ufFind(b: BrickInstance): BrickInstance {
    let cur = b;
    while (this.uf.get(cur) && this.uf.get(cur) !== cur) {
      cur = this.uf.get(cur)!;
    }
    return cur;
  }

  private ufUnion(a: BrickInstance, b: BrickInstance): void {
    const ra = this.ufFind(a);
    const rb = this.ufFind(b);
    if (ra !== rb) this.uf.set(ra, rb);
  }

  private groupOf(b: BrickInstance): BrickInstance[] {
    const root = this.ufFind(b);
    return this.bricks.filter(
      x => (x.state === 'pressed' || x.state === 'placed') && this.ufFind(x) === root
    );
  }

  private rayToFixedPlane(y: number): THREE.Vector3 | null {
    _dragPlane.constant = -y;
    this.raycaster.setFromCamera(_ndc, this.camera);
    return this.raycaster.ray.intersectPlane(_dragPlane, _hitVec) ? _hitVec.clone() : null;
  }

  private pickBrick(): BrickInstance | null {
    if (this.bricks.length === 0) return null;
    this.raycaster.setFromCamera(_ndc, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.bricks.map(b => b.mesh),
      false
    );
    return hits.length ? (hits[0].object.userData.brick as BrickInstance) : null;
  }

  private pickWaitingPouch(): number | null {
    if (!this.waitingPouchGroup) return null;
    this.raycaster.setFromCamera(_ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.waitingPouchGroup, true);
    if (!hits.length) return null;
    return this.waitingPouchPackIdx;
  }

  private pickTrayFloor(): number | null {
    this.raycaster.setFromCamera(_ndc, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.trays.map(t => t.floorMesh),
      false
    );
    if (!hits.length) return null;
    const idx = hits[0].object.userData.trayIndex;
    return typeof idx === 'number' ? idx : null;
  }

  private surfaceYAt(wx: number, wz: number): number {
    const gx = Math.floor((wx - this.bX0) / CELL);
    const gz = Math.floor((wz - this.bZ0) / CELL);
    if (gx < 0 || gz < 0 || gx >= this.boardW || gz >= this.boardD) return TRAY_FLOOR_TOP;
    const key = `${gx},${gz}`;
    let top = BUILD_TOP_Y;
    for (const o of this.bricks) {
      if ((o.state !== 'placed' && o.state !== 'pressed') || !o.cellsWorld) continue;
      if (!o.cellsWorld.includes(key)) continue;
      top = Math.max(top, o.body.translation().y + BRICK_H / 2);
    }
    return top;
  }

  private supportTopY(b: BrickInstance, gx: number, gz: number): number {
    const cells = worldCells(b.shapeKey, b.rot, gx, gz);
    let top = BUILD_TOP_Y;
    for (const o of this.bricks) {
      if (o === b) continue;
      if (o.state !== 'placed' && o.state !== 'pressed') continue;
      if (!o.cellsWorld) continue;
      if (!o.cellsWorld.some(c => cells.includes(c))) continue;
      top = Math.max(top, o.body.translation().y + BRICK_H / 2);
    }
    return top + BRICK_H / 2;
  }

  private startHold(brick: BrickInstance, single: boolean): void {
    playClick('pick');
    if (brick.state === 'pressed' || brick.state === 'placed') {
      const g = single || brick.state === 'placed' ? [brick] : this.groupOf(brick);
      this.heldGroup = g;
      this.held = brick;
      const leadPos = brick.mesh.position.clone();
      for (const b of g) {
        b.offset.copy(b.mesh.position).sub(leadPos);
        b.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        this.setColliders(b, false);
        b.state = 'held';
        b.cellsWorld = null;
        this.uf.delete(b);
        b.mesh.material = this.getMaterialForBrick(b, 'none');
      }
      this.hovering = [];
      this.hoverKey = '';
      if (g.length > 1) playClick('pluck');
    } else {
      this.heldGroup = [brick];
      this.held = brick;
      brick.offset.set(0, 0, 0);
      brick.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.setColliders(brick, false);
      brick.state = 'held';
      brick.cellsWorld = null;
      brick.rot = 0;
      brick.bb = bboxOf(SHAPES[brick.shapeKey].cells);
      brick.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      brick.mesh.material = this.getMaterialForBrick(brick, 'none');
    }

    const t = brick.body.translation();
    this.visualPos.set(t.x, t.y + BRICK_H * 0.8, t.z);
    this.targetPos.copy(this.visualPos);
    this.snapValid = false;
    this.ghostMesh.geometry = brickGeometry(brick.shapeKey).geo;
    this.emitSnapshot();
  }

  private lightPlaceBrickAt(b: BrickInstance, gx: number, gz: number, dropY: number, silent = false): void {
    const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
    const wx = this.bX0 + W(gx + bb.w / 2);
    const wz = this.bZ0 + W(gz + bb.d / 2);

    this.setColliders(b, true);
    b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    b.body.setTranslation({ x: wx, y: dropY + BRICK_H * 0.08, z: wz }, true);
    const q = (b.rot * Math.PI) / 180;
    b.body.setRotation({ x: 0, y: Math.sin(q / 2), z: 0, w: Math.cos(q / 2) }, true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);

    b.state = 'placed';
    b.cellsWorld = worldCells(b.shapeKey, b.rot, gx, gz);
    b.mesh.material = this.getMaterialForBrick(b, 'none');
    if (!silent) playClick('place');
  }

  private pressBrickAt(b: BrickInstance, gx: number, gz: number, dropY: number, silent = false): void {
    const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
    const wx = this.bX0 + W(gx + bb.w / 2);
    const wz = this.bZ0 + W(gz + bb.d / 2);

    this.setColliders(b, true);
    b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    b.body.setTranslation({ x: wx, y: dropY, z: wz }, true);
    const q = (b.rot * Math.PI) / 180;
    b.body.setRotation({ x: 0, y: Math.sin(q / 2), z: 0, w: Math.cos(q / 2) }, true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);

    b.state = 'pressed';
    b.cellsWorld = worldCells(b.shapeKey, b.rot, gx, gz);
    b.snapAnim = silent ? 0 : 1.0;
    b.mesh.material = this.getMaterialForBrick(b, 'none');

    for (const o of this.bricks) {
      if (o === b || (o.state !== 'pressed' && o.state !== 'placed') || !o.cellsWorld) continue;
      const dy = Math.abs(dropY - o.body.translation().y);
      if (dy > BRICK_H * 0.4 && dy < BRICK_H * 2.2 && o.cellsWorld.some(c => b.cellsWorld!.includes(c))) {
        this.ufUnion(b, o);
      }
    }
    if (!silent) playClick('snap');
  }

  private finishHold(): void {
    if (!this.held) return;
    const g = this.heldGroup.length ? this.heldGroup : [this.held];

    if (g.length === 1 && this.snapValid) {
      const lead = g[0];
      if (this.feel.placementMode === 'two-step' && this.downWasPlaced && !this.dragMoved) {
        this.pressBrickAt(lead, this.snapGx, this.snapGz, this.snapY);
      } else if (this.feel.placementMode === 'two-step') {
        this.lightPlaceBrickAt(lead, this.snapGx, this.snapGz, this.snapY);
      } else {
        this.pressBrickAt(lead, this.snapGx, this.snapGz, this.snapY);
      }
    } else {
      for (const b of g) {
        this.setColliders(b, true);
        b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        b.state = 'pool';
        b.cellsWorld = null;
        b.mesh.material = this.getMaterialForBrick(b, 'none');
      }
    }

    this.held = null;
    this.heldGroup = [];
    this.snapValid = false;
    this.ghostMesh.visible = false;
    this.hideDropGuide();
    this.scheduleAutoSave();
    this.emitSnapshot();
  }

  private cancelActiveInteractions(): void {
    if (this.fingerMode) {
      this.fingerMode = false;
      this.fingerMesh.visible = false;
    }
    if (this.held) {
      this.finishHold();
    }
  }

  private showDropGuide(x: number, yTop: number, yBottom: number, z: number): void {
    const len = Math.max(0.02, yTop - yBottom);
    this.dropLine.position.set(x, (yTop + yBottom) / 2, z);
    this.dropLine.scale.set(1, len, 1);
    this.dropLine.visible = true;
    this.dropRing.position.set(x, yBottom + 0.015, z);
    this.dropRing.visible = true;
  }

  private hideDropGuide(): void {
    this.dropLine.visible = false;
    this.dropRing.visible = false;
  }

  private updateNDC(e: PointerEvent): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    _ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    _ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.pointerReady = true;
  }

  private bindEvents(): void {
    const canvas = this.renderer.domElement;

    this.boundPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.activePointers.size >= 2) {
        this.cancelActiveInteractions();
        return;
      }

      this.updateNDC(e);
      this.downScreen = { x: e.clientX, y: e.clientY };
      this.dragMoved = false;
      this.downOnTrayFloor = null;
      this.downOnPouch = null;

      // 先檢查是否點到 3D 待拆零件袋
      const pouchPack = this.pickWaitingPouch();
      if (pouchPack !== null) {
        this.downOnPouch = pouchPack;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        e.preventDefault();
        return;
      }

      const brick = this.pickBrick();
      if (brick) {
        this.downWasPlaced = brick.state === 'placed';
        this.startHold(brick, e.shiftKey || this.singlePluckMode);
        this.fingerMode = false;
      } else {
        this.downWasPlaced = false;
        const hitTray = this.pickTrayFloor();
        if (hitTray !== null && hitTray !== this.activeTray && this.trays.length > 1) {
          this.downOnTrayFloor = hitTray;
        }
        const p = this.rayToFixedPlane(TRAY_FLOOR_TOP + FINGER_R * 0.9);
        if (p) {
          this.fingerMode = true;
          this.fingerTarget.set(p.x, TRAY_FLOOR_TOP + FINGER_R * 0.9, p.z);
          this.fingerBody.setTranslation(
            { x: p.x, y: TRAY_FLOOR_TOP + FINGER_R * 2.2, z: p.z },
            true
          );
          this.fingerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }
      }
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      e.preventDefault();
    };

    this.boundPointerMove = (e: PointerEvent) => {
      if (this.activePointers.has(e.pointerId)) {
        this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this.activePointers.size >= 2) return;
      if (Math.hypot(e.clientX - this.downScreen.x, e.clientY - this.downScreen.y) > 6) {
        this.dragMoved = true;
      }
      this.updateNDC(e);
      this.hoverDirty = true;
    };

    this.boundPointerUp = (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);
      if (this.downOnPouch !== null) {
        this.openPack(this.downOnPouch, false);
        this.downOnPouch = null;
        return;
      }
      if (this.downOnTrayFloor !== null && !this.dragMoved && !this.held) {
        this.focusTray(this.downOnTrayFloor);
      }
      this.downOnTrayFloor = null;
      this.cancelActiveInteractions();
    };

    this.boundBlur = () => {
      this.activePointers.clear();
      this.downOnPouch = null;
      this.cancelActiveInteractions();
    };

    this.boundKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === 'r' || e.key === 'R') && this.held && this.heldGroup.length <= 1) {
        this.rotateHeld();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.switchView();
      } else if (e.key === '1' && this.trays.length >= 1) {
        this.focusTray(0);
      } else if (e.key === '2' && this.trays.length >= 2) {
        this.focusTray(1);
      } else if (e.key === '3' && this.trays.length >= 3) {
        this.focusTray(2);
      }
    };

    this.boundResize = () => {
      if (this.disposed) return;
      const w = this.container.clientWidth || window.innerWidth || 1024;
      const h = this.container.clientHeight || window.innerHeight || 768;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };

    canvas.addEventListener('pointerdown', this.boundPointerDown);
    canvas.addEventListener('pointermove', this.boundPointerMove);
    canvas.addEventListener('pointerup', this.boundPointerUp);
    canvas.addEventListener('pointercancel', this.boundPointerUp);
    window.addEventListener('blur', this.boundBlur);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('resize', this.boundResize);
  }

  private updateInteraction(dt: number): void {
    if (!this.pointerReady) return;

    // 1. 節流懸停高亮（僅指標移動且 >= 75ms 才做一次射線）
    this.hoverAccum += dt;
    if (!this.held && !this.fingerMode && this.hoverDirty && this.hoverAccum >= 0.075) {
      this.hoverDirty = false;
      this.hoverAccum = 0;
      const hb = this.pickBrick();
      let want: BrickInstance[] = [];
      let mode: 'pool' | 'pressed' = 'pool';
      if (hb) {
        if (hb.state === 'pressed') {
          want = this.groupOf(hb);
          mode = 'pressed';
        } else {
          want = [hb];
          mode = 'pool';
        }
      }
      const hk = `${want.map(b => b.id).join(',')}:${mode}`;
      if (hk !== this.hoverKey) {
        this.hoverKey = hk;
        for (const b of this.hovering) {
          b.mesh.material = this.getMaterialForBrick(b, 'none');
        }
        for (const b of want) {
          b.mesh.material = this.getMaterialForBrick(b, mode);
        }
        this.hovering = want;
      }
    }

    // 2. 手指翻找
    if (this.fingerMode) {
      const p = this.rayToFixedPlane(TRAY_FLOOR_TOP + FINGER_R * 0.9);
      if (p) this.fingerTarget.set(p.x, TRAY_FLOOR_TOP + FINGER_R * 0.9, p.z);
      const cur = this.fingerBody.translation();
      const k = 12;
      const maxV = CELL * 26;
      let vx = (this.fingerTarget.x - cur.x) * k;
      let vy = (this.fingerTarget.y - cur.y) * k;
      let vz = (this.fingerTarget.z - cur.z) * k;
      const len = Math.hypot(vx, vy, vz);
      if (len > maxV) {
        const s = maxV / len;
        vx *= s;
        vy *= s;
        vz *= s;
      }
      this.fingerBody.setLinvel({ x: vx, y: vy, z: vz }, true);
      this.fingerMesh.position.set(cur.x, cur.y, cur.z);
      this.fingerMesh.visible = true;
    } else {
      this.fingerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.fingerBody.setTranslation({ x: 0, y: 40, z: 0 }, true);
    }

    // 3. 固定平面射線＋平滑拖曳＋即時磁吸
    if (this.held) {
      const lead = this.held;
      const g = this.heldGroup.length ? this.heldGroup : [lead];
      const p = this.rayToFixedPlane(BUILD_TOP_Y + BRICK_H * 0.5);
      if (!p) return;

      const tol = CELL * this.feel.snapTolerance;
      const inBuild =
        p.x > this.bX0 - tol &&
        p.x < this.bX0 + W(this.boardW) + tol &&
        p.z > this.bZ0 - tol &&
        p.z < this.bZ0 + W(this.boardD) + tol;

      if (inBuild && g.length === 1) {
        const bb = bboxOf(rotCells(SHAPES[lead.shapeKey].cells, lead.rot));
        const gx = Math.round((p.x - this.bX0) / CELL - bb.w / 2);
        const gz = Math.round((p.z - this.bZ0) / CELL - bb.d / 2);
        const cgx = Math.min(this.boardW - bb.w, Math.max(0, gx));
        const cgz = Math.min(this.boardD - bb.d, Math.max(0, gz));
        const wx = this.bX0 + W(cgx + bb.w / 2);
        const wz = this.bZ0 + W(cgz + bb.d / 2);
        const dropY = this.supportTopY(lead, cgx, cgz);
        const holdY = dropY + BRICK_H * this.feel.holdHeightMul;

        this.snapValid = true;
        this.snapGx = cgx;
        this.snapGz = cgz;
        this.snapY = dropY;
        this.targetPos.set(wx, holdY, wz);

        this.ghostMesh.position.set(wx, dropY, wz);
        this.ghostMesh.rotation.y = (lead.rot * Math.PI) / 180;
        this.ghostMesh.visible = true;
        this.showDropGuide(wx, this.visualPos.y - BRICK_H * 0.5, dropY - BRICK_H * 0.5, wz);
      } else {
        this.snapValid = false;
        this.ghostMesh.visible = false;
        const surf = this.surfaceYAt(p.x, p.z);
        const holdY = Math.max(
          surf + BRICK_H * (this.feel.holdHeightMul + 0.35),
          TRAY_FLOOR_TOP + BRICK_H * 2.2
        );
        this.targetPos.set(p.x, holdY, p.z);
        this.showDropGuide(this.visualPos.x, this.visualPos.y - BRICK_H * 0.5, surf, this.visualPos.z);
      }

      const alpha = 1 - Math.exp(-this.feel.dragSmoothing * dt);
      this.visualPos.lerp(this.targetPos, alpha);

      for (const b of g) {
        b.body.setNextKinematicTranslation({
          x: this.visualPos.x + b.offset.x,
          y: this.visualPos.y + b.offset.y,
          z: this.visualPos.z + b.offset.z,
        });
      }
    }
  }

  private brickCellsNow(b: BrickInstance): Set<string> | null {
    const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
    const t = b.body.translation();
    const gx = Math.round((t.x - this.bX0) / CELL - bb.w / 2);
    const gz = Math.round((t.z - this.bZ0) / CELL - bb.d / 2);
    if (gx < 0 || gz < 0 || gx + bb.w > this.boardW || gz + bb.d > this.boardD) return null;
    if (Math.abs(t.x - (this.bX0 + W(gx + bb.w / 2))) > CELL * 0.4) return null;
    if (Math.abs(t.z - (this.bZ0 + W(gz + bb.d / 2))) > CELL * 0.4) return null;
    return new Set(worldCells(b.shapeKey, b.rot, gx, gz));
  }

  private computeMatchedIndices(): number[] {
    if (this.isSandbox) return [];
    const placed = this.bricks.filter(
      b => (b.state === 'placed' || b.state === 'pressed') && b.cellsWorld
    );
    const used = new Set<number>();
    const matched: number[] = [];

    for (const p of this.plan) {
      for (const b of placed) {
        if (used.has(b.id)) continue;
        if (b.colorIdx !== p.color || b.shapeKey !== p.shape) continue;
        const ty = b.body.translation().y;
        const ly = BUILD_TOP_Y + BRICK_H * (p.layer + 0.5);
        if (Math.abs(ty - ly) > BRICK_H * 0.55) continue;
        const cs = this.brickCellsNow(b);
        if (!cs || cs.size !== p.cellSet.size) continue;
        if ([...cs].every(c => p.cellSet.has(c))) {
          used.add(b.id);
          matched.push(p.index);
          break;
        }
      }
    }
    return matched;
  }

  private emitSnapshot(): void {
    const matchedIndices = this.computeMatchedIndices();
    this.lastMatchedIndices = matchedIndices;
    const isComplete =
      !this.isSandbox && this.plan.length > 0 && matchedIndices.length === this.plan.length;
    if (isComplete && !this.completedTriggered) {
      this.completedTriggered = true;
      playClick('complete');
    } else if (!isComplete) {
      this.completedTriggered = false;
    }

    this.refreshStepGuideMeshes();

    let poolCount = 0;
    let placedCount = 0;
    let pressedCount = 0;
    for (const b of this.bricks) {
      if (b.state === 'pool') poolCount++;
      else if (b.state === 'placed') placedCount++;
      else if (b.state === 'pressed') pressedCount++;
    }

    this.callbacks.onSnapshot({
      totalBricks: this.bricks.length,
      planCount: this.plan.length,
      matchedCount: matchedIndices.length,
      matchedIndices,
      openedPacks: [...this.openedPacks],
      pouringPack: this.activePour ? this.activePour.packIdx : null,
      activeTray: this.activeTray,
      trayCount: this.trays.length,
      currentView: this.viewKey,
      isComplete,
      heldActive: Boolean(this.held),
      singlePluckMode: this.singlePluckMode,
      poolCount,
      placedCount,
      pressedCount,
    });
  }

  private scheduleAutoSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (this.disposed) return;
      const { records, openedPacks } = this.exportRecords();
      this.callbacks.onAutoSave(records, openedPacks);
    }, 450);
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl?.fenceSync) {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const status = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (status === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private tick = (): void => {
    if (this.disposed) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.camTween) {
      this.camTween.k = Math.min(1, this.camTween.k + dt * 2.6);
      const ease = 1 - Math.pow(1 - this.camTween.k, 3);
      this.camera.position.lerpVectors(this.camTween.p0, this.camTween.p1, ease);
      this.controls.target.lerpVectors(this.camTween.t0, this.camTween.t1, ease);
      if (this.camTween.k >= 1) this.camTween = null;
    }

    this.updateActivePour(dt);
    this.updateInteraction(dt);

    this.accPhysics += dt;
    let steps = 0;
    while (this.accPhysics >= this.world.timestep && steps < 3) {
      this.world.step();
      this.accPhysics -= this.world.timestep;
      steps++;
    }

    for (const b of this.bricks) {
      // 已鎖定且不在彈跳動畫中的積木完全不用每幀同步 transform
      if (b.state === 'pressed' && b.snapAnim <= 0) continue;
      if (b.state === 'pool' && b.body.isSleeping()) continue;

      const t = b.body.translation();
      const r = b.body.rotation();
      let yOff = 0;
      if (b.snapAnim > 0) {
        b.snapAnim = Math.max(0, b.snapAnim - dt * 8.5);
        yOff = Math.sin(b.snapAnim * Math.PI) * (BRICK_H * 0.14);
      }
      b.mesh.position.set(t.x, t.y + yOff, t.z);
      b.mesh.quaternion.set(r.x, r.y, r.z, r.w);

      if (t.y < -6) {
        const fallbackTray = this.trays[b.trayIndex] ?? this.trays[0];
        b.body.setTranslation(
          { x: fallbackTray.cx, y: TRAY_FLOOR_TOP + BRICK_H * 8, z: fallbackTray.cz },
          true
        );
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.8) {
      const fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
      this.callbacks.onFps?.(fps);
    }

    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  };

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.frameId);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);

    const canvas = this.renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener('pointerdown', this.boundPointerDown);
      canvas.removeEventListener('pointermove', this.boundPointerMove);
      canvas.removeEventListener('pointerup', this.boundPointerUp);
      canvas.removeEventListener('pointercancel', this.boundPointerUp);
    }
    window.removeEventListener('blur', this.boundBlur);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('resize', this.boundResize);

    for (const map of [
      this.baseMaterials,
      this.placedMaterials,
      this.hoverPoolMaterials,
      this.hoverPressedMaterials,
    ]) {
      for (const m of map.values()) m.dispose();
      map.clear();
    }
    this.bricks = [];
    this.controls?.dispose();
    this.pmremEnv?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      canvas?.parentNode?.removeChild(canvas);
    }
  }
}
