export type ShapeKey = '1x1' | '1x2' | '1x4';

export interface ColorDef {
  code: string;
  name: string;
  hex: number;
  transparent?: boolean;
  opacity?: number;
}

export interface ShapeDef {
  cells: [number, number][];
  label: string;
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
  packs: PackRule[];
  sections?: SectionRule[];
  subAssemblies?: SubAssemblyRule[];
  isCustom?: boolean;
}

export type PlacementMode = 'instant' | 'two-step';
export type ManualViewMode = 'steps' | 'layers';

export interface FeelSettings {
  placementMode: PlacementMode;
  dragSmoothing: number; // 10..36, default 22
  holdHeightMul: number; // 0.8..2.0, default 1.25
  snapTolerance: number; // 0.8..2.0, default 1.2
  soundEnabled: boolean;
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
}

export interface SavedBuildState {
  modelId: string;
  customModel?: BrickModel;
  boxOpened?: boolean;
  openedPacks: boolean[];
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
  updatedAt: number;
}

export interface WorkshopSaveStore {
  version: number;
  activeBuild: SavedBuildState | null;
  showcase: ShowcaseEntry[];
  sandbox: SandboxSaveState | null;
  feel: FeelSettings;
}

export interface WorkshopHudSnapshot {
  totalBricks: number;
  planCount: number;
  matchedCount: number;
  matchedIndices: number[];
  boxOpened: boolean;
  boxOpening: boolean;
  openedPacks: boolean[];
  packTrayMap: (number | null)[];
  pouringPack: number | null;
  activeTray: number;
  trayCount: number;
  currentView: 'build' | 'wide' | 'tray' | 'subpad';
  isComplete: boolean;
  heldActive: boolean;
  heldCount: number;
  singlePluckMode: boolean;
  interactionMode: 'grab' | 'rummage';
  poolCount: number;
  placedCount: number;
  pressedCount: number;
  subAssemblyEnabled: boolean;
  hasSubAssemblies: boolean;
  activeSubName: string | null;
  subMatchedCount: number;
  subPlanCount: number;
  subReadyToMerge: boolean;
}
