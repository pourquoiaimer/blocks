import type {
  FeelSettings,
  SandboxSaveState,
  SavedBuildState,
  ShowcaseEntry,
  WorkshopSaveStore,
} from '../types/brick';

const STORAGE_KEY = 'brick_workshop_save_v1';
const MAX_SHOWCASE = 3;

export const DEFAULT_FEEL: FeelSettings = {
  placementMode: 'instant',
  dragSmoothing: 22,
  holdHeightMul: 1.25,
  snapTolerance: 1.2,
  soundEnabled: true,
  showStepGuide: false,
};

function defaultStore(): WorkshopSaveStore {
  return {
    version: 1,
    activeBuild: null,
    showcase: [],
    sandbox: null,
    feel: { ...DEFAULT_FEEL },
  };
}

function getBackingStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null {
  try {
    const cgData = window.CrazyGames?.SDK?.data;
    if (cgData?.getItem && cgData?.setItem) {
      return cgData as { getItem(k: string): string | null; setItem(k: string, v: string): void };
    }
  } catch {
    // fallback to localStorage
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSaveStore(): WorkshopSaveStore {
  const storage = getBackingStorage();
  if (!storage) return defaultStore();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw) as Partial<WorkshopSaveStore>;
    return {
      version: 1,
      activeBuild: parsed.activeBuild ?? null,
      showcase: Array.isArray(parsed.showcase) ? parsed.showcase.slice(0, MAX_SHOWCASE) : [],
      sandbox: parsed.sandbox ?? null,
      feel: { ...DEFAULT_FEEL, ...(parsed.feel ?? {}) },
    };
  } catch {
    return defaultStore();
  }
}

function persistStore(store: WorkshopSaveStore): void {
  const storage = getBackingStorage();
  if (!storage) return;
  try {
    const serialized = JSON.stringify(store);
    // 遵守容量規劃：確保遠低於 CrazyGames 1MB 上限
    if (serialized.length > 900_000) return;
    storage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Ignore quota errors
  }
}

export function saveActiveBuild(build: SavedBuildState | null): WorkshopSaveStore {
  const store = loadSaveStore();
  store.activeBuild = build;
  persistStore(store);
  return store;
}

export function saveSandboxState(sandbox: SandboxSaveState | null): WorkshopSaveStore {
  const store = loadSaveStore();
  store.sandbox = sandbox;
  persistStore(store);
  return store;
}

export function saveFeelSettings(feel: FeelSettings): WorkshopSaveStore {
  const store = loadSaveStore();
  store.feel = { ...feel };
  persistStore(store);
  return store;
}

export function pushShowcaseEntry(entry: Omit<ShowcaseEntry, 'id'>): WorkshopSaveStore {
  const store = loadSaveStore();
  const next: ShowcaseEntry = {
    ...entry,
    id: `${entry.modelId}_${Date.now()}`,
  };
  const filtered = store.showcase.filter(s => s.modelId !== entry.modelId);
  store.showcase = [next, ...filtered].slice(0, MAX_SHOWCASE);
  persistStore(store);
  return store;
}

export function removeShowcaseEntry(id: string): WorkshopSaveStore {
  const store = loadSaveStore();
  store.showcase = store.showcase.filter(s => s.id !== id);
  persistStore(store);
  return store;
}

export function getSaveByteSize(): number {
  const storage = getBackingStorage();
  if (!storage) return 0;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? new Blob([raw]).size : 0;
  } catch {
    return 0;
  }
}
