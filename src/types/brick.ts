export type ShapeKey =
  | '1x1'
  | '1x2'
  | '1x3'
  | '1x4'
  | '2x2'
  | '2x3'
  | '2x4'
  | '4x4'
  | 'L3'
  | 'slope1x1'
  | 'slope1x2';

export type MaterialFinish = 'plastic' | 'matte' | 'metallic' | 'glass';

export interface ColorDef {
  code: string;
  name: string;
  hex: number;
  finish?: MaterialFinish;
  transparent?: boolean;
  opacity?: number;
}

export interface ShapeDef {
  cells: [number, number][];
  studCells?: [number, number][];
  isSlope?: boolean;
  label: string;
}

export interface SpecialBrickSpec {
  shape: ShapeKey;
  rot: number;
  color: number;
  gx: number; // local mask X (before board centering offset)
  gz: number; // local mask Z (before board centering offset)
  layer: number;
}

export interface StandMountRule {
  label: string;
  charZoneMinGx: number; // local mask X where the tiltable character begins
  standLocalGx: number;  // local mask X of the translucent stand cradle
  standLocalGz: number;  // local mask Z of the translucent stand cradle
  standBaseYLayer: number; // layer height of stand cradle base above pad
  tiltXDeg: number;      // backward lean pitch angle (e.g. -38)
  tiltZDeg: number;      // comical sideways slip roll angle (e.g. 9)
}

export interface PlanBrick {
  index: number;
  shape: ShapeKey;
  rot: number;
  color: number;
  gx: number;
  gz: number;
  layer: number;
  cells: string[];
  bb: { w: number; d: number };
  cellSet: Set<string>;
  packIndex: number;
  trayIndex: number;
}

export interface BuildStep {
  stepIndex: number;
  layer: number;
  sectionName?: string;
  bricks: PlanBrick[];
  prevBricks: PlanBrick[];
}

export interface PackRule {
  label: string;
  maxLayer: number;
  trayIndex: number;
}

export interface PouchSpec {
  index: number;
  label: string;
  colorIdx: number;
  shapeHint: ShapeKey | 'mixed';
  count: number;
  defaultTrayIndex: number;
}

export type RoomTimeOfDay = 'day' | 'night';

export interface SectionRule {
  name: string;
  maxLayer: number;
}

export interface SubAssemblyRule {
  id: string;
  name: string;
  startLayer: number;
  endLayer: number;
}

export interface BrickModel {
  id: string;
  name: string;
  subtitle: string;
  difficulty: '入門' | '標準' | '進階';
  palette: ColorDef[];
  board: { w: number; d: number };
  masks: string[][];
  specialBricks?: SpecialBrickSpec[];
  standMount?: StandMountRule;
  packs: PackRule[];
  sections?: SectionRule[];
  subAssemblies?: SubAssemblyRule[];
  largePlateLayers?: number[];
  allowLargePlates?: boolean;
  isCustom?: boolean;
}

export type PlacementMode = 'instant' | 'two-step';
export type ManualViewMode = 'steps' | 'layers';
export type ControlStyle = 'auto' | 'drag' | 'tap';
export type InteractionMode = 'grab' | 'rummage' | 'separator';

export interface FeelSettings {
  placementMode: PlacementMode;
  controlStyle: ControlStyle;
  dragSmoothing: number; // 10..36, default 22
  holdHeightMul: number; // 0.8..2.0, default 1.25
  snapTolerance: number; // 0.8..2.0, default 1.2
  soundEnabled: boolean;
  hapticsEnabled: boolean;
  autoFollowBuildView: boolean;
  showStepGuide: boolean;
}

export interface SavedBrickRecord {
  shape: ShapeKey;
  color: number;
  rot: number;
  state: 'pool' | 'placed' | 'pressed';
  gx?: number;
  gz?: number;
  layer?: number;
  pos: [number, number, number];
  quat: [number, number, number, number];
  trayIndex?: number;
  pad?: 'main' | 'sub';
  mountedOnStand?: boolean;
}

export interface SavedBuildState {
  modelId: string;
  customModel?: BrickModel;
  boxOpened?: boolean;
  openedPacks: boolean[];
  trayNames?: string[];
  elapsedSec: number;
  bricks: SavedBrickRecord[];
  updatedAt: number;
}

export interface ShowcaseEntry {
  id: string;
  modelId: string;
  modelName: string;
  brickCount: number;
  layerCount: number;
  elapsedSec: number;
  completedAt: number;
}

export interface SandboxSaveState {
  bricks: SavedBrickRecord[];
  palette?: ColorDef[];
  trayNames?: string[];
  updatedAt: number;
}

export interface WorkshopSaveStore {
  version: number;
  activeBuild: SavedBuildState | null;
  showcase: ShowcaseEntry[];
  sandbox: SandboxSaveState | null;
  feel: FeelSettings;
  trayNames?: string[];
}

export interface WorkshopHudSnapshot {
  totalBricks: number;
  planCount: number;
  matchedCount: number;
  matchedIndices: number[];
  boxOpened: boolean;
  boxOpening: boolean;
  openedPacks: boolean[];
  pouches: PouchSpec[];
  packTrayMap: (number | null)[];
  pouringPack: number | null;
  activeTray: number;
  trayCount: number;
  deepTrayIndex: number;
  trayNames: string[];
  trayKinds: ('small' | 'deep')[];
  trayCounts: number[];
  traySoftCaps: number[];
  strayDeskCount: number;
  overflowNotice: { message: string; id: number } | null;
  curtainOpen: boolean;
  timeOfDay: RoomTimeOfDay;
  currentView: 'build' | 'wide' | 'tray' | 'subpad';
  isComplete: boolean;
  heldActive: boolean;
  heldCount: number;
  singlePluckMode: boolean;
  interactionMode: InteractionMode;
  resolvedControlStyle: 'drag' | 'tap';
  canUndo: boolean;
  undoCount: number;
  poolCount: number;
  placedCount: number;
  pressedCount: number;
  subAssemblyEnabled: boolean;
  hasSubAssemblies: boolean;
  activeSubName: string | null;
  subMatchedCount: number;
  subPlanCount: number;
  subReadyToMerge: boolean;
  hasStandMount: boolean;
  standMounted: boolean;
  standReadyToMount: boolean;
}
