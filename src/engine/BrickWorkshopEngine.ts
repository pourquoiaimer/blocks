import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  BRICK_H,
  CELL,
  SHAPES,
  W,
  assignSortedPouches,
  bboxOf,
  buildPlan,
  rotCells,
  worldCells,
} from './brickPlanner';
import { brickGeometry } from './brickGeometry';
import { playClick, setAudioEnabled } from './audio';
import { setHapticsEnabled, triggerHaptic } from './haptics';
import { createRoomDiorama, type RoomDioramaController } from './roomDiorama';
import { createProductBoxTexture } from './boxArtwork';
import { DEFAULT_TRAY_NAMES } from '../services/storage';
import type {
  BrickModel,
  ColorDef,
  FeelSettings,
  InteractionMode,
  MaterialFinish,
  PlanBrick,
  PouchSpec,
  RoomTimeOfDay,
  SavedBrickRecord,
  ShapeKey,
  SpecialBrickSpec,
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
  pad: 'main' | 'sub';
  offset: THREE.Vector3;
  mountedOnStand?: boolean;
  logicalGx?: number;
  logicalGz?: number;
  logicalLayer?: number;
  logicalRot?: number;
}

interface TrayZone {
  index: number;
  kind: 'small' | 'deep';
  name: string;
  softCap: number;
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
  miniMeshes: THREE.Mesh[];
}

export interface EngineCallbacks {
  onSnapshot: (snap: WorkshopHudSnapshot) => void;
  onFps?: (fps: number) => void;
  onAutoSave: (records: SavedBrickRecord[], openedPacks: boolean[], boxOpened: boolean) => void;
  onTrayNamesChange?: (names: string[]) => void;
  onAutoAnimalTidy?: (strayCount: number) => void;
  onContextLost: () => void;
}

interface UndoBrickEntry {
  id: number;
  state: 'pool' | 'placed' | 'pressed';
  pad: 'main' | 'sub';
  rot: number;
  gx: number;
  gz: number;
  layer: number;
  pos: [number, number, number];
  quat: [number, number, number, number];
  mountedOnStand?: boolean;
}

const MAX_UNDO = 15;
const TRAY_FLOOR_TOP = 0.24;
const BUILD_TOP_Y = 0.12;
const FINGER_R = CELL * 0.8;
const TOUCH_HOLD_NDC_OFFSET_Y = 0.08;

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
    const param = ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
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
  private pouches: PouchSpec[] = [];
  private initialTrayNames: string[];
  private feel: FeelSettings;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private world!: RAPIER.World;
  private pmremEnv: THREE.Texture | null = null;
  private hemiLight!: THREE.HemisphereLight;
  private keyLight!: THREE.DirectionalLight;
  private rimLight!: THREE.DirectionalLight;
  private roomDiorama: RoomDioramaController | null = null;
  private curtainOpen = true;
  private timeOfDay: RoomTimeOfDay = 'day';

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
  private brickMeshes: THREE.Mesh[] = [];
  private seq = 0;
  private uf = new Map<BrickInstance, BrickInstance>();
  private boxOpened = false;
  private boxOpening = false;
  private boxOpenAnim = 0;
  private openedPacks: boolean[] = [];
  private packTrayMap: (number | null)[] = [];

  private trays: TrayZone[] = [];
  private deepTrayIndex = 3;
  private activeTray = 0;
  private viewKey: 'build' | 'wide' | 'tray' | 'subpad' = 'build';
  private overflowNotice: { message: string; id: number } | null = null;
  private overflowNoticeSeq = 0;
  private overflowNoticeTimer: number | null = null;
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
  private subX0 = 0;
  private subZ0 = 0;
  private subPadCx = 0;
  private subPadCz = 0;
  private boardW = 16;
  private boardD = 12;

  private subAssemblyEnabled = false;
  private subPadGroup!: THREE.Group;
  private subPadCollider!: RAPIER.Collider;

  private raycaster = new THREE.Raycaster();
  private ghostMat!: THREE.MeshBasicMaterial;
  private ghostMesh!: THREE.Mesh;
  private multiGhostGroup = new THREE.Group();
  private dropLine!: THREE.Mesh;
  private dropRing!: THREE.Mesh;
  private guideGroup = new THREE.Group();
  private currentGuideBricks: PlanBrick[] = [];

  // 3D 商品展示箱、堆疊待拆零件袋（袋內緊密顯示積木，無物理碰撞）& 傾倒動畫
  private boxGroup: THREE.Group | null = null;
  private boxLidPivot: THREE.Group | null = null;
  private boxPouchesGroup: THREE.Group | null = null;
  private boxArtworkTex: THREE.CanvasTexture | null = null;
  private waitingPouches = new Map<number, THREE.Group>();
  private activePour: ActivePour | null = null;
  private autoTidyCheckAcc = 0;
  private straySettleSec = 0;
  private autoTidyCooldown = 0;

  private standMountGroup: THREE.Group | null = null;
  private standCradleHitMesh: THREE.Mesh | null = null;
  private standMounted = false;
  private downOnStand = false;

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
  private snapPad: 'main' | 'sub' = 'main';
  private snapGx = 0;
  private snapGz = 0;
  private snapY = BUILD_TOP_Y;
  private singlePluckMode = false;
  private interactionMode: InteractionMode = 'grab';
  private lastRattleMs = 0;
  private fingerPrevPos = new THREE.Vector3();
  private finderHighlightTimer: number | null = null;
  private finderHighlighted = new Set<BrickInstance>();
  private fireworkParticles: {
    mesh: THREE.Mesh;
    vel: THREE.Vector3;
    spin: THREE.Vector3;
    life: number;
    maxLife: number;
  }[] = [];
  private fireworkGeo: THREE.BoxGeometry | null = null;
  private fireworkMats: THREE.MeshBasicMaterial[] = [];
  private fireworkTimers: number[] = [];

  private activePointers = new Map<number, { x: number; y: number }>();
  private downScreen = { x: 0, y: 0 };
  private downWasPlaced = false;
  private downOnTrayFloor: number | null = null;
  private downOnPouch: number | null = null;
  private downOnBox = false;
  private dragMoved = false;
  private lastPointerType: 'mouse' | 'touch' | 'pen' = 'mouse';
  private tapPickedThisGesture = false;
  private tapPlacePending = false;
  private secondTapCandidate: { id: number; startX: number; startY: number; startMs: number } | null = null;
  private autoFollowedOnHeld = false;

  private undoStack: UndoBrickEntry[][] = [];
  private pendingUndoSnapshot: UndoBrickEntry[] | null = null;

  private fpsAcc = 0;
  private fpsFrames = 0;
  private lastMatchedIndices: number[] = [];
  private lastSubMatchedIndices: number[] = [];
  private mainAlignment: { rot: number; dx: number; dz: number } = { rot: 0, dx: 0, dz: 0 };
  private subAlignment: { rot: number; dx: number; dz: number } = { rot: 0, dx: 0, dz: 0 };
  private pickupOrigin: { pad: 'main' | 'sub'; gx: number; gz: number; layer: number } | null = null;
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
    options?: { isSandbox?: boolean; sandboxPalette?: ColorDef[]; trayNames?: string[] }
  ) {
    this.container = container;
    this.model = model;
    this.feel = { ...feel };
    this.callbacks = callbacks;
    this.isSandbox = Boolean(options?.isSandbox);
    this.palette = [...(this.isSandbox && options?.sandboxPalette ? options.sandboxPalette : model.palette)];
    this.plan = this.isSandbox ? [] : buildPlan(model);
    this.pouches = this.isSandbox ? [] : assignSortedPouches(this.plan, this.palette);
    this.openedPacks = this.isSandbox ? [] : this.pouches.map(() => false);
    this.packTrayMap = this.isSandbox ? [] : this.pouches.map(() => null);
    this.initialTrayNames =
      options?.trayNames && options.trayNames.length >= 4
        ? options.trayNames.slice(0, 4)
        : [...DEFAULT_TRAY_NAMES];
    this.boxOpened = this.isSandbox;
    this.boardW = model.board.w;
    this.boardD = model.board.d;
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
      this.lastPointerType = 'touch';
    }
    setAudioEnabled(this.feel.soundEnabled);
    setHapticsEnabled(this.feel.hapticsEnabled);
  }

  async init(
    savedBricks?: SavedBrickRecord[],
    savedOpenedPacks?: boolean[],
    savedBoxOpened?: boolean
  ): Promise<void> {
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
    this.renderer.toneMappingExposure = 0.88;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.35));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

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
    this.scene.background = new THREE.Color(0x14100d);
    this.scene.fog = new THREE.Fog(0x14100d, 38, 78);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmremEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.pmremEnv;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();

    this.initMaterialLibrary();
    this.setupPhysicsAndEnvironment();
    this.setupLighting();
    this.setupGuides();
    this.setupStandMountProp();

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 140);
    const buildView = this.getViewPreset('build');
    this.camera.position.copy(buildView.pos);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(buildView.tgt);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = 1.50;
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
      this.boxOpened = savedBoxOpened ?? true;
      this.restoreSavedBricks(savedBricks, savedOpenedPacks);
      if (this.boxOpened) this.refreshWaitingPouch();
    } else if (this.isSandbox) {
      // 無盡自由模式開局桌面保持淨空，由玩家選色號、調色盤與形狀下單訂購零件
      this.boxOpened = true;
    } else if (savedBoxOpened) {
      this.boxOpened = true;
      if (savedOpenedPacks && savedOpenedPacks.length === this.openedPacks.length) {
        this.openedPacks = [...savedOpenedPacks];
      }
      this.refreshWaitingPouch();
    } else {
      // 開局先呈現未拆封的「整箱積木大盒」，由玩家點擊開箱、自由選包與選籃倒入
      this.boxOpened = false;
      this.setupBoxVisual();
    }

    if (!this.isSoftwareGl) {
      // Pre-compile all brick material variants at startup so first pack/hover/snap never hitches
      const warmGroup = new THREE.Group();
      const warmGeo = brickGeometry('1x1').geo;
      for (const map of [
        this.baseMaterials,
        this.placedMaterials,
        this.hoverPoolMaterials,
        this.hoverPressedMaterials,
      ]) {
        for (const mat of map.values()) {
          const m = new THREE.Mesh(warmGeo, mat);
          m.castShadow = true;
          m.receiveShadow = true;
          m.position.set(0, -100, 0);
          warmGroup.add(m);
        }
      }
      this.scene.add(warmGroup);
      this.renderer.compile(this.scene, this.camera);
      this.scene.remove(warmGroup);
    }

    this.emitSnapshot();
    this.clock.start();
    this.tick();
  }

  private createColorMaterialSet(idx: number, def: ColorDef): void {
    const hex = def.hex ?? 0xeceff2;
    const finish: MaterialFinish = def.finish ?? (def.transparent ? 'glass' : 'plastic');
    const isTrans = finish === 'glass' || Boolean(def.transparent);
    const isMetallic = finish === 'metallic' && !isTrans;
    const isMatte = finish === 'matte' && !isTrans;
    const isDark = !isTrans && hex < 0x353535;

    const roughness = isTrans
      ? 0.10
      : isMetallic
        ? 0.22
        : isMatte
          ? 0.86
          : isDark
            ? 0.46
            : 0.34;
    const metalness = isTrans
      ? 0.08
      : isMetallic
        ? 0.82
        : isMatte
          ? 0.01
          : 0.03;
    const envMapIntensity = isTrans
      ? 0.78
      : isMetallic
        ? (this.isSoftwareGl ? 0.65 : 1.05)
        : isMatte
          ? 0.18
          : (this.isSoftwareGl ? 0.25 : 0.40);
    const baseOpacity = def.opacity ?? 0.44;

    const makeMat = (emissive: number, opacityBoost = 1): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({
        color: hex,
        roughness,
        metalness,
        envMapIntensity,
        emissive,
        transparent: isTrans,
        opacity: isTrans ? Math.min(0.88, baseOpacity * opacityBoost) : 1,
        depthWrite: !isTrans,
      });

    this.baseMaterials.set(idx, makeMat(0x000000, 1));
    this.placedMaterials.set(idx, makeMat(0x0c141a, 1.12));
    this.hoverPoolMaterials.set(idx, makeMat(0x163848, 1.28));
    this.hoverPressedMaterials.set(idx, makeMat(0x1e4366, 1.32));
  }

  private initMaterialLibrary(): void {
    this.palette.forEach((def, idx) => {
      this.createColorMaterialSet(idx, def);
    });
  }

  public addSandboxColor(
    hex: number,
    name: string,
    transparent = false,
    finish?: MaterialFinish
  ): number {
    const resolvedFinish: MaterialFinish = finish ?? (transparent ? 'glass' : 'plastic');
    const resolvedTrans = transparent || resolvedFinish === 'glass';
    const existingIdx = this.palette.findIndex(
      c =>
        c.hex === hex &&
        Boolean(c.transparent) === resolvedTrans &&
        (c.finish ?? (c.transparent ? 'glass' : 'plastic')) === resolvedFinish
    );
    if (existingIdx >= 0) return existingIdx;

    const idx = this.palette.length;
    const def: ColorDef = {
      code: 'C' + (idx + 1),
      name: name || (resolvedTrans ? '透明玻璃' : '自訂色'),
      hex,
      finish: resolvedFinish,
      transparent: resolvedTrans,
      opacity: resolvedTrans ? 0.44 : undefined,
    };
    this.palette.push(def);
    this.createColorMaterialSet(idx, def);
    return idx;
  }

  public getPalette(): ColorDef[] {
    return [...this.palette];
  }

  private getMaterialForBrick(b: BrickInstance, hoverMode: 'none' | 'pool' | 'pressed'): THREE.MeshStandardMaterial {
    if (hoverMode === 'pressed') {
      return this.hoverPressedMaterials.get(b.colorIdx) ?? this.baseMaterials.get(0)!;
    }
    if (hoverMode === 'pool' || this.finderHighlighted.has(b)) {
      return this.hoverPoolMaterials.get(b.colorIdx) ?? this.baseMaterials.get(0)!;
    }
    if (b.state === 'placed') {
      return this.placedMaterials.get(b.colorIdx) ?? this.baseMaterials.get(0)!;
    }
    return this.baseMaterials.get(b.colorIdx) ?? this.baseMaterials.get(0)!;
  }

  private setupLighting(): void {
    this.hemiLight = new THREE.HemisphereLight(0xdbe8ff, 0x1e1610, 0.52);
    this.scene.add(this.hemiLight);
    this.keyLight = new THREE.DirectionalLight(0xfff4e4, 1.48);
    this.keyLight.position.set(this.padCx + 8, 18, this.padCz + 10);
    this.keyLight.target.position.set(this.padCx - 2, 0, this.padCz);
    this.scene.add(this.keyLight.target);

    this.keyLight.castShadow = !this.isSoftwareGl;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 48;
    this.keyLight.shadow.camera.left = -18;
    this.keyLight.shadow.camera.right = 18;
    this.keyLight.shadow.camera.top = 15;
    this.keyLight.shadow.camera.bottom = -15;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.018;
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0x98bfff, 0.36);
    this.rimLight.position.set(this.padCx - 14, 9, this.padCz - 10);
    this.scene.add(this.rimLight);
  }

  private setupPhysicsAndEnvironment(): void {
    this.world = new RAPIER.World({ x: 0, y: -28.0, z: 0 });
    this.world.timestep = 1 / 60;
    try {
      this.world.integrationParameters.numSolverIterations = 3;
    } catch {
      // ignore if unsupported
    }

    const BUILD = { x0: 0, z0: -4.8, w: this.boardW + 4, d: this.boardD + 4 };
    const uX0 = BUILD.x0 + (BUILD.w - this.boardW) / 2;
    const uZ0 = BUILD.z0 + (BUILD.d - this.boardD) / 2;
    this.bX0 = W(uX0);
    this.bZ0 = W(uZ0);
    this.padCx = this.bX0 + W(this.boardW) / 2;
    this.padCz = this.bZ0 + W(this.boardD) / 2;

    // 子區塊組裝台位於主組裝區右側
    this.subX0 = this.bX0 + W(this.boardW + 3);
    this.subZ0 = this.bZ0;
    this.subPadCx = this.subX0 + W(this.boardW) / 2;
    this.subPadCz = this.subZ0 + W(this.boardD) / 2;

    const deskMinX = -24.5;
    const deskMaxX = Math.max(this.subPadCx + W(this.boardW) * 0.5 + 8.0, 22.0);
    const deskMinZ = -13.2;
    const deskMaxZ = Math.max(9.8 + W(Math.max(0, this.boardD - 12)) * 0.5, 11.8);
    const deskW = deskMaxX - deskMinX;
    const deskD = deskMaxZ - deskMinZ;
    const deskCenterX = (deskMinX + deskMaxX) * 0.5;
    const deskCenterZ = (deskMinZ + deskMaxZ) * 0.5;

    const deskMat = new THREE.MeshStandardMaterial({
      color: 0x3b2a1e,
      roughness: 0.88,
      metalness: 0.02,
    });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(deskW, 0.6, deskD), deskMat);
    desk.position.set(deskCenterX, -0.3, deskCenterZ);
    desk.receiveShadow = true;
    this.scene.add(desk);

    for (let i = 0; i < 24; i++) {
      const y = 0.002 + i * 0.0004;
      const z = deskCenterZ - deskD / 2 + (i + 0.5) * (deskD / 24);
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(deskCenterX - deskW / 2, y, z),
        new THREE.Vector3(deskCenterX + deskW / 2, y, z),
      ]);
      this.scene.add(
        new THREE.Line(
          g,
          new THREE.LineBasicMaterial({ color: 0x4f3a29, transparent: true, opacity: 0.28 })
        )
      );
    }

    const deskBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(deskCenterX, -0.3, deskCenterZ)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(deskW / 2, 0.3, deskD / 2).setFriction(0.95).setRestitution(0),
      deskBody
    );

    // 房間書桌牆面、窗戶、可開關窗簾與窗外草原/夜晚場景
    this.roomDiorama = createRoomDiorama({
      windowCenterX: this.padCx,
      wallZ: -13.6,
      deskMinX,
      deskMaxX,
      isSoftwareGl: this.isSoftwareGl,
      onLightingMix: mix => {
        if (!this.scene) return;
        this.scene.background = new THREE.Color(mix.skyHex);
        if (this.scene.fog instanceof THREE.Fog) {
          this.scene.fog.color.setHex(mix.skyHex);
        }
        if (this.hemiLight) {
          this.hemiLight.color.setHex(mix.hemiSkyHex);
          this.hemiLight.groundColor.setHex(mix.hemiGroundHex);
          this.hemiLight.intensity = mix.hemiIntensity;
        }
        if (this.keyLight) {
          this.keyLight.color.setHex(mix.keyHex);
          this.keyLight.intensity = mix.keyIntensity;
        }
        if (this.rimLight) {
          this.rimLight.color.setHex(mix.rimHex);
          this.rimLight.intensity = mix.rimIntensity;
        }
        if (this.renderer) {
          this.renderer.toneMappingExposure = mix.exposure;
        }
      },
    });
    this.scene.add(this.roomDiorama.root);

    // 組裝墊（正中心）
    const padW = W(this.boardW) + CELL * 1.2;
    const padD = W(this.boardD) + CELL * 1.2;
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(padW, 0.08, padD),
      new THREE.MeshStandardMaterial({ color: 0x222933, roughness: 0.94, metalness: 0.02 })
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

    // 子區塊組裝台（可先於地面獨立拼裝頭部，再整塊合體）
    this.subPadGroup = new THREE.Group();
    const subPadMesh = new THREE.Mesh(
      new THREE.BoxGeometry(padW, 0.08, padD),
      new THREE.MeshStandardMaterial({ color: 0x353240, roughness: 0.92, metalness: 0.02 })
    );
    subPadMesh.position.set(this.subPadCx, BUILD_TOP_Y - 0.04, this.subPadCz);
    subPadMesh.receiveShadow = true;
    this.subPadGroup.add(subPadMesh);

    const subRim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(padW + 0.04, 0.09, padD + 0.04)),
      new THREE.LineBasicMaterial({ color: 0xf4c430, transparent: true, opacity: 0.65 })
    );
    subRim.position.set(this.subPadCx, BUILD_TOP_Y - 0.04, this.subPadCz);
    this.subPadGroup.add(subRim);

    const subGridMat = new THREE.LineBasicMaterial({ color: 0xf4c430, transparent: true, opacity: 0.25 });
    for (let i = 0; i <= this.boardW; i++) {
      this.subPadGroup.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(this.subX0 + W(i), BUILD_TOP_Y + 0.002, this.subZ0),
            new THREE.Vector3(this.subX0 + W(i), BUILD_TOP_Y + 0.002, this.subZ0 + W(this.boardD)),
          ]),
          subGridMat
        )
      );
    }
    for (let i = 0; i <= this.boardD; i++) {
      this.subPadGroup.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(this.subX0, BUILD_TOP_Y + 0.002, this.subZ0 + W(i)),
            new THREE.Vector3(this.subX0 + W(this.boardW), BUILD_TOP_Y + 0.002, this.subZ0 + W(i)),
          ]),
          subGridMat
        )
      );
    }
    this.subPadGroup.visible = false;
    this.scene.add(this.subPadGroup);

    const subPadBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(this.subPadCx, BUILD_TOP_Y - 0.04, this.subPadCz)
    );
    this.subPadCollider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(padW / 2, 0.04, padD / 2).setFriction(0.95).setRestitution(0),
      subPadBody
    );
    this.subPadCollider.setEnabled(false);

    // 3 個可命名桌邊小盤 + 1 個擺在更左側的大容量「地獄深籃」
    const traySpecs: Array<{
      x0: number;
      z0: number;
      w: number;
      d: number;
      kind: 'small' | 'deep';
      softCap: number;
    }> = [
      { x0: -7.2, z0: -2.4, w: 10, d: 10, kind: 'small', softCap: 22 },
      { x0: -7.2, z0: 3.8, w: 10, d: 10, kind: 'small', softCap: 22 },
      { x0: -13.4, z0: 3.8, w: 10, d: 10, kind: 'small', softCap: 22 },
      { x0: -22.2, z0: -3.2, w: 14, d: 16, kind: 'deep', softCap: 999 },
    ];
    const smallTrayMat = new THREE.MeshStandardMaterial({ color: 0x2a3442, roughness: 0.74, metalness: 0.08 });
    const deepFloorMat = new THREE.MeshStandardMaterial({ color: 0x1e2128, roughness: 0.85, metalness: 0.08 });
    const deepWallMat = new THREE.MeshStandardMaterial({ color: 0x443225, roughness: 0.68, metalness: 0.1 });
    const wt = CELL * 0.42;

    this.trays = [];
    this.deepTrayIndex = 3;
    for (let idx = 0; idx < traySpecs.length; idx++) {
      const spec = traySpecs[idx];
      const isDeep = spec.kind === 'deep';
      const wallH = isDeep ? CELL * 5.2 : CELL * 1.9;
      const wallThickness = isDeep ? CELL * 0.5 : wt;
      const floorMat = isDeep ? deepFloorMat : smallTrayMat;
      const wallMat = isDeep ? deepWallMat : smallTrayMat;
      const tw = W(spec.w);
      const td = W(spec.d);
      const cx = spec.x0 + tw / 2;
      const cz = spec.z0 + td / 2;

      const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(tw, 0.16, td), floorMat);
      floorMesh.position.set(cx, TRAY_FLOOR_TOP - 0.08, cz);
      floorMesh.receiveShadow = true;
      floorMesh.userData.trayIndex = idx;
      this.scene.add(floorMesh);

      const floorBody = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(cx, TRAY_FLOOR_TOP - 0.08, cz)
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(tw / 2, 0.08, td / 2).setFriction(0.85).setRestitution(0.08),
        floorBody
      );

      const walls = [
        { x: cx, z: cz + td / 2 + wallThickness / 2, hx: tw / 2 + wallThickness, hz: wallThickness / 2 },
        { x: cx, z: cz - td / 2 - wallThickness / 2, hx: tw / 2 + wallThickness, hz: wallThickness / 2 },
        { x: cx + tw / 2 + wallThickness / 2, z: cz, hx: wallThickness / 2, hz: td / 2 },
        { x: cx - tw / 2 - wallThickness / 2, z: cz, hx: wallThickness / 2, hz: td / 2 },
      ];
      for (const wall of walls) {
        const b = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(wall.x, wallH / 2 + TRAY_FLOOR_TOP, wall.z)
        );
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(wall.hx, wallH / 2, wall.hz).setFriction(0.35).setRestitution(0.05),
          b
        );
        const m = new THREE.Mesh(new THREE.BoxGeometry(wall.hx * 2, wallH, wall.hz * 2), wallMat);
        m.position.set(wall.x, wallH / 2 + TRAY_FLOOR_TOP, wall.z);
        m.castShadow = !this.isSoftwareGl;
        m.receiveShadow = true;
        this.scene.add(m);
      }

      const rimGeo = new THREE.EdgesGeometry(
        new THREE.BoxGeometry(tw + wallThickness * 2, wallH + 0.04, td + wallThickness * 2)
      );
      const rimMesh = new THREE.LineSegments(
        rimGeo,
        new THREE.LineBasicMaterial({
          color: isDeep ? 0xff9f43 : 0x7fe3ff,
          transparent: true,
          opacity: idx === this.activeTray ? 0.65 : isDeep ? 0.28 : 0.14,
        })
      );
      rimMesh.position.set(cx, wallH / 2 + TRAY_FLOOR_TOP, cz);
      this.scene.add(rimMesh);

      this.trays.push({
        index: idx,
        kind: spec.kind,
        name: this.initialTrayNames[idx] || DEFAULT_TRAY_NAMES[idx] || `盤 ${idx + 1}`,
        softCap: spec.softCap,
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

    // 手指翻找工具（實體碰撞球＋可視化外圈探頭）
    this.fingerBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 40, 0)
        .setGravityScale(0)
        .setLinearDamping(5)
        .setAngularDamping(8)
        .lockRotations()
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(FINGER_R * 1.15).setDensity(4.5).setFriction(0.12).setRestitution(0.05),
      this.fingerBody
    );
    this.fingerMesh = new THREE.Mesh(
      new THREE.SphereGeometry(FINGER_R * 0.95, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xf4c430,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
      })
    );
    const probeRing = new THREE.Mesh(
      new THREE.RingGeometry(FINGER_R * 1.15, FINGER_R * 1.45, 24),
      new THREE.MeshBasicMaterial({
        color: 0xf4c430,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    probeRing.rotation.x = -Math.PI / 2;
    probeRing.position.y = -FINGER_R * 0.55;
    this.fingerMesh.add(probeRing);
    this.fingerMesh.visible = false;
    this.scene.add(this.fingerMesh);
  }

  private setupGuides(): void {
    this.ghostMat = new THREE.MeshBasicMaterial({
      color: 0x6cf0a8,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ghostMesh = new THREE.Mesh(brickGeometry('1x1').geo, this.ghostMat);
    this.ghostMesh.visible = false;
    this.ghostMesh.renderOrder = 10;
    this.scene.add(this.ghostMesh);

    this.multiGhostGroup.visible = false;
    this.multiGhostGroup.renderOrder = 10;
    this.scene.add(this.multiGhostGroup);

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

  private disposeGroupOwnedResources(group: THREE.Object3D): void {
    group.traverse(obj => {
      if (obj instanceof THREE.Mesh && obj.userData.ownedDisposable) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material?.dispose();
        }
      }
    });
  }

  private setupBoxVisual(): void {
    if (this.boxGroup) {
      this.disposeGroupOwnedResources(this.boxGroup);
      this.scene.remove(this.boxGroup);
      this.boxGroup = null;
    }
    this.boxArtworkTex?.dispose();
    this.boxArtworkTex = null;

    const maxAniso = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
    const artTex = createProductBoxTexture(this.model, this.plan, maxAniso);
    this.boxArtworkTex = artTex;

    const group = new THREE.Group();
    const bw = 5.4;
    const bh = 1.95;
    const bd = 4.0;

    const boxSideMat = new THREE.MeshStandardMaterial({
      color: 0x162436,
      roughness: 0.45,
      metalness: 0.06,
    });
    const innerMat = new THREE.MeshStandardMaterial({
      color: 0x202733,
      roughness: 0.9,
    });
    const artMat = new THREE.MeshStandardMaterial({
      map: artTex,
      roughness: 0.34,
      metalness: 0.05,
    });
    const goldTrimMat = new THREE.MeshStandardMaterial({
      color: 0xf4c430,
      roughness: 0.36,
      metalness: 0.25,
    });

    // 商品外盒底部與四壁
    const floor = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.14, bd), boxSideMat);
    floor.position.set(0, 0.07, 0);
    floor.receiveShadow = true;
    floor.userData.isBrickBox = true;
    floor.userData.ownedDisposable = true;
    group.add(floor);

    const wallT = 0.14;
    const walls: [number, number, number, number, number, number][] = [
      [0, bh / 2, bd / 2 - wallT / 2, bw, bh, wallT],
      [0, bh / 2, -bd / 2 + wallT / 2, bw, bh, wallT],
      [-bw / 2 + wallT / 2, bh / 2, 0, wallT, bh, bd - wallT * 2],
      [bw / 2 - wallT / 2, bh / 2, 0, wallT, bh, bd - wallT * 2],
    ];
    walls.forEach(([x, y, z, w, h, d]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), boxSideMat);
      m.position.set(x, y, z);
      m.castShadow = !this.isSoftwareGl;
      m.receiveShadow = true;
      m.userData.isBrickBox = true;
      m.userData.ownedDisposable = true;
      group.add(m);
    });

    // 盒子正面也印上同一套商品彩圖縮圖條
    const frontPrint = new THREE.Mesh(new THREE.PlaneGeometry(bw - 0.24, bh - 0.28), artMat);
    frontPrint.position.set(0, bh * 0.5, bd * 0.5 + 0.01);
    frontPrint.userData.isBrickBox = true;
    frontPrint.userData.ownedDisposable = true;
    group.add(frontPrint);

    const cavity = new THREE.Mesh(new THREE.BoxGeometry(bw - 0.32, 0.1, bd - 0.32), innerMat);
    cavity.position.set(0, 0.16, 0);
    cavity.userData.isBrickBox = true;
    cavity.userData.ownedDisposable = true;
    group.add(cavity);

    // 盒內多包積木袋（掀開盒蓋時冒出來）
    const pouchesGroup = new THREE.Group();
    const packCount = Math.min(8, Math.max(1, this.pouches.length));
    for (let i = 0; i < packCount; i++) {
      const { group: pg } = this.buildPouchVisual(i);
      pg.scale.setScalar(0.52);
      const frac = packCount === 1 ? 0 : (i / (packCount - 1) - 0.5) * 3.1;
      pg.position.set(frac, 0.96, (i % 2 === 0 ? -1 : 1) * 0.45);
      pg.rotation.set(-0.6, (i - packCount * 0.5) * 0.14, (i % 2 === 0 ? 1 : -1) * 0.08);
      pg.traverse(obj => {
        obj.userData.isBrickBox = true;
      });
      pouchesGroup.add(pg);
    }
    group.add(pouchesGroup);
    this.boxPouchesGroup = pouchesGroup;

    // 樂高商品盒掀蓋上蓋（以後緣為轉軸掀開，頂面印有要拼的模型彩繪貼圖）
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, bh, -bd * 0.5);

    const lidSlab = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.08, 0.12, bd + 0.08), boxSideMat);
    lidSlab.position.set(0, 0.06, bd * 0.5);
    lidSlab.castShadow = !this.isSoftwareGl;
    lidSlab.userData.isBrickBox = true;
    lidSlab.userData.ownedDisposable = true;
    lidPivot.add(lidSlab);

    const lidArtwork = new THREE.Mesh(new THREE.PlaneGeometry(bw - 0.04, bd - 0.04), artMat);
    lidArtwork.rotation.x = -Math.PI * 0.5;
    lidArtwork.position.set(0, 0.125, bd * 0.5);
    lidArtwork.userData.isBrickBox = true;
    lidArtwork.userData.ownedDisposable = true;
    lidPivot.add(lidArtwork);

    const frontSeal = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.18, 0.06), goldTrimMat);
    frontSeal.position.set(0, -0.02, bd + 0.04);
    frontSeal.userData.isBrickBox = true;
    frontSeal.userData.ownedDisposable = true;
    lidPivot.add(frontSeal);

    group.add(lidPivot);
    this.boxLidPivot = lidPivot;

    group.position.set(this.padCx, BUILD_TOP_Y + 0.01, this.padCz);
    this.scene.add(group);
    this.boxGroup = group;
  }

  private pickBrickBox(): boolean {
    if (!this.boxGroup || this.boxOpened || this.boxOpening) return false;
    this.raycaster.setFromCamera(_ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.boxGroup, true);
    return hits.length > 0;
  }

  public openBox(instant = false): void {
    if (this.boxOpened || this.boxOpening) return;
    if (instant) {
      if (this.boxGroup) {
        this.disposeGroupOwnedResources(this.boxGroup);
        this.scene.remove(this.boxGroup);
        this.boxGroup = null;
      }
      this.boxLidPivot = null;
      this.boxPouchesGroup = null;
      this.boxArtworkTex?.dispose();
      this.boxArtworkTex = null;
      this.boxOpened = true;
      this.boxOpening = false;
      this.refreshWaitingPouch();
      this.scheduleAutoSave();
      this.emitSnapshot();
      return;
    }

    if (!this.boxGroup) {
      this.setupBoxVisual();
    }
    this.boxOpening = true;
    this.boxOpenAnim = 0;
    playClick('box');
    triggerHaptic('box');
    this.emitSnapshot();
  }

  private updateBoxOpening(dt: number): void {
    if (!this.boxOpening || !this.boxGroup) return;
    this.boxOpenAnim += dt;
    const dur = 0.92;
    const k = Math.min(1, this.boxOpenAnim / dur);

    // 前半段商品盒蓋往後掀開，袋子稍微浮起展示
    const flapK = Math.min(1, k / 0.5);
    const flapEase = 1 - Math.pow(1 - flapK, 3);
    if (this.boxLidPivot) {
      this.boxLidPivot.rotation.x = -flapEase * 1.92;
    }

    if (this.boxPouchesGroup) {
      const popK = Math.max(0, Math.min(1, (k - 0.18) / 0.5));
      this.boxPouchesGroup.position.y = Math.sin(popK * Math.PI * 0.5) * 1.25;
    }

    // 後半段商品盒滑開淡出，將分裝袋擺在主視角與窗戶之間的桌面區域
    if (k > 0.62) {
      const slideK = (k - 0.62) / 0.38;
      this.boxGroup.position.z = this.padCz - slideK * 4.8;
      this.boxGroup.position.y = BUILD_TOP_Y + 0.01 + slideK * 1.3;
      this.boxGroup.scale.setScalar(Math.max(0.05, 1 - slideK * 0.78));
    }

    if (k >= 1) {
      this.disposeGroupOwnedResources(this.boxGroup);
      this.scene.remove(this.boxGroup);
      this.boxGroup = null;
      this.boxLidPivot = null;
      this.boxPouchesGroup = null;
      this.boxArtworkTex?.dispose();
      this.boxArtworkTex = null;
      this.boxOpening = false;
      this.boxOpened = true;
      this.refreshWaitingPouch();
      this.scheduleAutoSave();
      this.emitSnapshot();
    }
  }

  private buildPouchVisual(packIdx: number): {
    group: THREE.Group;
    tearStrip: THREE.Mesh;
    bagBody: THREE.Mesh;
    miniMeshes: THREE.Mesh[];
  } {
    const group = new THREE.Group();
    const specs = this.plan.filter(p => p.packIndex === packIdx);
    const pouchMeta = this.pouches[packIdx];
    const mainColorHex = this.palette[pouchMeta?.colorIdx ?? 0]?.hex ?? 0x7fe3ff;

    // 袋內緊密堆疊「該袋實際所有積木」純視覺網格（零物理碰撞，直到撕開倒出才建立剛體）
    const count = Math.max(1, specs.length);
    const cols = Math.min(3, Math.max(2, Math.ceil(Math.sqrt(count * 0.65))));
    const pitchX = 0.52;
    const pitchY = 0.34;
    const pitchZ = 0.38;
    const perLayer = cols * 2;
    const rows = Math.max(1, Math.ceil(count / cols));

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const miniMeshes: THREE.Mesh[] = [];

    specs.forEach((spec, idx) => {
      const col = idx % cols;
      const depthLayer = Math.floor(idx / cols) % 2;
      const row = Math.floor(idx / perLayer);
      const px = (col - (cols - 1) * 0.5) * pitchX + ((row % 2) - 0.5) * 0.08;
      const py = -0.35 + row * pitchY;
      const pz = (depthLayer - 0.5) * pitchZ;

      const miniMat = this.baseMaterials.get(spec.color) ?? this.baseMaterials.get(0)!;
      const mini = new THREE.Mesh(brickGeometry(spec.shape).geo, miniMat);
      mini.scale.setScalar(0.46);
      mini.position.set(px, py, pz);
      mini.rotation.set(
        ((idx * 17) % 5) * 0.14 - 0.25,
        ((idx * 31) % 7) * 0.32,
        ((idx * 13) % 4) * 0.12 - 0.18
      );
      mini.userData.pouchPackIdx = packIdx;
      group.add(mini);
      miniMeshes.push(mini);

      minX = Math.min(minX, px - 0.38);
      maxX = Math.max(maxX, px + 0.38);
      minY = Math.min(minY, py - 0.28);
      maxY = Math.max(maxY, py + 0.28);
      minZ = Math.min(minZ, pz - 0.26);
      maxZ = Math.max(maxZ, pz + 0.26);
    });

    if (specs.length === 0) {
      minX = -0.7;
      maxX = 0.7;
      minY = -0.7;
      maxY = 0.7;
      minZ = -0.3;
      maxZ = 0.3;
    }

    const bagW = Math.max(1.35, maxX - minX + 0.22);
    const bagH = Math.max(1.35, maxY - minY + 0.42 + rows * 0.04);
    const bagD = Math.max(0.72, maxZ - minZ + 0.22);
    const centerY = (minY + maxY) * 0.5 + 0.08;

    const bagMat = new THREE.MeshStandardMaterial({
      color: 0xecf5ff,
      roughness: 0.2,
      metalness: 0.06,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    const bagBody = new THREE.Mesh(new THREE.BoxGeometry(bagW, bagH, bagD), bagMat);
    bagBody.position.set(0, centerY, 0);
    bagBody.renderOrder = 4;
    bagBody.userData.pouchPackIdx = packIdx;
    bagBody.userData.ownedDisposable = true;
    group.add(bagBody);

    // 袋口壓封撕開條（以該袋主色標記，方便桌面辨識）
    const stripMat = new THREE.MeshStandardMaterial({
      color: mainColorHex === 0x22262b ? 0x7fe3ff : mainColorHex,
      roughness: 0.38,
      metalness: 0.1,
    });
    const tearStrip = new THREE.Mesh(new THREE.BoxGeometry(bagW + 0.08, 0.18, bagD + 0.06), stripMat);
    tearStrip.position.set(0, centerY + bagH * 0.5 + 0.06, 0);
    tearStrip.userData.pouchPackIdx = packIdx;
    tearStrip.userData.ownedDisposable = true;
    group.add(tearStrip);

    return { group, tearStrip, bagBody, miniMeshes };
  }

  private refreshWaitingPouch(): void {
    for (const grp of this.waitingPouches.values()) {
      this.disposeGroupOwnedResources(grp);
      this.scene.remove(grp);
    }
    this.waitingPouches.clear();

    if (this.isSandbox || !this.boxOpened) return;

    const unopenedIndices: number[] = [];
    for (let i = 0; i < this.pouches.length; i++) {
      if (!this.openedPacks[i] && this.activePour?.packIdx !== i) {
        unopenedIndices.push(i);
      }
    }
    if (unopenedIndices.length === 0) return;

    // 擺放在主視角組裝區與正前方窗戶之間的書桌空位，可稍微交錯堆疊 2~3 層、壓低高度不遮擋窗景
    const baseCols = Math.min(7, Math.max(4, Math.ceil(unopenedIndices.length / 2.5)));
    const spanW = 16.5;
    const startX = this.padCx - spanW * 0.5;
    const stepX = baseCols > 1 ? spanW / (baseCols - 1) : 0;

    unopenedIndices.forEach((pIdx, slot) => {
      const col = slot % baseCols;
      const depthBand = Math.floor(slot / baseCols) % 2;
      const stackLevel = Math.floor(slot / (baseCols * 2));
      const { group } = this.buildPouchVisual(pIdx);
      group.scale.setScalar(0.76);
      group.position.set(
        startX + col * stepX + ((stackLevel % 2) - 0.5) * 0.42 + ((col % 3) - 1) * 0.12,
        0.34 + stackLevel * 0.42,
        -4.55 - depthBand * 1.95 - stackLevel * 0.25
      );
      group.rotation.set(
        -1.26 + (stackLevel % 2) * 0.06,
        ((slot * 37) % 7 - 3) * 0.1,
        ((slot * 19) % 5 - 2) * 0.07
      );
      this.scene.add(group);
      this.waitingPouches.set(pIdx, group);
    });
  }

  /**
   * 視角預設：以「組裝區正中心」或「子區塊組裝台正中心」為 OrbitControls 核心軸點
   */
  private getViewPreset(key: 'build' | 'wide' | 'tray' | 'subpad'): { pos: THREE.Vector3; tgt: THREE.Vector3 } {
    const w = this.container.clientWidth || window.innerWidth || 1024;
    const h = this.container.clientHeight || window.innerHeight || 768;
    const aspect = w / Math.max(1, h);
    const mobileScale = aspect < 1.05 ? 1.32 : aspect < 1.35 ? 1.14 : 1.0;

    const tray = this.trays[this.activeTray] ?? this.trays[0];

    const layerCount = this.isSandbox ? 5 : Math.max(2, this.model.masks.length);
    const boardFactor = Math.max(1.0, this.boardW / 18, this.boardD / 12);
    const buildMidY = Math.max(0.55, Math.min(3.4, layerCount * BRICK_H * 0.36));
    const tallFactor = Math.max(1.0, Math.min(1.32, (0.88 + layerCount * 0.025) * boardFactor));

    if (key === 'build') {
      return {
        tgt: new THREE.Vector3(this.padCx - 0.5, buildMidY, this.padCz),
        pos: new THREE.Vector3(
          this.padCx - 2.6 * mobileScale * tallFactor,
          (13.2 * tallFactor) * mobileScale,
          this.padCz + (15.4 * tallFactor) * mobileScale
        ),
      };
    }
    if (key === 'subpad') {
      return {
        tgt: new THREE.Vector3(this.subPadCx, 1.0, this.subPadCz),
        pos: new THREE.Vector3(
          this.subPadCx - 1.8 * mobileScale,
          14.6 * mobileScale,
          this.subPadCz + 15.6 * mobileScale
        ),
      };
    }
    if (key === 'tray' && tray) {
      if (tray.kind === 'deep') {
        return {
          tgt: new THREE.Vector3(tray.cx + 0.2, 0.9, tray.cz),
          pos: new THREE.Vector3(tray.cx + 1.6, 16.4 * mobileScale, tray.cz + 11.4 * mobileScale),
        };
      }
      return {
        tgt: new THREE.Vector3(tray.cx + 0.4, 0.5, tray.cz),
        pos: new THREE.Vector3(tray.cx + 1.5, 11.4 * mobileScale, tray.cz + 10.2 * mobileScale),
      };
    }

    const minX = this.trays.reduce((m, t) => Math.min(m, t.cx), -10);
    const maxX = this.subAssemblyEnabled ? this.subPadCx + 2.5 : this.padCx + 2.5;
    const midX = (minX + maxX) / 2;
    return {
      tgt: new THREE.Vector3(midX, 0.9, (this.padCz + (tray?.cz ?? 0)) * 0.4 - 0.8),
      pos: new THREE.Vector3(
        midX,
        (this.subAssemblyEnabled ? 24.5 : 21.5) * mobileScale,
        (this.subAssemblyEnabled ? 25.5 : 22.8) * mobileScale
      ),
    };
  }

  public switchView(next?: 'build' | 'wide' | 'tray' | 'subpad'): void {
    if (next) {
      this.viewKey = next;
    } else {
      if (this.viewKey === 'build') {
        this.viewKey = this.subAssemblyEnabled ? 'subpad' : 'wide';
      } else if (this.viewKey === 'subpad') {
        this.viewKey = 'wide';
      } else if (this.viewKey === 'wide' && this.trays.length > 1) {
        this.viewKey = 'tray';
      } else {
        this.viewKey = 'build';
      }
    }
    this.tweenCameraTo(this.getViewPreset(this.viewKey));
    this.emitSnapshot();
  }

  public focusBuildArea(): void {
    const targetView: 'build' | 'subpad' = this.subAssemblyEnabled ? 'subpad' : 'build';
    this.viewKey = targetView;
    this.tweenCameraTo(this.getViewPreset(targetView));
    this.emitSnapshot();
  }

  public orbitStep(dir: -1 | 1): void {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const angle = dir * (Math.PI / 4);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const nx = offset.x * cos - offset.z * sin;
    const nz = offset.x * sin + offset.z * cos;
    offset.x = nx;
    offset.z = nz;
    this.tweenCameraTo({ pos: target.clone().add(offset), tgt: target });
    triggerHaptic('rot');
  }

  public setSubAssemblyMode(on: boolean): void {
    if (this.isSandbox || !this.model.subAssemblies || this.model.subAssemblies.length < 2) return;
    this.subAssemblyEnabled = on;
    const hasBricksOnSub = this.bricks.some(
      b => b.pad === 'sub' && (b.state === 'placed' || b.state === 'pressed')
    );
    this.subPadGroup.visible = on || hasBricksOnSub;
    this.subPadCollider.setEnabled(on || hasBricksOnSub);
    if (on) {
      this.viewKey = 'subpad';
      this.tweenCameraTo(this.getViewPreset('subpad'));
    } else if (this.viewKey === 'subpad') {
      this.viewKey = 'build';
      this.tweenCameraTo(this.getViewPreset('build'));
    }
    this.emitSnapshot();
  }

  public focusTray(trayIdx: number, moveCamera = true): void {
    const clamped = Math.max(0, Math.min(this.trays.length - 1, trayIdx));
    this.activeTray = clamped;
    this.trays.forEach((t, i) => {
      const mat = t.rimMesh.material as THREE.LineBasicMaterial;
      mat.opacity = i === clamped ? 0.65 : 0.14;
    });
    if (moveCamera) {
      this.viewKey = 'tray';
      this.tweenCameraTo(this.getViewPreset('tray'));
    }
    this.refreshWaitingPouch();
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

  private rotToYawRad(rot: number): number {
    return -(rot * Math.PI) / 180;
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
    const colDef = this.palette[colorIdx];
    const isTrans = colDef?.finish === 'glass' || Boolean(colDef?.transparent);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !this.isSoftwareGl && !isTrans;
    mesh.receiveShadow = !isTrans;
    if (isTrans) mesh.renderOrder = 3;
    this.scene.add(mesh);

    const cells = SHAPES[shapeKey].cells;
    const bb = bboxOf(cells);
    const cx = bb.w / 2;
    const cz = bb.d / 2;
    const yaw = this.rotToYawRad(rot);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({
          x: 0,
          y: Math.sin(yaw / 2),
          z: 0,
          w: Math.cos(yaw / 2),
        })
        .setLinearDamping(0.06)
        .setAngularDamping(0.35)
        .setCcdEnabled(enableCcd)
    );
    const colliders: RAPIER.Collider[] = [];
    for (const [x, z] of cells) {
      colliders.push(
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid((CELL / 2) * 0.97, BRICK_H / 2, (CELL / 2) * 0.97)
            .setTranslation(W(x + 0.5) - W(cx), 0, W(z + 0.5) - W(cz))
            .setDensity(0.85)
            .setFriction(0.65)
            .setRestitution(0.14),
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
      pad: 'main',
      offset: new THREE.Vector3(),
    };
    mesh.userData.brick = brick;
    this.bricks.push(brick);
    this.brickMeshes.push(mesh);
    return brick;
  }

  private setColliders(b: BrickInstance, on: boolean): void {
    for (const c of b.colliders) c.setEnabled(on);
  }

  private isInsideTray(wx: number, wz: number, tray: TrayZone): boolean {
    return (
      wx >= tray.x0 - 0.25 &&
      wx <= tray.x0 + tray.widthWorld + 0.25 &&
      wz >= tray.z0 - 0.25 &&
      wz <= tray.z0 + tray.depthWorld + 0.25
    );
  }

  private getPoolBricksInTray(trayIdx: number): BrickInstance[] {
    const tray = this.trays[trayIdx];
    if (!tray) return [];
    return this.bricks.filter(b => {
      if (b.state !== 'pool') return false;
      const t = b.body.translation();
      return this.isInsideTray(t.x, t.z, tray);
    });
  }

  private countStrayDeskBricks(): number {
    let stray = 0;
    for (const b of this.bricks) {
      if (b.state !== 'pool') continue;
      const t = b.body.translation();
      const v = b.body.linvel();
      if (t.y > 2.2 || Math.abs(v.y) > 1.8) continue;
      if (!this.trays.some(tr => this.isInsideTray(t.x, t.z, tr))) {
        stray++;
      }
    }
    return stray;
  }

  private triggerOverflowNotice(message: string): void {
    if (this.overflowNoticeTimer !== null) {
      window.clearTimeout(this.overflowNoticeTimer);
    }
    this.overflowNotice = { message, id: ++this.overflowNoticeSeq };
    this.overflowNoticeTimer = window.setTimeout(() => {
      this.overflowNotice = null;
      this.overflowNoticeTimer = null;
      if (!this.disposed) this.emitSnapshot();
    }, 3600);
  }

  /**
   * 拆包並以「撕開零件袋 -> 傾倒積木嘩啦啦掉進指定盤／籃」的物理動畫落盤
   * 小盤不自動轉進深籃，積木會真實堆疊並可能滿出桌面（進而自動觸發窗外動物進來幫忙整理），玩家也可手動倒進深籃
   */
  public openPack(packIdx: number, instant = false, targetTrayIdx?: number): void {
    if (this.isSandbox || this.openedPacks[packIdx]) return;
    if (!this.boxOpened) {
      this.openBox(true);
    }
    this.openedPacks[packIdx] = true;

    const specs = this.plan.filter(p => p.packIndex === packIdx);
    const chosenIdx =
      targetTrayIdx !== undefined
        ? Math.max(0, Math.min(this.trays.length - 1, targetTrayIdx))
        : this.activeTray;
    const chosenTray = this.trays[chosenIdx] ?? this.trays[0];
    const deepTray = this.trays[this.deepTrayIndex] ?? chosenTray;
    const currentCount = this.getPoolBricksInTray(chosenTray.index).length;
    const willOverflow =
      chosenTray.kind === 'small' &&
      deepTray !== chosenTray &&
      currentCount + specs.length > chosenTray.softCap;

    this.packTrayMap[packIdx] = chosenTray.index;
    this.activeTray = chosenTray.index;
    this.trays.forEach((t, i) => {
      (t.rimMesh.material as THREE.LineBasicMaterial).opacity =
        i === chosenTray.index ? 0.65 : t.kind === 'deep' ? 0.28 : 0.14;
    });

    if (willOverflow && !instant) {
      this.triggerOverflowNotice(
        `「${chosenTray.name}」快滿出來了！積木滾到桌上太多時，窗外小動物會自動進來幫你整理`
      );
    }

    if (instant) {
      specs.forEach((spec, k) => {
        const margin = W(1.1);
        const col = k % 5;
        const row = Math.floor(k / 5) % 6;
        const x =
          chosenTray.x0 +
          margin +
          ((col + 0.5) / 5) * Math.max(0.1, chosenTray.widthWorld - margin * 2) +
          (Math.random() - 0.5) * 0.25;
        const z =
          chosenTray.z0 +
          margin +
          ((row + 0.5) / 6) * Math.max(0.1, chosenTray.depthWorld - margin * 2) +
          (Math.random() - 0.5) * 0.25;
        const y = TRAY_FLOOR_TOP + BRICK_H * (1.2 + Math.floor(k / 16) * 1.1);
        const rot = [0, 90, 180, 270][Math.floor(Math.random() * 4)];
        this.createBrick(spec.shape, spec.color, { x, y, z }, rot, chosenTray.index, false);
      });
      this.refreshWaitingPouch();
      this.emitSnapshot();
      return;
    }

    if (this.activePour) {
      this.flushActivePour();
    }

    const existingPouch = this.waitingPouches.get(packIdx);
    if (existingPouch) {
      this.disposeGroupOwnedResources(existingPouch);
      this.scene.remove(existingPouch);
      this.waitingPouches.delete(packIdx);
    }

    const { group, tearStrip, bagBody, miniMeshes } = this.buildPouchVisual(packIdx);
    group.position.set(chosenTray.cx, TRAY_FLOOR_TOP + 4.3, chosenTray.cz - 0.3);
    this.scene.add(group);

    const shuffled = [...specs].sort(() => Math.random() - 0.5);
    this.activePour = {
      packIdx,
      tray: chosenTray,
      items: shuffled.map((s, idx) => ({
        shape: s.shape,
        color: s.color,
        trayIndex: chosenTray.index,
        slotIdx: idx,
      })),
      elapsed: 0,
      spawnAccum: 0,
      spawnedCount: 0,
      pouchGroup: group,
      tearStrip,
      bagBody,
      miniMeshes,
    };

    this.viewKey = 'tray';
    this.tweenCameraTo(this.getViewPreset('tray'));
    playClick('pick');
    this.emitSnapshot();
  }

  public openAllRemainingIntoTray(targetTrayIdx: number): void {
    if (this.isSandbox) return;
    if (!this.boxOpened) this.openBox(true);
    const remaining = this.openedPacks
      .map((opened, idx) => (opened ? -1 : idx))
      .filter(idx => idx >= 0);
    if (remaining.length === 0) return;

    for (let i = 0; i < remaining.length - 1; i++) {
      this.openPack(remaining[i], true, targetTrayIdx);
    }
    this.openPack(remaining[remaining.length - 1], false, targetTrayIdx);
    this.scheduleAutoSave();
  }

  private flushActivePour(): void {
    const pour = this.activePour;
    if (!pour) return;
    while (pour.spawnedCount < pour.items.length) {
      this.spawnPourBrick(pour, pour.items[pour.spawnedCount]);
      pour.spawnedCount++;
    }
    this.disposeGroupOwnedResources(pour.pouchGroup);
    this.scene.remove(pour.pouchGroup);
    this.activePour = null;
    this.refreshWaitingPouch();
    this.scheduleAutoSave();
    this.emitSnapshot();
  }

  private spawnPourBrick(pour: ActivePour, item: PourItem): void {
    const tray = this.trays[item.trayIndex] ?? pour.tray;
    const margin = W(1.1);
    const angle = item.slotIdx * 2.39996;
    const radius = Math.min(1, Math.sqrt((item.slotIdx % 25) / 25)) * 0.44;
    const x =
      tray.cx + Math.cos(angle) * (tray.widthWorld - margin * 2) * radius;
    const z =
      tray.cz + Math.sin(angle) * (tray.depthWorld - margin * 2) * radius;
    const y = TRAY_FLOOR_TOP + (tray.kind === 'deep' ? 4.4 : 3.4) + (item.slotIdx % 4) * 0.32;
    const rot = [0, 90, 180, 270][Math.floor(Math.random() * 4)];
    const b = this.createBrick(item.shape, item.color, { x, y, z }, rot, tray.index, false);
    b.body.setLinvel(
      {
        x: (Math.random() - 0.5) * 3.0,
        y: -7.5 - Math.random() * 3.0,
        z: (Math.random() - 0.5) * 3.0,
      },
      true
    );
    b.body.setAngvel(
      {
        x: (Math.random() - 0.5) * 7,
        y: (Math.random() - 0.5) * 8,
        z: (Math.random() - 0.5) * 7,
      },
      true
    );
  }

  private updateActivePour(dt: number): void {
    const pour = this.activePour;
    if (!pour) return;
    pour.elapsed += dt;

    if (pour.elapsed < 0.14) {
      const k = pour.elapsed / 0.14;
      pour.tearStrip.position.x = k * 1.3;
      pour.tearStrip.position.y = pour.tearStrip.position.y + dt * 2.4;
      pour.tearStrip.rotation.z = -k * 0.55;
      return;
    }

    pour.tearStrip.visible = false;
    const pourTime = pour.elapsed - 0.14;
    const tilt = Math.min(1, pourTime / 0.14);
    pour.pouchGroup.rotation.z = tilt * Math.PI * 0.88;
    pour.pouchGroup.position.x = pour.tray.cx + Math.sin(pourTime * 9.5) * 1.15;
    pour.pouchGroup.position.z = pour.tray.cz + Math.cos(pourTime * 6.8) * 1.05;

    const interval = 0.022;
    if (pour.spawnedCount < pour.items.length) {
      pour.spawnAccum += dt;
      while (pour.spawnAccum >= interval && pour.spawnedCount < pour.items.length) {
        pour.spawnAccum -= interval;
        this.spawnPourBrick(pour, pour.items[pour.spawnedCount]);
        const mini = pour.miniMeshes[pour.spawnedCount];
        if (mini) mini.visible = false;
        if (pour.spawnedCount % 3 === 0) playClick('pour');
        pour.spawnedCount++;
      }
      return;
    }

    // 倒完最後一顆後，袋子立即淡出並徹底移除消失
    for (const m of pour.miniMeshes) m.visible = false;
    const endK = Math.min(1, (pourTime - pour.items.length * interval) / 0.15);
    pour.pouchGroup.position.y += dt * 4.5;
    (pour.bagBody.material as THREE.MeshStandardMaterial).opacity = Math.max(0, 0.42 * (1 - endK));
    if (endK >= 1) {
      this.disposeGroupOwnedResources(pour.pouchGroup);
      this.scene.remove(pour.pouchGroup);
      this.activePour = null;
      this.refreshWaitingPouch();
      this.scheduleAutoSave();
      this.emitSnapshot();
    }
  }

  /**
   * 從「地獄深籃」倒出一批積木到指定的小盤子裡
   */
  public pourFromDeepToTray(targetSmallIdx: number, maxBatch = 10): number {
    const deep = this.trays[this.deepTrayIndex];
    const target = this.trays[targetSmallIdx];
    if (!deep || !target || target.kind !== 'small') return 0;

    const candidates = this.getPoolBricksInTray(deep.index);
    if (candidates.length === 0) {
      this.triggerOverflowNotice(`${deep.name} 目前是空的喔`);
      this.emitSnapshot();
      return 0;
    }

    const currentInSmall = this.getPoolBricksInTray(target.index).length;
    const room = Math.max(0, target.softCap - currentInSmall);
    if (room <= 0) {
      this.triggerOverflowNotice(`${target.name} 已滿（上限 ${target.softCap} 顆），先挑走一些或倒回深籃`);
      this.emitSnapshot();
      return 0;
    }

    const takeCount = Math.min(maxBatch, room, candidates.length);
    // 優先抓取表層的隨機混雜積木（保留真實撈出感）
    candidates.sort((a, b) => b.body.translation().y - a.body.translation().y);
    const chosen = candidates.slice(0, takeCount);

    this.pushUndoSnapshot(this.captureUndoSnapshot());
    const margin = W(1.2);
    chosen.forEach((b, k) => {
      const x = target.x0 + margin + Math.random() * Math.max(0.1, target.widthWorld - margin * 2);
      const z = target.z0 + margin + Math.random() * Math.max(0.1, target.depthWorld - margin * 2);
      const y = TRAY_FLOOR_TOP + 2.8 + k * 0.34;
      b.trayIndex = target.index;
      b.body.wakeUp();
      b.body.setTranslation({ x, y, z }, true);
      b.body.setLinvel({ x: (Math.random() - 0.5) * 2.2, y: -4.2, z: (Math.random() - 0.5) * 2.2 }, true);
      b.body.setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 }, true);
    });

    playClick('pour');
    triggerHaptic('shake');
    this.scheduleAutoSave();
    this.emitSnapshot();
    return chosen.length;
  }

  /**
   * 將某個小盤裡的全部積木倒回「地獄深籃」
   */
  public dumpTrayToDeep(sourceIdx: number): number {
    const src = this.trays[sourceIdx];
    const deep = this.trays[this.deepTrayIndex];
    if (!src || !deep || src.index === deep.index) return 0;

    const list = this.getPoolBricksInTray(src.index);
    if (list.length === 0) return 0;

    this.pushUndoSnapshot(this.captureUndoSnapshot());
    const margin = W(1.5);
    list.forEach((b, k) => {
      const x = deep.x0 + margin + Math.random() * Math.max(0.1, deep.widthWorld - margin * 2);
      const z = deep.z0 + margin + Math.random() * Math.max(0.1, deep.depthWorld - margin * 2);
      const y = TRAY_FLOOR_TOP + 4.4 + (k % 6) * 0.42;
      b.trayIndex = deep.index;
      b.body.wakeUp();
      b.body.setTranslation({ x, y, z }, true);
      b.body.setLinvel({ x: (Math.random() - 0.5) * 2.8, y: -5.5, z: (Math.random() - 0.5) * 2.8 }, true);
      b.body.setAngvel({ x: (Math.random() - 0.5) * 7, y: (Math.random() - 0.5) * 7, z: (Math.random() - 0.5) * 7 }, true);
    });

    playClick('pour');
    triggerHaptic('shake');
    this.scheduleAutoSave();
    this.emitSnapshot();
    return list.length;
  }

  public renameTray(trayIdx: number, nextName: string): void {
    const t = this.trays[trayIdx];
    if (!t) return;
    const cleaned = nextName.trim().slice(0, 12);
    if (!cleaned) return;
    t.name = cleaned;
    this.callbacks.onTrayNamesChange?.(this.trays.map(tr => tr.name));
    this.emitSnapshot();
  }

  /**
   * 窗外動物幫忙整理：把散落桌面的積木與爆滿小盤溢出的零件平均撥進深籃與空餘盤子（不做顏色分類）
   */
  public tidyOverflowWithAnimal(): number {
    const deep = this.trays[this.deepTrayIndex] ?? this.trays[0];
    const smalls = this.trays.filter(t => t.kind === 'small');
    const toMove: BrickInstance[] = [];

    for (const b of this.bricks) {
      if (b.state !== 'pool') continue;
      const t = b.body.translation();
      if (!this.trays.some(tr => this.isInsideTray(t.x, t.z, tr))) {
        toMove.push(b);
      }
    }
    for (const s of smalls) {
      const inSmall = this.getPoolBricksInTray(s.index);
      if (inSmall.length > s.softCap) {
        toMove.push(...inSmall.slice(s.softCap));
      }
    }

    if (toMove.length === 0) return 0;
    this.pushUndoSnapshot(this.captureUndoSnapshot());

    toMove.forEach((b, k) => {
      const dest = k % 4 === 0 && smalls.length > 0
        ? smalls[k % smalls.length]
        : deep;
      const tray = dest.kind === 'small' && this.getPoolBricksInTray(dest.index).length >= dest.softCap
        ? deep
        : dest;
      const margin = W(Math.max(1.3, Math.max(b.bb.w, b.bb.d) * 0.55));
      const x = tray.x0 + margin + Math.random() * Math.max(0.1, tray.widthWorld - margin * 2);
      const z = tray.z0 + margin + Math.random() * Math.max(0.1, tray.depthWorld - margin * 2);
      const y = TRAY_FLOOR_TOP + 3.2 + (k % 5) * 0.4;
      b.trayIndex = tray.index;
      b.body.wakeUp();
      b.body.setTranslation({ x, y, z }, true);
      b.body.setLinvel({ x: 0, y: -3.2, z: 0 }, true);
    });

    playClick('pour');
    triggerHaptic('box');
    this.scheduleAutoSave();
    this.emitSnapshot();
    return toMove.length;
  }

  public playAnimalTidyAnimation(): void {
    this.roomDiorama?.triggerTidyAnimation(this.timeOfDay);
  }

  public setCurtainOpen(open: boolean): void {
    this.curtainOpen = open;
    this.roomDiorama?.setCurtainOpen(open);
    this.emitSnapshot();
  }

  public setTimeOfDay(tod: RoomTimeOfDay): void {
    this.timeOfDay = tod;
    this.roomDiorama?.setTimeOfDay(tod);
    this.emitSnapshot();
  }

  /**
   * 撥開／搖晃目前籃子裡的積木，讓壓在底下的零件翻出來
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
            x: dx * 0.9 + (Math.random() - 0.5) * 5.8,
            y: (tray.kind === 'deep' ? 4.8 : 3.6) + Math.random() * 2.6,
            z: dz * 0.9 + (Math.random() - 0.5) * 5.8,
          },
          true
        );
        b.body.setAngvel(
          {
            x: (Math.random() - 0.5) * 7,
            y: (Math.random() - 0.5) * 9,
            z: (Math.random() - 0.5) * 7,
          },
          true
        );
        stirred++;
      }
    }
    if (stirred > 0) {
      playClick('rattle');
      playClick('shake');
      triggerHaptic('shake');
    }
  }

  public setInteractionMode(mode: InteractionMode): void {
    if (this.interactionMode === mode) return;
    if (mode === 'rummage' && this.held) {
      this.returnHeldToTray();
    }
    this.interactionMode = mode;
    this.singlePluckMode = mode === 'separator';
    triggerHaptic('pick');
    this.emitSnapshot();
  }

  public highlightCurrentStepParts(): number {
    if (this.isSandbox || this.currentGuideBricks.length === 0) return 0;
    if (this.finderHighlightTimer !== null) {
      window.clearTimeout(this.finderHighlightTimer);
      this.finderHighlightTimer = null;
    }
    for (const b of this.finderHighlighted) {
      b.mesh.material = this.getMaterialForBrick(b, 'none');
    }
    this.finderHighlighted.clear();

    const matchedSet = new Set(this.lastMatchedIndices);
    const subMatchedSet = new Set(this.lastSubMatchedIndices);
    const needed = new Map<string, number>();
    for (const p of this.currentGuideBricks) {
      if (matchedSet.has(p.index) || subMatchedSet.has(p.index)) continue;
      const key = `${p.shape}:${p.color}`;
      needed.set(key, (needed.get(key) ?? 0) + 1);
    }

    let found = 0;
    for (const b of this.bricks) {
      if (b.state !== 'pool') continue;
      const key = `${b.shapeKey}:${b.colorIdx}`;
      const rem = needed.get(key) ?? 0;
      if (rem > 0) {
        needed.set(key, rem - 1);
        this.finderHighlighted.add(b);
        b.mesh.material = this.getMaterialForBrick(b, 'pool');
        b.body.wakeUp();
        b.body.setLinvel({ x: (Math.random() - 0.5) * 1.4, y: 3.4, z: (Math.random() - 0.5) * 1.4 }, true);
        found++;
      }
    }

    if (found > 0) {
      playClick('pick');
      this.finderHighlightTimer = window.setTimeout(() => {
        for (const b of this.finderHighlighted) {
          b.mesh.material = this.getMaterialForBrick(b, 'none');
        }
        this.finderHighlighted.clear();
        this.finderHighlightTimer = null;
      }, 2200);
    }
    return found;
  }

  public spawnSandboxBrick(shape: ShapeKey, colorIdx: number, count = 4): void {
    this.orderSandboxBatch([{ shape, colorIdx, qty: count }]);
  }

  public orderSandboxBatch(
    items: Array<{ shape: ShapeKey; colorIdx: number; qty: number }>
  ): number {
    const validItems = items.filter(it => it.qty > 0);
    if (validItems.length === 0) return 0;

    const totalQty = validItems.reduce((sum, it) => sum + it.qty, 0);
    const chosen = this.trays[this.activeTray] ?? this.trays[0];
    const deep = this.trays[this.deepTrayIndex] ?? chosen;
    const current = this.getPoolBricksInTray(chosen.index).length;
    if (chosen.kind === 'small' && deep !== chosen && current + totalQty > chosen.softCap) {
      this.triggerOverflowNotice(
        `「${chosen.name}」已超過 ${chosen.softCap} 顆，滿出來掉到桌上太多時動物會進來整理！`
      );
    }

    let dropIdx = 0;
    for (const item of validItems) {
      const bb = bboxOf(SHAPES[item.shape].cells);
      const margin = W(Math.max(1.15, Math.max(bb.w, bb.d) * 0.56));
      for (let k = 0; k < item.qty; k++) {
        const x = chosen.x0 + margin + Math.random() * Math.max(0.05, chosen.widthWorld - margin * 2);
        const z = chosen.z0 + margin + Math.random() * Math.max(0.05, chosen.depthWorld - margin * 2);
        const y = TRAY_FLOOR_TOP + BRICK_H * (2.2 + (dropIdx % 10) * 0.75) + 0.45;
        const rot = [0, 90, 180, 270][Math.floor(Math.random() * 4)];
        this.createBrick(item.shape, item.colorIdx, { x, y, z }, rot, chosen.index);
        dropIdx++;
      }
    }

    playClick('pour');
    triggerHaptic('shake');
    this.scheduleAutoSave();
    this.emitSnapshot();
    return totalQty;
  }

  private restoreSavedBricks(records: SavedBrickRecord[], savedOpened?: boolean[]): void {
    if (savedOpened && savedOpened.length === this.openedPacks.length) {
      this.openedPacks = [...savedOpened];
    } else if (records.length > 0 && this.pouches.length > 0) {
      // 兼容舊版分包數量變更：依已存在的形狀與顏色數量自動推斷已拆袋子
      const have = new Map<string, number>();
      for (const r of records) {
        const key = `${r.shape}:${r.color}`;
        have.set(key, (have.get(key) ?? 0) + 1);
      }
      this.pouches.forEach((p, idx) => {
        const specs = this.plan.filter(x => x.packIndex === p.index);
        const allFound = specs.every(sp => {
          const k = `${sp.shape}:${sp.color}`;
          const c = have.get(k) ?? 0;
          if (c > 0) {
            have.set(k, c - 1);
            return true;
          }
          return false;
        });
        if (allFound) this.openedPacks[idx] = true;
      });
    }
    let anySub = false;
    let shouldMountOnStand = false;
    for (const rec of records) {
      const trayIdx = rec.trayIndex ?? 0;
      const inferredPad: 'main' | 'sub' =
        rec.pad ?? (rec.pos[0] >= this.subX0 - CELL ? 'sub' : 'main');
      const b = this.createBrick(
        rec.shape,
        rec.color,
        { x: rec.pos[0], y: rec.pos[1], z: rec.pos[2] },
        rec.rot,
        trayIdx
      );
      if (rec.state === 'pressed' || rec.state === 'placed') {
        if (inferredPad === 'sub') anySub = true;
        if (rec.gx !== undefined && rec.gz !== undefined) {
          const targetLayer = rec.layer ?? this.layerOfY(rec.pos[1]);
          const snappedY = this.yOfLayer(targetLayer);
          if (rec.state === 'pressed') {
            this.pressBrickAt(b, rec.gx, rec.gz, snappedY, inferredPad, true);
          } else {
            this.lightPlaceBrickAt(b, rec.gx, rec.gz, snappedY, inferredPad, true);
          }
          if (rec.mountedOnStand && this.model.standMount) {
            shouldMountOnStand = true;
          }
        }
      } else {
        b.body.setRotation(
          { x: rec.quat[0], y: rec.quat[1], z: rec.quat[2], w: rec.quat[3] },
          true
        );
      }
    }
    if (anySub) {
      this.subAssemblyEnabled = true;
      this.subPadGroup.visible = true;
      this.subPadCollider.setEnabled(true);
    }
    if (shouldMountOnStand && this.model.standMount) {
      this.mountCharacterOnStand(true);
    }
  }

  public exportRecords(): { records: SavedBrickRecord[]; openedPacks: boolean[] } {
    if (this.activePour) {
      this.flushActivePour();
    }
    const records: SavedBrickRecord[] = this.bricks.map(b => {
      const t = b.body.translation();
      const r = b.body.rotation();
      const st = b.state === 'held' ? 'pool' : b.state;
      let gx: number | undefined;
      let gz: number | undefined;
      let layer: number | undefined;
      let rot = b.rot;
      if (st !== 'pool') {
        if (b.mountedOnStand && b.logicalGx !== undefined && b.logicalGz !== undefined) {
          gx = b.logicalGx;
          gz = b.logicalGz;
          layer = b.logicalLayer ?? 0;
          rot = b.logicalRot ?? b.rot;
        } else {
          const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
          const ox = b.pad === 'sub' ? this.subX0 : this.bX0;
          const oz = b.pad === 'sub' ? this.subZ0 : this.bZ0;
          gx = Math.round((t.x - ox) / CELL - bb.w / 2);
          gz = Math.round((t.z - oz) / CELL - bb.d / 2);
          layer = this.layerOfY(t.y);
        }
      }
      return {
        shape: b.shapeKey,
        color: b.colorIdx,
        rot,
        state: st,
        gx,
        gz,
        layer,
        pos: [Number(t.x.toFixed(3)), Number(t.y.toFixed(3)), Number(t.z.toFixed(3))],
        quat: [
          Number(r.x.toFixed(4)),
          Number(r.y.toFixed(4)),
          Number(r.z.toFixed(4)),
          Number(r.w.toFixed(4)),
        ],
        trayIndex: b.trayIndex,
        pad: st === 'pool' ? undefined : b.pad,
        mountedOnStand: b.mountedOnStand || undefined,
      };
    });
    return { records, openedPacks: [...this.openedPacks] };
  }

  public updateFeel(next: FeelSettings): void {
    this.feel = { ...next };
    setAudioEnabled(this.feel.soundEnabled);
    setHapticsEnabled(this.feel.hapticsEnabled);
    this.refreshStepGuideMeshes();
    this.emitSnapshot();
  }

  public getResolvedControlStyle(): 'drag' | 'tap' {
    if (this.feel.controlStyle === 'tap') return 'tap';
    if (this.feel.controlStyle === 'drag') return 'drag';
    return this.lastPointerType === 'touch' ? 'tap' : 'drag';
  }

  public setSinglePluckMode(on: boolean): void {
    this.singlePluckMode = on;
    if (on && this.interactionMode !== 'separator') {
      this.interactionMode = 'separator';
    } else if (!on && this.interactionMode === 'separator') {
      this.interactionMode = 'grab';
    }
    this.emitSnapshot();
  }

  public rotateHeld(): void {
    if (!this.held || this.heldGroup.length > 1) return;
    const b = this.held;
    b.rot = (b.rot + 90) % 360;
    b.bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
    const q = this.rotToYawRad(b.rot);
    b.body.setRotation({ x: 0, y: Math.sin(q / 2), z: 0, w: Math.cos(q / 2) }, true);
    this.ghostMesh.rotation.y = q;
    this.recomputeHeldSnap();
    playClick('rot');
    triggerHaptic('rot');
  }

  public returnHeldToTray(): void {
    if (!this.held) return;
    const g = this.heldGroup.length ? this.heldGroup : [this.held];
    const tray = this.trays[this.activeTray] ?? this.trays[0];
    const hadBoardBrick = this.pendingUndoSnapshot !== null && this.pickupOrigin !== null;
    if (hadBoardBrick && this.pendingUndoSnapshot) {
      this.pushUndoSnapshot(this.pendingUndoSnapshot);
    }
    this.pendingUndoSnapshot = null;

    g.forEach((b, idx) => {
      const margin = W(1.3);
      const x = tray.x0 + margin + Math.random() * Math.max(0.1, tray.widthWorld - margin * 2);
      const z = tray.z0 + margin + Math.random() * Math.max(0.1, tray.depthWorld - margin * 2);
      const y = TRAY_FLOOR_TOP + BRICK_H * (2.2 + idx * 0.7);
      this.setColliders(b, true);
      b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      b.body.setTranslation({ x, y, z }, true);
      b.body.setLinvel({ x: 0, y: -1.5, z: 0 }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.pad = 'main';
      b.trayIndex = tray.index;
      b.state = 'pool';
      b.cellsWorld = null;
      b.mesh.material = this.getMaterialForBrick(b, 'none');
    });

    this.held = null;
    this.heldGroup = [];
    this.pickupOrigin = null;
    this.snapValid = false;
    this.tapPickedThisGesture = false;
    this.tapPlacePending = false;
    this.autoFollowedOnHeld = false;
    this.ghostMesh.visible = false;
    this.multiGhostGroup.visible = false;
    this.hideDropGuide();
    playClick('place');
    triggerHaptic('place');
    this.scheduleAutoSave();
    this.emitSnapshot();
  }

  private captureUndoSnapshot(): UndoBrickEntry[] {
    return this.bricks.map(b => {
      const t = b.body.translation();
      const r = b.body.rotation();
      const st = b.state === 'held' ? 'pool' : b.state;
      const info = st === 'placed' || st === 'pressed' ? this.getBrickGridInfo(b, b.pad) : null;
      return {
        id: b.id,
        state: st,
        pad: b.pad,
        rot: b.mountedOnStand ? (b.logicalRot ?? b.rot) : b.rot,
        gx: info?.gx ?? 0,
        gz: info?.gz ?? 0,
        layer: info?.layer ?? 0,
        pos: [t.x, t.y, t.z],
        quat: [r.x, r.y, r.z, r.w],
        mountedOnStand: b.mountedOnStand,
      };
    });
  }

  private pushUndoSnapshot(snap: UndoBrickEntry[]): void {
    this.undoStack.push(snap);
    if (this.undoStack.length > MAX_UNDO) {
      this.undoStack.shift();
    }
  }

  private snapshotsEqual(a: UndoBrickEntry[], b: UndoBrickEntry[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (x.state !== y.state || Boolean(x.mountedOnStand) !== Boolean(y.mountedOnStand)) return false;
      if (x.state !== 'pool') {
        if (x.pad !== y.pad || x.gx !== y.gx || x.gz !== y.gz || x.layer !== y.layer || x.rot !== y.rot) {
          return false;
        }
      }
    }
    return true;
  }

  public undoLastAction(): boolean {
    if (this.undoStack.length === 0) return false;
    if (this.held) {
      this.held = null;
      this.heldGroup = [];
      this.pickupOrigin = null;
      this.pendingUndoSnapshot = null;
      this.snapValid = false;
      this.tapPickedThisGesture = false;
      this.tapPlacePending = false;
      this.ghostMesh.visible = false;
      this.multiGhostGroup.visible = false;
      this.hideDropGuide();
    }

    const snap = this.undoStack.pop()!;
    const byId = new Map(this.bricks.map(b => [b.id, b]));
    this.uf.clear();
    this.standMounted = false;

    // 先放回 pool 積木，再依樓層由下往上恢復拼妥積木
    const boardEntries: UndoBrickEntry[] = [];
    let shouldReMount = false;
    for (const entry of snap) {
      const b = byId.get(entry.id);
      if (!b) continue;
      b.mountedOnStand = false;
      b.logicalGx = undefined;
      b.logicalGz = undefined;
      b.logicalLayer = undefined;
      b.logicalRot = undefined;
      if (entry.state === 'pool') {
        this.setColliders(b, true);
        b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        b.body.setTranslation({ x: entry.pos[0], y: entry.pos[1], z: entry.pos[2] }, true);
        b.body.setRotation(
          { x: entry.quat[0], y: entry.quat[1], z: entry.quat[2], w: entry.quat[3] },
          true
        );
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        b.rot = entry.rot;
        b.bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
        b.pad = 'main';
        b.state = 'pool';
        b.cellsWorld = null;
        b.snapAnim = 0;
        b.mesh.position.set(entry.pos[0], entry.pos[1], entry.pos[2]);
        b.mesh.quaternion.set(entry.quat[0], entry.quat[1], entry.quat[2], entry.quat[3]);
        b.mesh.material = this.getMaterialForBrick(b, 'none');
      } else {
        boardEntries.push(entry);
        if (entry.mountedOnStand) shouldReMount = true;
      }
    }

    boardEntries.sort((a, b) => a.layer - b.layer);
    for (const entry of boardEntries) {
      const b = byId.get(entry.id);
      if (!b) continue;
      b.rot = entry.rot;
      const y = this.yOfLayer(entry.layer);
      if (entry.state === 'pressed') {
        this.pressBrickAt(b, entry.gx, entry.gz, y, entry.pad, true);
      } else {
        this.lightPlaceBrickAt(b, entry.gx, entry.gz, y, entry.pad, true);
      }
    }
    if (shouldReMount && this.model.standMount) {
      this.mountCharacterOnStand(true);
    }

    playClick('pick');
    triggerHaptic('undo');
    this.scheduleAutoSave();
    this.emitSnapshot();
    return true;
  }

  public exportSandboxAsModel(customName = '我的自由積木作品'): BrickModel | null {
    const boardBricks = this.bricks
      .filter(b => b.pad === 'main' && (b.state === 'placed' || b.state === 'pressed'))
      .map(b => ({ b, info: this.getBrickGridInfo(b, 'main') }))
      .filter((x): x is { b: BrickInstance; info: NonNullable<ReturnType<BrickWorkshopEngine['getBrickGridInfo']>> } =>
        Boolean(x.info)
      );

    if (boardBricks.length === 0) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxLayer = 0;
    const usedColorSet = new Set<number>();

    for (const { b, info } of boardBricks) {
      usedColorSet.add(b.colorIdx);
      if (info.layer > maxLayer) maxLayer = info.layer;
      for (const [cx, cz] of info.cells) {
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cz < minZ) minZ = cz;
        if (cz > maxZ) maxZ = cz;
      }
    }

    const usedIndices = [...usedColorSet].slice(0, 10);
    const colorRemap = new Map<number, number>();
    const compactPalette: ColorDef[] = usedIndices.map((origIdx, newIdx) => {
      colorRemap.set(origIdx, newIdx);
      const src = this.palette[origIdx] ?? this.palette[0];
      return { ...src, code: String(newIdx + 1).padStart(2, '0') };
    });

    const w = Math.max(8, maxX - minX + 1);
    const d = Math.max(6, maxZ - minZ + 1);
    const grids = Array.from({ length: maxLayer + 1 }, () =>
      Array.from({ length: d }, () => Array<string>(w).fill('.'))
    );
    const specialBricks: SpecialBrickSpec[] = [];

    for (const { b, info } of boardBricks) {
      const mappedCol = colorRemap.get(b.colorIdx);
      if (mappedCol === undefined) continue;
      if (SHAPES[b.shapeKey].isSlope) {
        specialBricks.push({
          shape: b.shapeKey,
          rot: b.rot,
          color: mappedCol,
          gx: info.gx - minX,
          gz: info.gz - minZ,
          layer: info.layer,
        });
        continue;
      }
      for (const [cx, cz] of info.cells) {
        const lx = cx - minX;
        const lz = cz - minZ;
        if (lx >= 0 && lx < w && lz >= 0 && lz < d && grids[info.layer]?.[lz]) {
          grids[info.layer][lz][lx] = String(mappedCol);
        }
      }
    }

    const masks = grids.map(layer => layer.map(row => row.join('')));
    const mid = Math.max(0, Math.floor(masks.length / 2) - 1);
    const packs =
      masks.length > 4
        ? [
            { label: '第 1 包（下層）', maxLayer: mid, trayIndex: 0 },
            { label: '第 2 包（上層）', maxLayer: masks.length - 1, trayIndex: 1 },
          ]
        : [{ label: '第 1 包（全套零件）', maxLayer: masks.length - 1, trayIndex: 0 }];

    return {
      id: 'sandbox_share_' + Date.now().toString(36),
      name: customName.trim() || '我的自由積木作品',
      subtitle: '自由創作模式匯出作品',
      difficulty: masks.length >= 7 ? '進階' : masks.length >= 4 ? '標準' : '入門',
      palette: compactPalette,
      board: { w: Math.max(16, w + 4), d: Math.max(12, d + 4) },
      masks,
      specialBricks: specialBricks.length > 0 ? specialBricks : undefined,
      packs,
      isCustom: true,
    };
  }

  public setGuideBricks(stepBricks: PlanBrick[]): void {
    this.currentGuideBricks = stepBricks;
    this.refreshStepGuideMeshes();
  }

  private rotateGridCell(x: number, z: number, rot: number): [number, number] {
    const r = ((rot % 360) + 360) % 360;
    if (r === 0) return [x, z];
    if (r === 90) return [-z, x];
    if (r === 180) return [-x, -z];
    return [z, -x];
  }

  private transformPlanCell(
    x: number,
    z: number,
    align: { rot: number; dx: number; dz: number }
  ): [number, number] {
    const [rx, rz] = this.rotateGridCell(x, z, align.rot);
    return [rx + align.dx, rz + align.dz];
  }

  private layerOfY(y: number): number {
    return Math.max(0, Math.round((y - BUILD_TOP_Y) / BRICK_H - 0.5));
  }

  private yOfLayer(layer: number): number {
    return BUILD_TOP_Y + BRICK_H * (Math.max(0, layer) + 0.5);
  }

  private getBrickGridInfo(
    b: BrickInstance,
    pad: 'main' | 'sub'
  ): { gx: number; gz: number; layer: number; rot: number; cells: [number, number][] } | null {
    if (b.mountedOnStand && pad === 'main' && b.logicalGx !== undefined && b.logicalGz !== undefined) {
      const lRot = b.logicalRot ?? b.rot;
      const lLayer = b.logicalLayer ?? 0;
      const cells = rotCells(SHAPES[b.shapeKey].cells, lRot).map(
        ([cx, cz]) => [b.logicalGx! + cx, b.logicalGz! + cz] as [number, number]
      );
      return { gx: b.logicalGx, gz: b.logicalGz, layer: lLayer, rot: lRot, cells };
    }
    const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
    const ox = pad === 'sub' ? this.subX0 : this.bX0;
    const oz = pad === 'sub' ? this.subZ0 : this.bZ0;
    const t = b.body.translation();
    const gx = Math.round((t.x - ox) / CELL - bb.w / 2);
    const gz = Math.round((t.z - oz) / CELL - bb.d / 2);
    const layer = Math.round((t.y - BUILD_TOP_Y) / BRICK_H - 0.5);
    if (layer < 0 || gx < 0 || gz < 0 || gx + bb.w > this.boardW || gz + bb.d > this.boardD) {
      return null;
    }
    if (Math.abs(t.x - (ox + W(gx + bb.w / 2))) > CELL * 0.45) return null;
    if (Math.abs(t.z - (oz + W(gz + bb.d / 2))) > CELL * 0.45) return null;
    if (Math.abs(t.y - this.yOfLayer(layer)) > BRICK_H * 0.45) return null;
    const cells = rotCells(SHAPES[b.shapeKey].cells, b.rot).map(
      ([cx, cz]) => [gx + cx, gz + cz] as [number, number]
    );
    return { gx, gz, layer, rot: b.rot, cells };
  }

  private getOccupiedVoxels(pad: 'main' | 'sub', ignoreIds?: Set<number>): Set<string> {
    const occ = new Set<string>();
    for (const o of this.bricks) {
      if (ignoreIds?.has(o.id)) continue;
      if (o.pad !== pad) continue;
      if (o.state !== 'placed' && o.state !== 'pressed') continue;
      const info = this.getBrickGridInfo(o, pad);
      if (!info) continue;
      for (const [cx, cz] of info.cells) {
        occ.add(`${cx},${info.layer},${cz}`);
      }
    }
    return occ;
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
    const subMatchedSet = new Set(this.lastSubMatchedIndices);
    const activeSub = this.getUpperSubAssembly();

    for (const p of this.currentGuideBricks) {
      if (matchedSet.has(p.index) || subMatchedSet.has(p.index)) continue;
      const onSub = Boolean(this.subAssemblyEnabled && activeSub && p.layer >= activeSub.startLayer);
      const ox = onSub ? this.subX0 : this.bX0;
      const oz = onSub ? this.subZ0 : this.bZ0;
      const localLayer = onSub && activeSub ? p.layer - activeSub.startLayer : p.layer;
      const align = onSub ? this.subAlignment : this.mainAlignment;

      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const c of p.cells) {
        const [x, z] = c.split(',').map(Number);
        const [tx, tz] = this.transformPlanCell(x, z, align);
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (tz < minZ) minZ = tz;
        if (tz > maxZ) maxZ = tz;
      }
      if (minX < 0 || minZ < 0 || maxX >= this.boardW || maxZ >= this.boardD) continue;

      const bw = maxX - minX + 1;
      const bd = maxZ - minZ + 1;
      const wx = ox + W(minX + bw / 2);
      const wz = oz + W(minZ + bd / 2);
      const y = this.yOfLayer(localLayer);
      const colHex = this.palette[p.color]?.hex ?? 0x7fe3ff;

      const geo = new THREE.EdgesGeometry(brickGeometry(p.shape).geo, 26);
      const mat = new THREE.LineBasicMaterial({
        color: colHex === 0x22262b ? 0x7fe3ff : colHex,
        transparent: true,
        opacity: 0.62,
      });
      const wire = new THREE.LineSegments(geo, mat);
      wire.position.set(wx, y, wz);
      wire.rotation.y = this.rotToYawRad((p.rot + align.rot) % 360);
      wire.scale.setScalar(0.99);
      this.guideGroup.add(wire);
    }
  }

  public autoBuildAll(): number {
    if (this.isSandbox) return 0;
    this.pushUndoSnapshot(this.captureUndoSnapshot());
    if (this.standMounted) {
      this.unmountCharacterFromStand(true);
    }
    for (let i = 0; i < this.openedPacks.length; i++) {
      this.openPack(i, true);
    }

    // 確認目前玩家對齊座標是否整組都在底板範圍內；若在範圍內就沿著玩家目前方位接續完成
    const alignFits = this.plan.every(p =>
      p.cells.every(c => {
        const [x, z] = c.split(',').map(Number);
        const [tx, tz] = this.transformPlanCell(x, z, this.mainAlignment);
        return tx >= 0 && tz >= 0 && tx < this.boardW && tz < this.boardD;
      })
    );
    const align = alignFits ? this.mainAlignment : { rot: 0, dx: 0, dz: 0 };
    const occ = this.getOccupiedVoxels('main');

    let built = 0;
    for (const p of this.plan) {
      if (this.lastMatchedIndices.includes(p.index)) continue;
      let minX = Infinity;
      let minZ = Infinity;
      let blocked = false;
      for (const c of p.cells) {
        const [x, z] = c.split(',').map(Number);
        const [tx, tz] = this.transformPlanCell(x, z, align);
        if (tx < minX) minX = tx;
        if (tz < minZ) minZ = tz;
        if (occ.has(`${tx},${p.layer},${tz}`)) blocked = true;
      }
      if (blocked) continue;
      const b = this.bricks.find(
        x => x.state === 'pool' && x.colorIdx === p.color && x.shapeKey === p.shape
      );
      if (!b) continue;
      b.rot = (p.rot + align.rot) % 360;
      this.pressBrickAt(b, minX, minZ, this.yOfLayer(p.layer), 'main', true);
      for (const c of worldCells(b.shapeKey, b.rot, minX, minZ)) {
        const [cx, cz] = c.split(',');
        occ.add(`${cx},${p.layer},${cz}`);
      }
      built++;
    }
    if (this.model.standMount) {
      this.mountCharacterOnStand(true);
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
    if (this.brickMeshes.length === 0) return null;
    this.raycaster.setFromCamera(_ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.brickMeshes, false);
    return hits.length ? (hits[0].object.userData.brick as BrickInstance) : null;
  }

  private pickWaitingPouch(): number | null {
    if (this.waitingPouches.size === 0) return null;
    this.raycaster.setFromCamera(_ndc, this.camera);
    const groups = [...this.waitingPouches.values()];
    const hits = this.raycaster.intersectObjects(groups, true);
    if (!hits.length) return null;
    const idx = hits[0].object.userData.pouchPackIdx;
    return typeof idx === 'number' ? idx : null;
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

  private pickStandMountProp(): boolean {
    if (!this.standMountGroup) return false;
    this.raycaster.setFromCamera(_ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.standMountGroup, true);
    return hits.length > 0;
  }

  /**
   * 針對支援「透明斜角展示支架」的模型（如踩到香蕉皮飛起來），
   * 在組裝墊左側直接生成內建式一體成型透明壓克力支架，不需玩家手動拼一堆透明磚。
   */
  private setupStandMountProp(): void {
    const rule = this.model.standMount;
    if (!rule || this.isSandbox) return;

    const modelH = this.model.masks[0]?.length ?? 8;
    const modelW = this.model.masks[0]?.[0]?.length ?? 12;
    const ofx = Math.floor((this.boardW - modelW) / 2);
    const ofz = Math.floor((this.boardD - modelH) / 2);

    const anchorX = this.bX0 + W(ofx + rule.standLocalGx);
    const anchorZ = this.bZ0 + W(ofz + rule.standLocalGz);
    const baseY = BUILD_TOP_Y + BRICK_H; // 立於人行道頂部 (layer 0 之上)
    const cradleY = this.yOfLayer(rule.standBaseYLayer) - BRICK_H * 0.42;

    const group = new THREE.Group();

    const acrylicMat = new THREE.MeshStandardMaterial({
      color: 0xb6e8ff,
      roughness: 0.1,
      metalness: 0.08,
      envMapIntensity: 0.85,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    const rimMat = new THREE.LineBasicMaterial({
      color: 0xdff6ff,
      transparent: true,
      opacity: 0.72,
    });

    const markOwned = (m: THREE.Object3D) => {
      m.userData.ownedDisposable = true;
      m.userData.isStandMount = true;
    };

    // 1. 底座固定盤 (2x2 格壓克力底座)
    const footGeo = new THREE.BoxGeometry(W(2.1), 0.14, W(2.1));
    const footMesh = new THREE.Mesh(footGeo, acrylicMat);
    footMesh.position.set(anchorX, baseY + 0.07, anchorZ);
    footMesh.renderOrder = 3;
    markOwned(footMesh);
    group.add(footMesh);

    const footEdge = new THREE.LineSegments(new THREE.EdgesGeometry(footGeo), rimMat);
    footEdge.position.copy(footMesh.position);
    markOwned(footEdge);
    group.add(footEdge);

    // 2. 斜向支撐透明柱（從底座斜向上支撐到展示托盤）
    const pStart = new THREE.Vector3(anchorX, baseY + 0.1, anchorZ);
    const pEnd = new THREE.Vector3(anchorX + 0.18, cradleY, anchorZ - 0.15);
    const strutVec = pEnd.clone().sub(pStart);
    const strutLen = strutVec.length();
    const strutGeo = new THREE.CylinderGeometry(0.16, 0.21, strutLen, 12);
    const strutMesh = new THREE.Mesh(strutGeo, acrylicMat);
    strutMesh.position.copy(pStart).addScaledVector(strutVec, 0.5);
    strutMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), strutVec.clone().normalize());
    strutMesh.renderOrder = 3;
    markOwned(strutMesh);
    group.add(strutMesh);

    // 3. 頂部斜角承托盤（與小人摔飛角度一致）
    const tiltQ = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(rule.tiltXDeg),
        0,
        THREE.MathUtils.degToRad(rule.tiltZDeg),
        'XYZ'
      )
    );
    const cradleGeo = new THREE.BoxGeometry(W(2.4), 0.14, W(2.0));
    const cradleMesh = new THREE.Mesh(cradleGeo, acrylicMat);
    cradleMesh.position.copy(pEnd);
    cradleMesh.quaternion.copy(tiltQ);
    cradleMesh.renderOrder = 3;
    markOwned(cradleMesh);
    group.add(cradleMesh);

    const cradleEdge = new THREE.LineSegments(new THREE.EdgesGeometry(cradleGeo), rimMat);
    cradleEdge.position.copy(pEnd);
    cradleEdge.quaternion.copy(tiltQ);
    markOwned(cradleEdge);
    group.add(cradleEdge);

    this.standCradleHitMesh = cradleMesh;
    this.standMountGroup = group;
    this.scene.add(group);
  }

  private getStandCharacterBricks(): BrickInstance[] {
    const rule = this.model.standMount;
    if (!rule) return [];

    // 先取得目前對齊下的右半區小人計畫座標集合
    const align = this.mainAlignment;
    const invRot = (360 - align.rot) % 360;
    const out: BrickInstance[] = [];

    for (const b of this.bricks) {
      if (b.pad !== 'main' || (b.state !== 'placed' && b.state !== 'pressed')) continue;
      if (b.mountedOnStand) {
        out.push(b);
        continue;
      }
      const info = this.getBrickGridInfo(b, 'main');
      if (!info) continue;
      if (info.layer >= 2) {
        out.push(b);
        continue;
      }
      const inCharZone = info.cells.some(([cx, cz]) => {
        const [px] = this.rotateGridCell(cx - align.dx, cz - align.dz, invRot);
        return px >= rule.charZoneMinGx;
      });
      if (inCharZone) out.push(b);
    }
    return out;
  }

  public isCharacterReadyForStand(): boolean {
    const rule = this.model.standMount;
    if (!rule || this.isSandbox || this.standMounted) return false;
    const matched = new Set(this.lastMatchedIndices);
    const charPlan = this.plan.filter(p => p.gx >= Math.floor((this.boardW - (this.model.masks[0]?.[0]?.length ?? this.boardW)) / 2) + rule.charZoneMinGx);
    return charPlan.length > 0 && charPlan.every(p => matched.has(p.index));
  }

  public mountCharacterOnStand(silent = false): boolean {
    const rule = this.model.standMount;
    if (!rule || this.isSandbox) return false;
    if (this.standMounted) return true;

    const charBricks = this.getStandCharacterBricks();
    if (charBricks.length === 0) return false;

    if (!silent) {
      this.pushUndoSnapshot(this.captureUndoSnapshot());
    }

    const modelH = this.model.masks[0]?.length ?? 8;
    const modelW = this.model.masks[0]?.[0]?.length ?? 12;
    const ofx = Math.floor((this.boardW - modelW) / 2);
    const ofz = Math.floor((this.boardD - modelH) / 2);

    const cradleAnchor = new THREE.Vector3(
      this.bX0 + W(ofx + rule.standLocalGx) + 0.18,
      this.yOfLayer(rule.standBaseYLayer) - BRICK_H * 0.42 + BRICK_H * 0.52,
      this.bZ0 + W(ofz + rule.standLocalGz) - 0.15
    );

    const entries: Array<{ b: BrickInstance; gx: number; gz: number; layer: number; rot: number; pos: THREE.Vector3 }> = [];
    let minLayer = Infinity;
    for (const b of charBricks) {
      const info = this.getBrickGridInfo(b, 'main');
      if (!info) continue;
      if (info.layer < minLayer) minLayer = info.layer;
      const t = b.body.translation();
      entries.push({
        b,
        gx: info.gx,
        gz: info.gz,
        layer: info.layer,
        rot: info.rot,
        pos: new THREE.Vector3(t.x, t.y, t.z),
      });
    }
    if (entries.length === 0) return false;

    const baseEntries = entries.filter(e => e.layer === minLayer);
    const pivot = new THREE.Vector3();
    for (const e of baseEntries) {
      pivot.add(e.pos);
    }
    pivot.divideScalar(Math.max(1, baseEntries.length));

    const tiltQ = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(rule.tiltXDeg),
        0,
        THREE.MathUtils.degToRad(rule.tiltZDeg),
        'XYZ'
      )
    );

    for (const e of entries) {
      const { b } = e;
      b.logicalGx = e.gx;
      b.logicalGz = e.gz;
      b.logicalLayer = e.layer;
      b.logicalRot = e.rot;
      b.mountedOnStand = true;

      const yaw = this.rotToYawRad(e.rot);
      const origQ = new THREE.Quaternion(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
      const newPos = e.pos.clone().sub(pivot).applyQuaternion(tiltQ).add(cradleAnchor);
      const newQ = tiltQ.clone().multiply(origQ);

      b.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      b.body.setTranslation({ x: newPos.x, y: newPos.y, z: newPos.z }, true);
      b.body.setRotation({ x: newQ.x, y: newQ.y, z: newQ.z, w: newQ.w }, true);
      b.mesh.position.copy(newPos);
      b.mesh.quaternion.copy(newQ);
      b.snapAnim = silent ? 0 : 0.8;
    }

    this.standMounted = true;
    if (!silent) {
      playClick('snap');
      triggerHaptic('snapGroup');
      this.scheduleAutoSave();
      this.emitSnapshot();
    }
    return true;
  }

  public unmountCharacterFromStand(silent = false): boolean {
    if (!this.standMounted) return false;
    const mounted = this.bricks.filter(b => b.mountedOnStand);
    if (!silent && mounted.length > 0) {
      this.pushUndoSnapshot(this.captureUndoSnapshot());
    }
    this.standMounted = false;
    mounted.sort((a, b) => (a.logicalLayer ?? 0) - (b.logicalLayer ?? 0));
    for (const b of mounted) {
      const gx = b.logicalGx ?? 0;
      const gz = b.logicalGz ?? 0;
      const layer = b.logicalLayer ?? 0;
      const rot = b.logicalRot ?? b.rot;
      b.mountedOnStand = false;
      b.logicalGx = undefined;
      b.logicalGz = undefined;
      b.logicalLayer = undefined;
      b.logicalRot = undefined;
      b.rot = rot;
      this.pressBrickAt(b, gx, gz, this.yOfLayer(layer), 'main', true);
    }
    if (!silent) {
      playClick('pluck');
      triggerHaptic('pluck');
      this.scheduleAutoSave();
      this.emitSnapshot();
    }
    return true;
  }

  private getUpperSubAssembly() {
    if (this.isSandbox || !this.model.subAssemblies || this.model.subAssemblies.length < 2) {
      return null;
    }
    return this.model.subAssemblies[this.model.subAssemblies.length - 1];
  }

  private surfaceYAt(wx: number, wz: number): number {
    let pad: 'main' | 'sub' = 'main';
    let ox = this.bX0;
    let oz = this.bZ0;
    if (
      this.subAssemblyEnabled &&
      wx >= this.subX0 - CELL * 0.5 &&
      wx <= this.subX0 + W(this.boardW) + CELL * 0.5
    ) {
      pad = 'sub';
      ox = this.subX0;
      oz = this.subZ0;
    }
    const gx = Math.floor((wx - ox) / CELL);
    const gz = Math.floor((wz - oz) / CELL);
    if (gx < 0 || gz < 0 || gx >= this.boardW || gz >= this.boardD) return TRAY_FLOOR_TOP;
    const key = `${gx},${gz}`;
    let top = BUILD_TOP_Y;
    for (const o of this.bricks) {
      if (o.pad !== pad) continue;
      if ((o.state !== 'placed' && o.state !== 'pressed') || !o.cellsWorld) continue;
      if (!o.cellsWorld.includes(key)) continue;
      top = Math.max(top, o.body.translation().y + BRICK_H / 2);
    }
    return top;
  }

  private supportTopY(
    b: BrickInstance,
    gx: number,
    gz: number,
    pad: 'main' | 'sub',
    ignore?: Set<number>,
    occupied?: Set<string>
  ): number {
    const cells = worldCells(b.shapeKey, b.rot, gx, gz);
    const cellSet = new Set(cells);
    const ignoreWithSelf = ignore ? new Set([...ignore, b.id]) : new Set([b.id]);
    const occ = occupied ?? this.getOccupiedVoxels(pad, ignoreWithSelf);

    let maxSupportLayer = -1;
    for (const o of this.bricks) {
      if (ignoreWithSelf.has(o.id)) continue;
      if (o.pad !== pad) continue;
      if (o.state !== 'placed' && o.state !== 'pressed') continue;
      const info = this.getBrickGridInfo(o, pad);
      if (!info) continue;
      if (!info.cells.some(([cx, cz]) => cellSet.has(`${cx},${cz}`))) continue;
      if (info.layer > maxSupportLayer) maxSupportLayer = info.layer;
    }

    let targetLayer = maxSupportLayer + 1;

    // 支援懸挑／側向搭接造型（如仙人掌伸出枝幹、屋簷、火箭尾翼、選手高舉手臂）：
    // 若正下方無積木，但該位置對應圖紙上 layer > 0 磚位（支援位移／旋轉後的對齊方位）且同層或次一層相鄰有支撐，自動對齊該層高
    if (targetLayer === 0 && !this.isSandbox && (!ignore || ignore.size === 0)) {
      const activeSub = pad === 'sub' ? this.getUpperSubAssembly() : null;
      const align = pad === 'sub' ? this.subAlignment : this.mainAlignment;
      const candidatePlan = this.plan.find(p => {
        if (p.color !== b.colorIdx || p.layer <= 0) return false;
        if (pad === 'sub' && activeSub && (p.layer < activeSub.startLayer || p.layer > activeSub.endLayer)) {
          return false;
        }
        const transformed = new Set(
          p.cells.map(c => {
            const [px, pz] = c.split(',').map(Number);
            const [tx, tz] = this.transformPlanCell(px, pz, align);
            return `${tx},${tz}`;
          })
        );
        return [...cellSet].every(c => transformed.has(c));
      });

      if (candidatePlan) {
        const localLayer =
          pad === 'sub' && activeSub ? candidatePlan.layer - activeSub.startLayer : candidatePlan.layer;
        const hasNeighborSupport = this.bricks.some(o => {
          if (o === b || o.pad !== pad || (o.state !== 'placed' && o.state !== 'pressed')) {
            return false;
          }
          const info = this.getBrickGridInfo(o, pad);
          if (!info) return false;
          if (info.layer !== localLayer && info.layer !== localLayer - 1) return false;
          for (const c1 of cells) {
            const [x1, z1] = c1.split(',').map(Number);
            for (const [x2, z2] of info.cells) {
              if (Math.abs(x1 - x2) + Math.abs(z1 - z2) <= 1) {
                return true;
              }
            }
          }
          return false;
        });
        if (hasNeighborSupport) {
          targetLayer = localLayer;
        }
      }
    }

    // 嚴格防重疊：保證任何一格 (x, layer, z) 絕不與既有積木共用
    const parsedCells = cells.map(c => c.split(',').map(Number) as [number, number]);
    while (parsedCells.some(([cx, cz]) => occ.has(`${cx},${targetLayer},${cz}`))) {
      targetLayer++;
    }

    return this.yOfLayer(targetLayer);
  }

  private recomputeHeldSnap(): void {
    if (!this.held || !this.pointerReady) return;
    const lead = this.held;
    const g = this.heldGroup.length ? this.heldGroup : [lead];

    const useOrigin = !this.dragMoved && this.pickupOrigin !== null;
    let p: THREE.Vector3 | null = null;
    let inMain = false;
    let inSub = false;

    if (useOrigin && this.pickupOrigin) {
      inMain = this.pickupOrigin.pad === 'main';
      inSub = this.pickupOrigin.pad === 'sub' && this.subAssemblyEnabled;
    } else {
      p = this.rayToFixedPlane(BUILD_TOP_Y + BRICK_H * 0.5);
      if (!p) return;
      const tol = CELL * this.feel.snapTolerance;
      inMain =
        p.x > this.bX0 - tol &&
        p.x < this.bX0 + W(this.boardW) + tol &&
        p.z > this.bZ0 - tol &&
        p.z < this.bZ0 + W(this.boardD) + tol;
      inSub =
        this.subAssemblyEnabled &&
        p.x > this.subX0 - tol &&
        p.x < this.subX0 + W(this.boardW) + tol &&
        p.z > this.subZ0 - tol &&
        p.z < this.subZ0 + W(this.boardD) + tol;
    }

    if ((inMain || inSub) && g.length === 1) {
      const pad: 'main' | 'sub' = inSub ? 'sub' : 'main';
      const ox = pad === 'sub' ? this.subX0 : this.bX0;
      const oz = pad === 'sub' ? this.subZ0 : this.bZ0;
      const bb = bboxOf(rotCells(SHAPES[lead.shapeKey].cells, lead.rot));
      const gx =
        useOrigin && this.pickupOrigin
          ? this.pickupOrigin.gx
          : Math.round((p!.x - ox) / CELL - bb.w / 2);
      const gz =
        useOrigin && this.pickupOrigin
          ? this.pickupOrigin.gz
          : Math.round((p!.z - oz) / CELL - bb.d / 2);
      const cgx = Math.min(this.boardW - bb.w, Math.max(0, gx));
      const cgz = Math.min(this.boardD - bb.d, Math.max(0, gz));
      const wx = ox + W(cgx + bb.w / 2);
      const wz = oz + W(cgz + bb.d / 2);
      const dropY = this.supportTopY(lead, cgx, cgz, pad);
      const holdY = dropY + BRICK_H * this.feel.holdHeightMul;

      this.snapValid = true;
      this.snapPad = pad;
      this.snapGx = cgx;
      this.snapGz = cgz;
      this.snapY = dropY;
      this.targetPos.set(wx, holdY, wz);

      this.multiGhostGroup.visible = false;
      this.ghostMesh.position.set(wx, dropY, wz);
      this.ghostMesh.rotation.y = this.rotToYawRad(lead.rot);
      this.ghostMesh.visible = true;
      this.showDropGuide(wx, this.visualPos.y - BRICK_H * 0.5, dropY - BRICK_H * 0.5, wz);
    } else if ((inMain || inSub) && g.length > 1) {
      const pad: 'main' | 'sub' = inSub ? 'sub' : 'main';
      const ox = pad === 'sub' ? this.subX0 : this.bX0;
      const oz = pad === 'sub' ? this.subZ0 : this.bZ0;
      const leadBb = bboxOf(rotCells(SHAPES[lead.shapeKey].cells, lead.rot));
      const rawGx =
        useOrigin && this.pickupOrigin
          ? this.pickupOrigin.gx
          : Math.round((p!.x - ox) / CELL - leadBb.w / 2);
      const rawGz =
        useOrigin && this.pickupOrigin
          ? this.pickupOrigin.gz
          : Math.round((p!.z - oz) / CELL - leadBb.d / 2);

      let minRelX = 0;
      let maxRelXEnd = leadBb.w;
      let minRelZ = 0;
      let maxRelZEnd = leadBb.d;
      let minRelLayer = 0;
      const rels = g.map(b => {
        const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
        const dgx = Math.round(b.offset.x / CELL + leadBb.w / 2 - bb.w / 2);
        const dgz = Math.round(b.offset.z / CELL + leadBb.d / 2 - bb.d / 2);
        const dLayer = Math.round(b.offset.y / BRICK_H);
        minRelX = Math.min(minRelX, dgx);
        maxRelXEnd = Math.max(maxRelXEnd, dgx + bb.w);
        minRelZ = Math.min(minRelZ, dgz);
        maxRelZEnd = Math.max(maxRelZEnd, dgz + bb.d);
        minRelLayer = Math.min(minRelLayer, dLayer);
        return { b, dgx, dgz, dLayer };
      });

      const cgx = Math.min(this.boardW - maxRelXEnd, Math.max(-minRelX, rawGx));
      const cgz = Math.min(this.boardD - maxRelZEnd, Math.max(-minRelZ, rawGz));
      const ignoreIds = new Set(g.map(x => x.id));
      const occ = this.getOccupiedVoxels(pad, ignoreIds);

      let baseLayer = -minRelLayer;
      for (const { b, dgx, dgz, dLayer } of rels) {
        const supLayer = this.layerOfY(this.supportTopY(b, cgx + dgx, cgz + dgz, pad, ignoreIds, occ));
        const reqBase = supLayer - dLayer;
        if (reqBase > baseLayer) baseLayer = reqBase;
      }

      // 整組嚴格防重疊檢查：確保群組內每一塊的每一個體素都不會撞到既有積木
      const groupCells = rels.map(({ b, dgx, dgz, dLayer }) => ({
        dLayer,
        cells: worldCells(b.shapeKey, b.rot, cgx + dgx, cgz + dgz).map(
          c => c.split(',').map(Number) as [number, number]
        ),
      }));
      while (
        groupCells.some(({ dLayer, cells }) => {
          const L = baseLayer + dLayer;
          return cells.some(([cx, cz]) => occ.has(`${cx},${L},${cz}`));
        })
      ) {
        baseLayer++;
      }

      const dropY = this.yOfLayer(baseLayer);
      const wx = ox + W(cgx + leadBb.w / 2);
      const wz = oz + W(cgz + leadBb.d / 2);
      const maxOffY = Math.max(...g.map(x => x.offset.y));
      const minOffY = Math.min(...g.map(x => x.offset.y));
      const holdY = dropY + BRICK_H * this.feel.holdHeightMul + Math.max(0, -minOffY) * 0.25;

      this.snapValid = true;
      this.snapPad = pad;
      this.snapGx = cgx;
      this.snapGz = cgz;
      this.snapY = dropY;
      this.targetPos.set(wx, Math.max(holdY, dropY + maxOffY * 0.1 + BRICK_H * 1.1), wz);

      this.ghostMesh.visible = false;
      this.multiGhostGroup.position.set(wx, dropY, wz);
      this.multiGhostGroup.visible = true;
      this.showDropGuide(wx, this.visualPos.y + minOffY - BRICK_H * 0.5, dropY + minOffY - BRICK_H * 0.5, wz);
    } else if (p) {
      this.snapValid = false;
      this.ghostMesh.visible = false;
      this.multiGhostGroup.visible = false;
      const surf = this.surfaceYAt(p.x, p.z);
      const holdY = Math.max(
        surf + BRICK_H * (this.feel.holdHeightMul + 0.35),
        TRAY_FLOOR_TOP + BRICK_H * 2.2
      );
      this.targetPos.set(p.x, holdY, p.z);
      this.showDropGuide(this.visualPos.x, this.visualPos.y - BRICK_H * 0.5, surf, this.visualPos.z);
    }
  }

  private rebuildMultiGhost(group: BrickInstance[]): void {
    while (this.multiGhostGroup.children.length > 0) {
      this.multiGhostGroup.remove(this.multiGhostGroup.children[0]);
    }
    for (const b of group) {
      const m = new THREE.Mesh(brickGeometry(b.shapeKey).geo, this.ghostMat);
      m.position.copy(b.offset);
      m.rotation.y = this.rotToYawRad(b.rot);
      m.renderOrder = 10;
      this.multiGhostGroup.add(m);
    }
  }

  private startHold(brick: BrickInstance, single: boolean): void {
    const wasSinglePluck = single && (brick.state === 'pressed' || brick.state === 'placed');
    this.pendingUndoSnapshot = this.captureUndoSnapshot();
    this.autoFollowedOnHeld = false;
    playClick(wasSinglePluck ? 'pluck' : 'pick');
    triggerHaptic(wasSinglePluck ? 'pluck' : 'pick');

    if (brick.mountedOnStand) {
      this.unmountCharacterFromStand(true);
    }

    if (brick.state === 'pressed' || brick.state === 'placed') {
      const originInfo = this.getBrickGridInfo(brick, brick.pad);
      this.pickupOrigin = originInfo
        ? { pad: brick.pad, gx: originInfo.gx, gz: originInfo.gz, layer: originInfo.layer }
        : null;

      const g = single || brick.state === 'placed' ? [brick] : this.groupOf(brick);
      this.heldGroup = g;
      this.held = brick;
      // 嚴格以物理剛體座標計算相對位移並對齊格線，避免彈跳動畫偏移累積導致重疊
      const leadT = brick.body.translation();
      for (const b of g) {
        const bt = b.body.translation();
        const ox = Math.round((bt.x - leadT.x) / (CELL * 0.5)) * (CELL * 0.5);
        const oy = Math.round((bt.y - leadT.y) / BRICK_H) * BRICK_H;
        const oz = Math.round((bt.z - leadT.z) / (CELL * 0.5)) * (CELL * 0.5);
        b.offset.set(ox, oy, oz);
        b.snapAnim = 0;
        b.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        this.setColliders(b, false);
        b.state = 'held';
        b.cellsWorld = null;
        this.uf.delete(b);
        b.mesh.material = this.getMaterialForBrick(b, 'none');
      }
      this.hovering = [];
      this.hoverKey = '';
      if (g.length > 1) {
        this.rebuildMultiGhost(g);
        playClick('pluck');
        triggerHaptic('pluck');
      }
    } else {
      this.pickupOrigin = null;
      this.heldGroup = [brick];
      this.held = brick;
      brick.offset.set(0, 0, 0);
      brick.snapAnim = 0;
      brick.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.setColliders(brick, false);
      brick.state = 'held';
      brick.cellsWorld = null;
      brick.rot = 0;
      brick.bb = bboxOf(SHAPES[brick.shapeKey].cells);
      brick.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      brick.mesh.material = this.getMaterialForBrick(brick, 'none');

      // 智慧視角接力：在點選拿取模式下從零件籃挑出積木時，鏡頭自動流暢轉回組裝區（長按拖曳則等拖出籃外再轉）
      if (
        this.feel.autoFollowBuildView &&
        this.viewKey === 'tray' &&
        this.getResolvedControlStyle() === 'tap'
      ) {
        this.autoFollowedOnHeld = true;
        this.focusBuildArea();
        _ndc.set(0, 0);
      }
    }

    const t = brick.body.translation();
    this.visualPos.set(t.x, t.y + (wasSinglePluck ? BRICK_H * 1.15 : BRICK_H * 0.85), t.z);
    if (this.autoFollowedOnHeld) {
      const cx = this.subAssemblyEnabled ? this.subPadCx : this.padCx;
      const cz = this.subAssemblyEnabled ? this.subPadCz : this.padCz;
      this.targetPos.set(cx, BUILD_TOP_Y + BRICK_H * 2.2, cz);
    } else {
      this.targetPos.copy(this.visualPos);
    }
    this.snapValid = false;
    this.ghostMesh.geometry = brickGeometry(brick.shapeKey).geo;
    // 立即同步計算一次磁吸位置，避免快速點擊放開時尚未進入下一幀而掉落成散落積木
    this.recomputeHeldSnap();
    this.emitSnapshot();
  }

  private lightPlaceBrickAt(
    b: BrickInstance,
    gx: number,
    gz: number,
    dropY: number,
    pad: 'main' | 'sub' = 'main',
    silent = false
  ): void {
    const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
    const ox = pad === 'sub' ? this.subX0 : this.bX0;
    const oz = pad === 'sub' ? this.subZ0 : this.bZ0;
    const wx = ox + W(gx + bb.w / 2);
    const wz = oz + W(gz + bb.d / 2);
    const exactY = this.yOfLayer(this.layerOfY(dropY));

    this.setColliders(b, true);
    b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    b.body.setTranslation({ x: wx, y: exactY, z: wz }, true);
    const q = this.rotToYawRad(b.rot);
    b.body.setRotation({ x: 0, y: Math.sin(q / 2), z: 0, w: Math.cos(q / 2) }, true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);

    b.bb = bb;
    b.pad = pad;
    b.state = 'placed';
    b.mountedOnStand = false;
    b.cellsWorld = worldCells(b.shapeKey, b.rot, gx, gz);
    b.mesh.position.set(wx, exactY + BRICK_H * 0.05, wz);
    b.mesh.quaternion.set(0, Math.sin(q / 2), 0, Math.cos(q / 2));
    b.mesh.material = this.getMaterialForBrick(b, 'none');
    if (!silent) {
      playClick('place');
      triggerHaptic('place');
    }
  }

  private pressBrickAt(
    b: BrickInstance,
    gx: number,
    gz: number,
    dropY: number,
    pad: 'main' | 'sub' = 'main',
    silent = false
  ): void {
    const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
    const ox = pad === 'sub' ? this.subX0 : this.bX0;
    const oz = pad === 'sub' ? this.subZ0 : this.bZ0;
    const wx = ox + W(gx + bb.w / 2);
    const wz = oz + W(gz + bb.d / 2);
    const exactY = this.yOfLayer(this.layerOfY(dropY));

    this.setColliders(b, true);
    b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    b.body.setTranslation({ x: wx, y: exactY, z: wz }, true);
    const q = this.rotToYawRad(b.rot);
    b.body.setRotation({ x: 0, y: Math.sin(q / 2), z: 0, w: Math.cos(q / 2) }, true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);

    b.bb = bb;
    b.pad = pad;
    b.state = 'pressed';
    b.mountedOnStand = false;
    b.cellsWorld = worldCells(b.shapeKey, b.rot, gx, gz);
    b.snapAnim = silent ? 0 : 1.0;
    b.mesh.position.set(wx, exactY, wz);
    b.mesh.quaternion.set(0, Math.sin(q / 2), 0, Math.cos(q / 2));
    b.mesh.material = this.getMaterialForBrick(b, 'none');

    let hasVerticalSupport = false;
    for (const o of this.bricks) {
      if (o === b || o.pad !== pad || (o.state !== 'pressed' && o.state !== 'placed') || !o.cellsWorld) {
        continue;
      }
      const dy = Math.abs(exactY - o.body.translation().y);
      if (dy > BRICK_H * 0.5 && dy < BRICK_H * 1.45 && o.cellsWorld.some(c => b.cellsWorld!.includes(c))) {
        this.ufUnion(b, o);
        hasVerticalSupport = true;
      }
    }
    if (!hasVerticalSupport && exactY > BUILD_TOP_Y + BRICK_H * 0.8) {
      for (const o of this.bricks) {
        if (o === b || o.pad !== pad || (o.state !== 'pressed' && o.state !== 'placed') || !o.cellsWorld) {
          continue;
        }
        const dy = Math.abs(exactY - o.body.translation().y);
        if (dy < BRICK_H * 0.4) {
          const touching = b.cellsWorld.some(c1 => {
            const [x1, z1] = c1.split(',').map(Number);
            return o.cellsWorld!.some(c2 => {
              const [x2, z2] = c2.split(',').map(Number);
              return Math.abs(x1 - x2) + Math.abs(z1 - z2) === 1;
            });
          });
          if (touching) this.ufUnion(b, o);
        }
      }
    }
    if (!silent) {
      playClick('snap');
      triggerHaptic('snap');
    }
  }

  private finishHold(): void {
    if (!this.held) return;
    // 放開前強制重算一次，確保旋轉後或高速拖曳後的座標與層高完全零重疊
    this.recomputeHeldSnap();

    const lead = this.held;
    const g = this.heldGroup.length ? this.heldGroup : [lead];

    if (g.length === 1 && this.snapValid) {
      if (this.feel.placementMode === 'two-step' && this.downWasPlaced && !this.dragMoved) {
        this.pressBrickAt(lead, this.snapGx, this.snapGz, this.snapY, this.snapPad);
      } else if (this.feel.placementMode === 'two-step') {
        this.lightPlaceBrickAt(lead, this.snapGx, this.snapGz, this.snapY, this.snapPad);
      } else {
        this.pressBrickAt(lead, this.snapGx, this.snapGz, this.snapY, this.snapPad);
      }
    } else if (g.length > 1 && this.snapValid) {
      const leadBb = bboxOf(rotCells(SHAPES[lead.shapeKey].cells, lead.rot));
      const baseLayer = this.layerOfY(this.snapY);
      const sorted = [...g].sort((a, b) => a.offset.y - b.offset.y);
      for (const b of sorted) {
        const bb = bboxOf(rotCells(SHAPES[b.shapeKey].cells, b.rot));
        const dgx = Math.round(b.offset.x / CELL + leadBb.w / 2 - bb.w / 2);
        const dgz = Math.round(b.offset.z / CELL + leadBb.d / 2 - bb.d / 2);
        const dLayer = Math.round(b.offset.y / BRICK_H);
        this.pressBrickAt(
          b,
          this.snapGx + dgx,
          this.snapGz + dgz,
          this.yOfLayer(baseLayer + dLayer),
          this.snapPad,
          true
        );
        b.snapAnim = 1.0;
        this.ufUnion(sorted[0], b);
      }
      playClick('snap');
      triggerHaptic('snapGroup');
    } else {
      for (const b of g) {
        this.setColliders(b, true);
        b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        b.pad = 'main';
        b.state = 'pool';
        b.cellsWorld = null;
        b.mesh.material = this.getMaterialForBrick(b, 'none');
      }
    }

    const pending = this.pendingUndoSnapshot;
    this.pendingUndoSnapshot = null;
    if (pending) {
      const after = this.captureUndoSnapshot();
      if (!this.snapshotsEqual(pending, after)) {
        this.pushUndoSnapshot(pending);
      }
    }

    this.held = null;
    this.heldGroup = [];
    this.pickupOrigin = null;
    this.snapValid = false;
    this.tapPickedThisGesture = false;
    this.tapPlacePending = false;
    this.autoFollowedOnHeld = false;
    this.ghostMesh.visible = false;
    this.multiGhostGroup.visible = false;
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

  private updateNDC(e: PointerEvent, applyTouchOffset = false): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    _ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    let ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    if (applyTouchOffset && e.pointerType === 'touch') {
      ny = Math.min(0.95, ny + TOUCH_HOLD_NDC_OFFSET_Y);
    }
    _ndc.y = ny;
    this.pointerReady = true;
  }

  private bindEvents(): void {
    const canvas = this.renderer.domElement;

    this.boundPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const pType: 'mouse' | 'touch' | 'pen' =
        e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse';
      if (pType !== this.lastPointerType) {
        this.lastPointerType = pType;
        this.emitSnapshot();
      }
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.activePointers.size >= 2) {
        // 拖曳單顆積木時，第二指輕點可直接旋轉 90°；若雙指拉動縮放再取消抓取交給鏡頭
        if (this.held && this.heldGroup.length <= 1 && !this.secondTapCandidate) {
          this.secondTapCandidate = {
            id: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startMs: performance.now(),
          };
          return;
        }
        this.secondTapCandidate = null;
        this.cancelActiveInteractions();
        return;
      }

      const tapMode = this.getResolvedControlStyle() === 'tap';
      this.updateNDC(e, Boolean(this.held));
      this.downScreen = { x: e.clientX, y: e.clientY };
      this.dragMoved = false;
      this.downOnTrayFloor = null;
      this.downOnPouch = null;
      this.downOnBox = false;
      this.downOnStand = false;
      this.tapPickedThisGesture = false;
      this.tapPlacePending = false;

      // 點選拿取模式下若手中已有積木，再次點擊即視為準備放置或放回
      if (this.held && tapMode) {
        this.recomputeHeldSnap();
        this.tapPlacePending = true;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        e.preventDefault();
        return;
      }

      // 最先檢查是否點到未開箱的 3D 積木箱
      if (this.pickBrickBox()) {
        this.downOnBox = true;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        e.preventDefault();
        return;
      }

      // 檢查是否點到 3D 待拆零件袋
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

      // 若無拿取零件且點到透明斜角展示支架，提供一鍵放上／取下支架互動
      if (!this.held && this.model.standMount && !this.pickBrick() && this.pickStandMountProp()) {
        this.downOnStand = true;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        e.preventDefault();
        return;
      }

      if (this.interactionMode === 'rummage') {
        this.downWasPlaced = false;
        const hitTray = this.pickTrayFloor();
        if (hitTray !== null && hitTray !== this.activeTray && this.trays.length > 1) {
          this.downOnTrayFloor = hitTray;
        }
        const p = this.rayToFixedPlane(TRAY_FLOOR_TOP + FINGER_R * 0.85);
        if (p) {
          this.fingerMode = true;
          this.fingerTarget.set(p.x, TRAY_FLOOR_TOP + FINGER_R * 0.85, p.z);
          this.fingerPrevPos.copy(this.fingerTarget);
          this.fingerBody.setTranslation(
            { x: p.x, y: TRAY_FLOOR_TOP + FINGER_R * 0.85, z: p.z },
            true
          );
          this.fingerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }
      } else {
        const brick = this.pickBrick();
        if (brick) {
          this.downWasPlaced = brick.state === 'placed';
          const singlePluck =
            e.shiftKey || this.singlePluckMode || this.interactionMode === 'separator';
          this.startHold(brick, singlePluck);
          this.fingerMode = false;
          if (tapMode) {
            this.tapPickedThisGesture = true;
          }
        } else {
          this.downWasPlaced = false;
          const hitTray = this.pickTrayFloor();
          if (hitTray !== null && hitTray !== this.activeTray && this.trays.length > 1) {
            this.downOnTrayFloor = hitTray;
          }
          const p = this.rayToFixedPlane(TRAY_FLOOR_TOP + FINGER_R * 0.85);
          if (p) {
            this.fingerMode = true;
            this.fingerTarget.set(p.x, TRAY_FLOOR_TOP + FINGER_R * 0.85, p.z);
            this.fingerPrevPos.copy(this.fingerTarget);
            this.fingerBody.setTranslation(
              { x: p.x, y: TRAY_FLOOR_TOP + FINGER_R * 2.0, z: p.z },
              true
            );
            this.fingerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
          }
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
      if (this.secondTapCandidate && e.pointerId === this.secondTapCandidate.id) {
        const d = Math.hypot(
          e.clientX - this.secondTapCandidate.startX,
          e.clientY - this.secondTapCandidate.startY
        );
        if (d > 14) {
          this.secondTapCandidate = null;
          this.cancelActiveInteractions();
        }
        return;
      }
      if (this.activePointers.size >= 2) return;

      const moveThreshold = this.tapPickedThisGesture ? 18 : 6;
      if (Math.hypot(e.clientX - this.downScreen.x, e.clientY - this.downScreen.y) > moveThreshold) {
        this.dragMoved = true;
      }
      this.updateNDC(e, Boolean(this.held));
      this.hoverDirty = true;

      // 長按拖曳模式：在零件籃特寫中把積木往右側組裝區邊緣拖出時，流暢切換鏡頭到組裝區
      if (
        this.held &&
        this.feel.autoFollowBuildView &&
        this.viewKey === 'tray' &&
        !this.autoFollowedOnHeld &&
        this.dragMoved
      ) {
        const rayP = this.rayToFixedPlane(BUILD_TOP_Y + BRICK_H * 0.5);
        const tray = this.trays[this.activeTray] ?? this.trays[0];
        if (rayP && tray && rayP.x > tray.x0 + tray.widthWorld + CELL * 0.35) {
          this.autoFollowedOnHeld = true;
          this.focusBuildArea();
        }
      }
    };

    this.boundPointerUp = (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);
      if (this.secondTapCandidate && e.pointerId === this.secondTapCandidate.id) {
        const elapsed = performance.now() - this.secondTapCandidate.startMs;
        this.secondTapCandidate = null;
        if (elapsed < 300 && this.held) {
          this.rotateHeld();
        }
        return;
      }
      if (this.downOnBox) {
        this.downOnBox = false;
        this.openBox(false);
        return;
      }
      if (this.downOnPouch !== null) {
        this.openPack(this.downOnPouch, false, this.activeTray);
        this.downOnPouch = null;
        return;
      }
      if (this.downOnStand) {
        this.downOnStand = false;
        if (!this.dragMoved) {
          if (this.standMounted) {
            this.unmountCharacterFromStand();
          } else {
            this.mountCharacterOnStand();
          }
        }
        return;
      }
      if (this.downOnTrayFloor !== null && !this.dragMoved && !this.held) {
        this.focusTray(this.downOnTrayFloor);
      }
      this.downOnTrayFloor = null;

      if (this.fingerMode) {
        this.fingerMode = false;
        this.fingerMesh.visible = false;
      }

      if (this.held) {
        const tapMode = this.getResolvedControlStyle() === 'tap';
        if (this.tapPlacePending) {
          this.tapPlacePending = false;
          this.finishHold();
        } else if (tapMode && this.tapPickedThisGesture && !this.dragMoved) {
          // 點選拿取成功：保留積木浮在準心上，讓玩家可以自由點旋轉鍵或再點底板放下
          this.tapPickedThisGesture = false;
        } else {
          this.finishHold();
        }
      }
    };

    this.boundBlur = () => {
      this.activePointers.clear();
      this.secondTapCandidate = null;
      this.downOnPouch = null;
      this.downOnBox = false;
      this.tapPickedThisGesture = false;
      this.tapPlacePending = false;
      this.cancelActiveInteractions();
    };

    this.boundKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === 'r' || e.key === 'R') && this.held && this.heldGroup.length <= 1) {
        this.rotateHeld();
      } else if (e.key === 'f' || e.key === 'F') {
        this.setInteractionMode(this.interactionMode === 'rummage' ? 'grab' : 'rummage');
      } else if (e.key === 'x' || e.key === 'X') {
        this.setInteractionMode(this.interactionMode === 'separator' ? 'grab' : 'separator');
      } else if (e.key === 'g' || e.key === 'G') {
        this.setInteractionMode('grab');
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        this.undoLastAction();
      } else if (e.key === 'Escape' && this.held) {
        this.returnHeldToTray();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.switchView();
      } else if (e.key === '1' && this.trays.length >= 1) {
        this.focusTray(0);
      } else if (e.key === '2' && this.trays.length >= 2) {
        this.focusTray(1);
      } else if (e.key === '3' && this.trays.length >= 3) {
        this.focusTray(2);
      } else if (e.key === '4' && this.trays.length >= 4) {
        this.focusTray(3);
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
          want = this.interactionMode === 'separator' ? [hb] : this.groupOf(hb);
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

    // 2. 手指翻找（撥開積木並帶真實塑膠碰撞細響與微震動；深籃內高度自動抬高至堆疊中層）
    if (this.fingerMode) {
      const curTray = this.trays[this.activeTray];
      const rummageY =
        curTray?.kind === 'deep'
          ? TRAY_FLOOR_TOP + BRICK_H * 1.45
          : TRAY_FLOOR_TOP + FINGER_R * 0.85;
      const p = this.rayToFixedPlane(rummageY);
      if (p) this.fingerTarget.set(p.x, rummageY, p.z);
      const cur = this.fingerBody.translation();
      const k = 16;
      const maxV = CELL * 34;
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

      const movedDist = Math.hypot(cur.x - this.fingerPrevPos.x, cur.z - this.fingerPrevPos.z);
      if (movedDist > 0.25) {
        this.fingerPrevPos.set(cur.x, cur.y, cur.z);
        const now = performance.now();
        if (now - this.lastRattleMs > 75) {
          // 只有周圍確實有池中零件時才發出塑膠撥動聲
          const nearBrick = this.bricks.some(b => {
            if (b.state !== 'pool') return false;
            const bt = b.body.translation();
            const dx = bt.x - cur.x;
            const dz = bt.z - cur.z;
            return dx * dx + dz * dz < CELL * CELL * 5.2;
          });
          if (nearBrick) {
            this.lastRattleMs = now;
            playClick('rattle');
            triggerHaptic('rattle');
          }
        }
      }
    } else {
      this.fingerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.fingerBody.setTranslation({ x: 0, y: 40, z: 0 }, true);
    }

    // 3. 固定平面射線＋平滑拖曳＋即時磁吸（支援主組裝區與子區塊組裝台）
    if (this.held) {
      const lead = this.held;
      const g = this.heldGroup.length ? this.heldGroup : [lead];
      this.recomputeHeldSnap();

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

  /**
   * 以「體素顏色＋每格之間的相對位置」比對完成度：
   * - 不限制一定要拼在底板正中央（支援任意平移 dx, dz）
   * - 不限制朝向（支援 0° / 90° / 180° / 270° 四方向旋轉）
   * - 不限制同色區塊的切法（例如兩塊 1x2 拼成 1x4，只要每格顏色與立體形狀一致即判定吻合）
   * - 仍嚴格由物理剛體實際世界座標計算佔用格，絕不憑空預測
   */
  private matchPlanRelative(
    planSubset: PlanBrick[],
    pad: 'main' | 'sub',
    layerOffset = 0
  ): {
    matchedIndices: number[];
    alignment: { rot: number; dx: number; dz: number };
    placedVoxelCount: number;
    planVoxelCount: number;
  } {
    const planVoxelCount = planSubset.reduce((acc, p) => acc + p.cells.length, 0);
    if (planSubset.length === 0) {
      return {
        matchedIndices: [],
        alignment: { rot: 0, dx: 0, dz: 0 },
        placedVoxelCount: 0,
        planVoxelCount: 0,
      };
    }

    const placedVoxels = new Map<string, number>();
    const placedSlopes = new Map<string, { shape: ShapeKey; rot: number; color: number }>();
    const placedByLayer = new Map<number, Array<{ x: number; z: number; color: number }>>();
    let minPlacedX = Infinity;
    let minPlacedZ = Infinity;

    for (const b of this.bricks) {
      if (b.pad !== pad) continue;
      if (b.state !== 'placed' && b.state !== 'pressed') continue;
      const info = this.getBrickGridInfo(b, pad);
      if (!info) continue;
      let layerArr = placedByLayer.get(info.layer);
      if (!layerArr) {
        layerArr = [];
        placedByLayer.set(info.layer, layerArr);
      }
      if (SHAPES[b.shapeKey].isSlope) {
        placedSlopes.set(`${info.gx},${info.layer},${info.gz}`, {
          shape: b.shapeKey,
          rot: info.rot,
          color: b.colorIdx,
        });
      }
      for (const [cx, cz] of info.cells) {
        const key = `${cx},${info.layer},${cz}`;
        if (!placedVoxels.has(key)) {
          placedVoxels.set(key, b.colorIdx);
          layerArr.push({ x: cx, z: cz, color: b.colorIdx });
          if (cx < minPlacedX) minPlacedX = cx;
          if (cz < minPlacedZ) minPlacedZ = cz;
        }
      }
    }

    if (placedVoxels.size === 0) {
      return {
        matchedIndices: [],
        alignment: { rot: 0, dx: 0, dz: 0 },
        placedVoxelCount: 0,
        planVoxelCount,
      };
    }

    const parsedPlan = planSubset.map(p => ({
      index: p.index,
      shape: p.shape,
      rot: p.rot,
      isSlope: Boolean(SHAPES[p.shape].isSlope),
      color: p.color,
      localLayer: p.layer - layerOffset,
      cells: p.cells.map(c => c.split(',').map(Number) as [number, number]),
    }));

    const planByLayer = new Map<number, Array<{ x: number; z: number; color: number }>>();
    for (const p of parsedPlan) {
      let arr = planByLayer.get(p.localLayer);
      if (!arr) {
        arr = [];
        planByLayer.set(p.localLayer, arr);
      }
      for (const [x, z] of p.cells) {
        arr.push({ x, z, color: p.color });
      }
    }

    // 挑選「雙方都有積木且配對數最少」的層作為位移投票錨點，速度極快又涵蓋各種組裝順序
    let anchorLayer = -1;
    let bestPairs = Infinity;
    for (const [L, pCells] of placedByLayer.entries()) {
      const mCells = planByLayer.get(L);
      if (!mCells || mCells.length === 0) continue;
      const pairs = pCells.length * mCells.length;
      if (pairs < bestPairs) {
        bestPairs = pairs;
        anchorLayer = L;
      }
    }

    let bestMatched: number[] = [];
    let bestAlignment = { rot: 0, dx: 0, dz: 0 };
    let bestScore: [number, number, number, number, number] = [-1, -1, -1, -1, -Infinity];

    const isBetter = (
      a: [number, number, number, number, number],
      b: [number, number, number, number, number]
    ): boolean => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
      }
      return false;
    };

    for (const rot of [0, 90, 180, 270]) {
      const votes = new Map<string, number>();
      const addVote = (dx: number, dz: number, weight = 1) => {
        const k = `${dx},${dz}`;
        votes.set(k, (votes.get(k) ?? 0) + weight);
      };

      if (anchorLayer >= 0) {
        const pCells = placedByLayer.get(anchorLayer) ?? [];
        const mCells = planByLayer.get(anchorLayer) ?? [];
        for (const pc of pCells) {
          for (const mc of mCells) {
            if (pc.color !== mc.color) continue;
            const [rx, rz] = this.rotateGridCell(mc.x, mc.z, rot);
            addVote(pc.x - rx, pc.z - rz, 1);
          }
        }
      }

      // 補入外接框對齊與原位 (0,0) 作為保底候選
      let minRotPlanX = Infinity;
      let minRotPlanZ = Infinity;
      for (const p of parsedPlan) {
        for (const [x, z] of p.cells) {
          const [rx, rz] = this.rotateGridCell(x, z, rot);
          if (rx < minRotPlanX) minRotPlanX = rx;
          if (rz < minRotPlanZ) minRotPlanZ = rz;
        }
      }
      if (Number.isFinite(minRotPlanX) && Number.isFinite(minPlacedX)) {
        addVote(minPlacedX - minRotPlanX, minPlacedZ - minRotPlanZ, 0.5);
      }
      if (rot === 0) {
        addVote(0, 0, 0.25);
      }

      const candidates = [...votes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([k]) => k.split(',').map(Number) as [number, number]);

      for (const [dx, dz] of candidates) {
        const matchedIndices: number[] = [];
        let matchedVoxels = 0;
        let partialVoxels = 0;

        for (const p of parsedPlan) {
          let allHit = true;
          let rMinX = Infinity;
          let rMinZ = Infinity;
          for (const [x, z] of p.cells) {
            const [rx, rz] = this.rotateGridCell(x, z, rot);
            const tx = rx + dx;
            const tz = rz + dz;
            if (tx < rMinX) rMinX = tx;
            if (tz < rMinZ) rMinZ = tz;
            const col = placedVoxels.get(`${tx},${p.localLayer},${tz}`);
            if (col === p.color) {
              partialVoxels++;
            } else {
              allHit = false;
            }
          }
          // 斜坡積木需額外驗證實際磚型與旋轉方向相符
          if (allHit && p.isSlope) {
            const sp = placedSlopes.get(`${rMinX},${p.localLayer},${rMinZ}`);
            const expectedRot = (p.rot + rot) % 360;
            if (!sp || sp.shape !== p.shape || sp.color !== p.color || sp.rot !== expectedRot) {
              allHit = false;
            }
          }
          if (allHit) {
            matchedIndices.push(p.index);
            matchedVoxels += p.cells.length;
          }
        }

        const isIdentity = rot === 0 && dx === 0 && dz === 0 ? 1 : 0;
        const score: [number, number, number, number, number] = [
          matchedVoxels,
          matchedIndices.length,
          partialVoxels,
          isIdentity,
          -(Math.abs(dx) + Math.abs(dz)),
        ];
        if (isBetter(score, bestScore)) {
          bestScore = score;
          bestMatched = matchedIndices;
          bestAlignment = { rot, dx, dz };
        }
      }
    }

    return {
      matchedIndices: bestMatched,
      alignment: bestAlignment,
      placedVoxelCount: placedVoxels.size,
      planVoxelCount,
    };
  }

  private computeMatchedIndices(): {
    matchedIndices: number[];
    placedVoxelCount: number;
    planVoxelCount: number;
  } {
    if (this.isSandbox) {
      this.mainAlignment = { rot: 0, dx: 0, dz: 0 };
      return { matchedIndices: [], placedVoxelCount: 0, planVoxelCount: 0 };
    }
    const res = this.matchPlanRelative(this.plan, 'main', 0);
    this.mainAlignment = res.alignment;
    return {
      matchedIndices: res.matchedIndices,
      placedVoxelCount: res.placedVoxelCount,
      planVoxelCount: res.planVoxelCount,
    };
  }

  private computeSubMatchedIndices(): number[] {
    const sub = this.getUpperSubAssembly();
    if (!sub || !this.subAssemblyEnabled) {
      this.subAlignment = { rot: 0, dx: 0, dz: 0 };
      return [];
    }
    const subPlan = this.plan.filter(p => p.layer >= sub.startLayer && p.layer <= sub.endLayer);
    const res = this.matchPlanRelative(subPlan, 'sub', sub.startLayer);
    this.subAlignment = res.alignment;

    const placedSub = this.bricks.filter(
      b => b.pad === 'sub' && (b.state === 'placed' || b.state === 'pressed') && b.cellsWorld
    );
    // 當子工作台區塊全數拼妥時，自動將該區塊內所有積木合併成同一組（方便一抓整塊合體）
    if (res.matchedIndices.length > 0 && res.matchedIndices.length === subPlan.length && placedSub.length > 1) {
      for (let i = 1; i < placedSub.length; i++) {
        this.ufUnion(placedSub[0], placedSub[i]);
      }
    }
    return res.matchedIndices;
  }

  public mergeSubAssemblyToMain(): boolean {
    const sub = this.getUpperSubAssembly();
    if (!sub) return false;
    const subBricks = this.bricks.filter(
      b => b.pad === 'sub' && (b.state === 'placed' || b.state === 'pressed') && b.cellsWorld
    );
    if (subBricks.length === 0) return false;

    // 先更新主、副組裝區對齊座標，再把子組件的每一塊依相對方位平順合體到主組裝區
    this.computeMatchedIndices();
    this.computeSubMatchedIndices();

    const mainAlign = this.mainAlignment;
    const subAlign = this.subAlignment;
    const invSubRot = (360 - subAlign.rot) % 360;
    const deltaRot = (mainAlign.rot - subAlign.rot + 360) % 360;
    const occMain = this.getOccupiedVoxels('main');

    const moves: Array<{
      brick: BrickInstance;
      gx: number;
      gz: number;
      layer: number;
      rot: number;
    }> = [];

    for (const b of subBricks) {
      const info = this.getBrickGridInfo(b, 'sub');
      if (!info) continue;
      const newLayer = info.layer + sub.startLayer;
      const newRot = (b.rot + deltaRot) % 360;

      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      const targetVoxels: string[] = [];
      for (const [sx, sz] of info.cells) {
        const [px, pz] = this.rotateGridCell(sx - subAlign.dx, sz - subAlign.dz, invSubRot);
        const [mx, mz] = this.transformPlanCell(px, pz, mainAlign);
        if (mx < minX) minX = mx;
        if (mx > maxX) maxX = mx;
        if (mz < minZ) minZ = mz;
        if (mz > maxZ) maxZ = mz;
        targetVoxels.push(`${mx},${newLayer},${mz}`);
      }
      if (minX < 0 || minZ < 0 || maxX >= this.boardW || maxZ >= this.boardD) continue;
      if (targetVoxels.some(v => occMain.has(v))) continue;

      moves.push({ brick: b, gx: minX, gz: minZ, layer: newLayer, rot: newRot });
      for (const v of targetVoxels) occMain.add(v);
    }

    if (moves.length > 0) {
      this.pushUndoSnapshot(this.captureUndoSnapshot());
      moves.sort((a, b) => a.layer - b.layer);
      for (const m of moves) {
        m.brick.rot = m.rot;
        this.pressBrickAt(m.brick, m.gx, m.gz, this.yOfLayer(m.layer), 'main', true);
        m.brick.snapAnim = 1.0;
      }
      playClick('snap');
      triggerHaptic('snapGroup');
      this.viewKey = 'build';
      this.tweenCameraTo(this.getViewPreset('build'));
      this.scheduleAutoSave();
      this.emitSnapshot();
      return true;
    }
    return false;
  }

  private emitSnapshot(): void {
    const mainMatch = this.computeMatchedIndices();
    const matchedIndices = mainMatch.matchedIndices;
    this.lastMatchedIndices = matchedIndices;
    const subMatchedIndices = this.computeSubMatchedIndices();
    this.lastSubMatchedIndices = subMatchedIndices;

    const activeSub = this.getUpperSubAssembly();
    const subPlanCount = activeSub
      ? this.plan.filter(p => p.layer >= activeSub.startLayer && p.layer <= activeSub.endLayer).length
      : 0;
    const subReadyToMerge = subPlanCount > 0 && subMatchedIndices.length >= subPlanCount;

    const isComplete =
      !this.isSandbox &&
      this.plan.length > 0 &&
      matchedIndices.length === this.plan.length &&
      mainMatch.placedVoxelCount === mainMatch.planVoxelCount &&
      (!this.model.standMount || this.standMounted);
    if (isComplete && !this.completedTriggered) {
      this.completedTriggered = true;
      playClick('complete');
      triggerHaptic('complete');
      this.spawnCompletionFireworks();
      this.viewKey = 'build';
      this.tweenCameraTo(this.getViewPreset('build'));
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

    const trayCounts = this.trays.map(t => this.getPoolBricksInTray(t.index).length);
    const strayDeskCount = this.countStrayDeskBricks();
    const hasStandMount = Boolean(this.model.standMount && !this.isSandbox);
    const standReadyToMount = hasStandMount && this.isCharacterReadyForStand();

    this.callbacks.onSnapshot({
      totalBricks: this.bricks.length,
      planCount: this.plan.length,
      matchedCount: matchedIndices.length,
      matchedIndices,
      boxOpened: this.boxOpened,
      boxOpening: this.boxOpening,
      openedPacks: [...this.openedPacks],
      pouches: this.pouches,
      packTrayMap: [...this.packTrayMap],
      pouringPack: this.activePour ? this.activePour.packIdx : null,
      activeTray: this.activeTray,
      trayCount: this.trays.length,
      deepTrayIndex: this.deepTrayIndex,
      trayNames: this.trays.map(t => t.name),
      trayKinds: this.trays.map(t => t.kind),
      trayCounts,
      traySoftCaps: this.trays.map(t => t.softCap),
      strayDeskCount,
      overflowNotice: this.overflowNotice,
      curtainOpen: this.curtainOpen,
      timeOfDay: this.timeOfDay,
      currentView: this.viewKey,
      isComplete,
      heldActive: Boolean(this.held),
      heldCount: this.heldGroup.length,
      singlePluckMode: this.singlePluckMode,
      interactionMode: this.interactionMode,
      resolvedControlStyle: this.getResolvedControlStyle(),
      canUndo: this.undoStack.length > 0,
      undoCount: this.undoStack.length,
      poolCount,
      placedCount,
      pressedCount,
      subAssemblyEnabled: this.subAssemblyEnabled,
      hasSubAssemblies: Boolean(activeSub),
      activeSubName: activeSub?.name ?? null,
      subMatchedCount: subMatchedIndices.length,
      subPlanCount,
      subReadyToMerge,
      hasStandMount,
      standMounted: this.standMounted,
      standReadyToMount,
    });
  }

  private scheduleAutoSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (this.disposed) return;
      const { records, openedPacks } = this.exportRecords();
      this.callbacks.onAutoSave(records, openedPacks, this.boxOpened);
    }, 450);
  }

  private spawnCompletionFireworks(): void {
    if (this.disposed) return;

    if (!this.fireworkGeo) {
      this.fireworkGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    }
    if (this.fireworkMats.length === 0) {
      const hexSet = new Set<number>([0xf4c430, 0x7fe3ff, 0xff6b9d, 0x9ef06b]);
      for (const c of this.palette) {
        hexSet.add(c.hex);
      }
      for (const hex of hexSet) {
        this.fireworkMats.push(new THREE.MeshBasicMaterial({ color: hex }));
      }
    }

    for (const t of this.fireworkTimers) window.clearTimeout(t);
    this.fireworkTimers = [];

    const topY = BUILD_TOP_Y + Math.max(3, this.model.masks.length) * BRICK_H + 1.1;
    const offsets: Array<{ dx: number; dy: number; dz: number; delay: number }> = [
      { dx: 0, dy: 0.3, dz: 0, delay: 0 },
      { dx: -2.2, dy: 0.9, dz: -1.1, delay: 300 },
      { dx: 2.3, dy: 0.6, dz: 1.0, delay: 620 },
    ];

    const spawnBurst = (cx: number, cy: number, cz: number) => {
      if (this.disposed || !this.fireworkGeo || this.fireworkMats.length === 0) return;
      const count = 32;
      for (let i = 0; i < count; i++) {
        const mat = this.fireworkMats[(i + Math.floor(Math.random() * 5)) % this.fireworkMats.length];
        const mesh = new THREE.Mesh(this.fireworkGeo, mat);
        mesh.position.set(cx, cy, cz);
        this.scene.add(mesh);

        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const speed = 3.8 + Math.random() * 4.4;
        const vel = new THREE.Vector3(
          Math.sin(phi) * Math.cos(theta) * speed,
          Math.abs(Math.cos(phi)) * speed * 0.85 + 2.4,
          Math.sin(phi) * Math.sin(theta) * speed
        );
        const spin = new THREE.Vector3(
          (Math.random() - 0.5) * 14,
          (Math.random() - 0.5) * 14,
          (Math.random() - 0.5) * 14
        );
        this.fireworkParticles.push({
          mesh,
          vel,
          spin,
          life: 0,
          maxLife: 1.15 + Math.random() * 0.45,
        });
      }
    };

    for (const o of offsets) {
      if (o.delay === 0) {
        spawnBurst(this.padCx + o.dx, topY + o.dy, this.padCz + o.dz);
      } else {
        const timer = window.setTimeout(() => {
          spawnBurst(this.padCx + o.dx, topY + o.dy, this.padCz + o.dz);
        }, o.delay);
        this.fireworkTimers.push(timer);
      }
    }
  }

  private updateFireworks(dt: number): void {
    if (this.fireworkParticles.length === 0) return;
    const drag = Math.max(0, 1 - dt * 1.4);
    for (let i = this.fireworkParticles.length - 1; i >= 0; i--) {
      const p = this.fireworkParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.scene.remove(p.mesh);
        this.fireworkParticles.splice(i, 1);
        continue;
      }
      p.vel.y -= 13.5 * dt;
      p.vel.multiplyScalar(drag);
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
      const t = p.life / p.maxLife;
      const s = Math.max(0.01, (1 - t * t) * 1.15);
      p.mesh.scale.setScalar(s);
    }
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

    this.updateBoxOpening(dt);
    this.updateActivePour(dt);
    this.updateFireworks(dt);
    this.updateInteraction(dt);
    this.roomDiorama?.update(dt, this.curtainOpen, this.timeOfDay);

    this.accPhysics += dt;
    let steps = 0;
    while (this.accPhysics >= this.world.timestep && steps < 2) {
      this.world.step();
      this.accPhysics -= this.world.timestep;
      steps++;
    }
    if (this.accPhysics > this.world.timestep * 2) {
      this.accPhysics = 0;
    }

    for (const b of this.bricks) {
      // 已鎖定且不在彈跳動畫中的積木完全不用每幀同步 transform
      if (b.state === 'pressed' && b.snapAnim <= 0) continue;
      if (b.state === 'placed') continue;
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
        const fallbackTray = this.trays[this.deepTrayIndex] ?? this.trays[b.trayIndex] ?? this.trays[0];
        b.body.setTranslation(
          { x: fallbackTray.cx, y: TRAY_FLOOR_TOP + BRICK_H * 8, z: fallbackTray.cz },
          true
        );
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
    }

    this.controls.update();
    if (this.camera.position.y < 1.45) {
      this.camera.position.y = 1.45;
    }
    this.renderer.render(this.scene, this.camera);

    // 偵測桌面散落積木是否達到門檻：非傾倒、非抓取且靜置超過 1.4 秒 -> 自動召喚動物進場整理
    if (this.autoTidyCooldown > 0) {
      this.autoTidyCooldown = Math.max(0, this.autoTidyCooldown - dt);
    }
    if (!this.activePour && !this.held && !this.boxOpening && this.autoTidyCooldown <= 0) {
      this.autoTidyCheckAcc += dt;
      if (this.autoTidyCheckAcc >= 0.25) {
        this.autoTidyCheckAcc = 0;
        const stray = this.countStrayDeskBricks();
        if (stray >= 6) {
          this.straySettleSec += 0.25;
          if (this.straySettleSec >= 1.4) {
            this.straySettleSec = 0;
            this.autoTidyCooldown = 9.0;
            this.callbacks.onAutoAnimalTidy?.(stray);
          }
        } else {
          this.straySettleSec = Math.max(0, this.straySettleSec - 0.25);
        }
      }
    } else {
      this.straySettleSec = 0;
    }

    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.8) {
      const fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
      this.callbacks.onFps?.(fps);
    }

    this.frameId = requestAnimationFrame(this.tick);
  };

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.frameId);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (this.finderHighlightTimer !== null) window.clearTimeout(this.finderHighlightTimer);
    if (this.overflowNoticeTimer !== null) window.clearTimeout(this.overflowNoticeTimer);
    for (const t of this.fireworkTimers) window.clearTimeout(t);
    this.fireworkTimers = [];
    for (const p of this.fireworkParticles) this.scene.remove(p.mesh);
    this.fireworkParticles = [];
    this.fireworkGeo?.dispose();
    for (const m of this.fireworkMats) m.dispose();
    this.fireworkMats = [];
    if (this.boxGroup) this.disposeGroupOwnedResources(this.boxGroup);
    this.boxArtworkTex?.dispose();
    this.boxArtworkTex = null;
    if (this.standMountGroup) {
      this.disposeGroupOwnedResources(this.standMountGroup);
      this.scene.remove(this.standMountGroup);
      this.standMountGroup = null;
      this.standCradleHitMesh = null;
    }
    for (const grp of this.waitingPouches.values()) this.disposeGroupOwnedResources(grp);
    if (this.activePour) this.disposeGroupOwnedResources(this.activePour.pouchGroup);
    this.roomDiorama?.dispose();
    this.roomDiorama = null;

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
    this.brickMeshes = [];
    this.controls?.dispose();
    this.pmremEnv?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      canvas?.parentNode?.removeChild(canvas);
    }
  }
}
