import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Blinds,
  Boxes,
  Check,
  CheckCircle2,
  Compass,
  Eye,
  EyeOff,
  Hand,
  Maximize2,
  Moon,
  MousePointer,
  Package,
  PackageOpen,
  PanelRightOpen,
  PawPrint,
  Pencil,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Share2,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Undo2,
  Wrench,
} from 'lucide-react';
import type {
  BrickModel,
  BuildStep,
  ColorDef,
  FeelSettings,
  ManualViewMode,
  MaterialFinish,
  SavedBrickRecord,
  ShapeKey,
  WorkshopHudSnapshot,
  WorkshopSaveStore,
} from './types/brick';
import { MODELS, SANDBOX_PALETTE, getModelById } from './data/models';
import { SHAPES, buildPlan, buildSortedPouches, buildSteps } from './engine/brickPlanner';
import { BrickWorkshopEngine } from './engine/BrickWorkshopEngine';
import {
  getSaveByteSize,
  loadSaveStore,
  pushShowcaseEntry,
  removeShowcaseEntry,
  saveActiveBuild,
  saveFeelSettings,
  saveSandboxState,
  saveTrayNames,
} from './services/storage';
import { cgGameplayStart, cgGameplayStop, cgHappytime, initCrazyGames } from './services/crazyGames';
import { encodeModelShareCode } from './services/modelShare';
import { WorkshopMenu } from './components/WorkshopMenu';
import { InstructionPanel, LayerGridDiagram, formatViewDirection } from './components/InstructionPanel';
import { IsometricStepSvg } from './components/IsometricStepSvg';
import { FeelSettingsModal } from './components/FeelSettingsModal';
import { MaskBuilderModal } from './components/MaskBuilderModal';

type ActiveSession =
  | { kind: 'menu' }
  | {
      kind: 'model';
      model: BrickModel;
      initialRecords?: SavedBrickRecord[];
      initialOpenedPacks?: boolean[];
      initialBoxOpened?: boolean;
      initialElapsedSec: number;
    }
  | {
      kind: 'sandbox';
      initialRecords?: SavedBrickRecord[];
      initialPalette?: ColorDef[];
    };

const SANDBOX_MODEL: BrickModel = {
  id: 'sandbox',
  name: '無限自由模式',
  subtitle: '調色盤自訂色彩＋透明支撐零件按需產出 · 20×14 加大雙托盤創作',
  difficulty: '標準',
  palette: SANDBOX_PALETTE,
  board: { w: 20, d: 14 },
  masks: [],
  packs: [],
};

export default function App() {
  const [saveStore, setSaveStore] = useState<WorkshopSaveStore>(() => loadSaveStore());
  const [saveBytes, setSaveBytes] = useState<number>(() => getSaveByteSize());
  const [feel, setFeel] = useState<FeelSettings>(() => loadSaveStore().feel);
  const [session, setSession] = useState<ActiveSession>({ kind: 'menu' });

  const [hud, setHud] = useState<WorkshopHudSnapshot | null>(null);
  const [manualMode, setManualMode] = useState<ManualViewMode>('steps');
  const [activeStepIdx, setActiveStepIdx] = useState(0);
  const [panelOpen, setPanelOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  );
  const [hudCompact, setHudCompact] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );

  const [showFeelModal, setShowFeelModal] = useState(false);
  const [showMaskModal, setShowMaskModal] = useState(false);
  const [zoomStep, setZoomStep] = useState<BuildStep | null>(null);
  const [zoomLayer, setZoomLayer] = useState<number | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [manualYawDeg, setManualYawDeg] = useState(32);
  const [manualPitchDeg, setManualPitchDeg] = useState(30);
  const [sandboxCopied, setSandboxCopied] = useState<'ok' | 'empty' | null>(null);
  const [editingTrayIdx, setEditingTrayIdx] = useState<number | null>(null);
  const [editingTrayText, setEditingTrayText] = useState('');
  const [tidyOverlay, setTidyOverlay] = useState<{
    title: string;
    message: string;
    timeOfDay: 'day' | 'night';
  } | null>(null);
  const tidyTimersRef = useRef<number[]>([]);

  const handleRotateManual = useCallback((yawDeg: number, pitchDeg: number) => {
    setManualYawDeg(yawDeg);
    setManualPitchDeg(pitchDeg);
  }, []);

  // Sandbox dispenser controls
  const [sbShape, setSbShape] = useState<ShapeKey>('1x2');
  const [sbColor, setSbColor] = useState(0);
  const [sbPalette, setSbPalette] = useState<ColorDef[]>(SANDBOX_PALETTE);
  const [sbCustomHex, setSbCustomHex] = useState('#e8a87c');
  const [sbCustomFinish, setSbCustomFinish] = useState<MaterialFinish>('plastic');
  const [sbSpawnQty, setSbSpawnQty] = useState<1 | 4>(4);

  const canvasMountRef = useRef<HTMLDivElement>(null);
  const fpsSpanRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<BrickWorkshopEngine | null>(null);
  const sessionStartMsRef = useRef<number>(Date.now());
  const baseElapsedRef = useRef<number>(0);
  const completedRecordedRef = useRef<boolean>(false);
  const autoTidyHandlerRef = useRef<(strayCount: number) => void>(() => {});

  const activeModel = session.kind === 'model' ? session.model : session.kind === 'sandbox' ? SANDBOX_MODEL : null;
  const plan = useMemo(
    () => (session.kind === 'model' ? buildPlan(session.model) : []),
    [session]
  );
  const fallbackPouches = useMemo(
    () => (session.kind === 'model' ? buildSortedPouches(session.model) : []),
    [session]
  );
  const steps = useMemo(
    () => buildSteps(plan, session.kind === 'model' ? session.model.sections : undefined),
    [plan, session]
  );

  useEffect(() => {
    void initCrazyGames();
  }, []);

  const refreshSaveMeta = useCallback((nextStore: WorkshopSaveStore) => {
    setSaveStore(nextStore);
    setSaveBytes(getSaveByteSize());
  }, []);

  // Auto-advance step indicator when current step finishes
  useEffect(() => {
    if (!hud || session.kind !== 'model' || steps.length === 0) return;
    const matchedSet = new Set(hud.matchedIndices);
    const cur = steps[activeStepIdx];
    if (cur && cur.bricks.every(b => matchedSet.has(b.index))) {
      const nextUndone = steps.findIndex(st => st.bricks.some(b => !matchedSet.has(b.index)));
      if (nextUndone >= 0 && nextUndone !== activeStepIdx) {
        setActiveStepIdx(nextUndone);
      }
    }
  }, [hud, steps, activeStepIdx, session.kind]);

  // Sync current step guide wireframe to 3D engine
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (session.kind === 'model' && steps[activeStepIdx]) {
      engine.setGuideBricks(steps[activeStepIdx].bricks);
    } else {
      engine.setGuideBricks([]);
    }
  }, [activeStepIdx, steps, session.kind]);

  // Record completion into 3-slot Showcase once per model completion
  useEffect(() => {
    if (session.kind !== 'model' || !hud?.isComplete || completedRecordedRef.current) return;
    completedRecordedRef.current = true;
    const elapsedSec =
      baseElapsedRef.current + Math.round((Date.now() - sessionStartMsRef.current) / 1000);
    const next = pushShowcaseEntry({
      modelId: session.model.id,
      modelName: session.model.name,
      brickCount: plan.length,
      layerCount: session.model.masks.length,
      elapsedSec,
      completedAt: Date.now(),
    });
    // 清除已完成的 activeBuild，騰出製作中插槽
    const cleared = saveActiveBuild(null);
    refreshSaveMeta({ ...next, activeBuild: cleared.activeBuild });
    cgHappytime();
  }, [hud?.isComplete, session, plan.length, refreshSaveMeta]);

  // Mount & tear down 3D engine when entering/leaving workbench
  useEffect(() => {
    if (session.kind === 'menu') {
      cgGameplayStop();
      return;
    }

    const mount = canvasMountRef.current;
    if (!mount) return;

    let cancelled = false;
    setContextLost(false);
    completedRecordedRef.current = false;
    sessionStartMsRef.current = Date.now();
    baseElapsedRef.current = session.kind === 'model' ? session.initialElapsedSec : 0;
    setActiveStepIdx(0);

    const activeSbPalette =
      session.kind === 'sandbox' && session.initialPalette?.length
        ? session.initialPalette
        : SANDBOX_PALETTE;
    if (session.kind === 'sandbox') {
      setSbPalette(activeSbPalette);
      setSbColor(c => (c < activeSbPalette.length ? c : 0));
    }

    const model = session.kind === 'model' ? session.model : SANDBOX_MODEL;
    const engine = new BrickWorkshopEngine(
      mount,
      model,
      feel,
      {
        onSnapshot: snap => {
          if (!cancelled) setHud(snap);
        },
        onFps: fps => {
          if (fpsSpanRef.current) fpsSpanRef.current.textContent = `${fps} fps`;
        },
        onAutoSave: (records, openedPacks, boxOpened) => {
          if (cancelled) return;
          const latestNames = loadSaveStore().trayNames;
          if (session.kind === 'sandbox') {
            const store = saveSandboxState({
              bricks: records,
              palette: engineRef.current?.getPalette() ?? activeSbPalette,
              trayNames: latestNames,
              updatedAt: Date.now(),
            });
            refreshSaveMeta(store);
          } else if (session.kind === 'model' && !completedRecordedRef.current) {
            const elapsedSec =
              baseElapsedRef.current + Math.round((Date.now() - sessionStartMsRef.current) / 1000);
            const store = saveActiveBuild({
              modelId: session.model.id,
              customModel: session.model.isCustom ? session.model : undefined,
              boxOpened,
              openedPacks,
              trayNames: latestNames,
              elapsedSec,
              bricks: records,
              updatedAt: Date.now(),
            });
            refreshSaveMeta(store);
          }
        },
        onTrayNamesChange: names => {
          if (!cancelled) {
            refreshSaveMeta(saveTrayNames(names));
          }
        },
        onAutoAnimalTidy: strayCount => {
          if (!cancelled) {
            autoTidyHandlerRef.current(strayCount);
          }
        },
        onContextLost: () => {
          if (!cancelled) setContextLost(true);
        },
      },
      {
        isSandbox: session.kind === 'sandbox',
        sandboxPalette: activeSbPalette,
        trayNames: saveStore.trayNames,
      }
    );

    engineRef.current = engine;
    const initRecords = session.initialRecords;
    const initPacks = session.kind === 'model' ? session.initialOpenedPacks : undefined;
    const initBoxOpened = session.kind === 'model' ? session.initialBoxOpened : undefined;

    void engine.init(initRecords, initPacks, initBoxOpened).then(() => {
      if (!cancelled) {
        cgGameplayStart();
        const st = buildSteps(
          session.kind === 'model' ? buildPlan(session.model) : [],
          session.kind === 'model' ? session.model.sections : undefined
        );
        if (st[0]) engine.setGuideBricks(st[0].bricks);
      }
    });

    return () => {
      cancelled = true;
      for (const tid of tidyTimersRef.current) window.clearTimeout(tid);
      tidyTimersRef.current = [];
      setTidyOverlay(null);
      setEditingTrayIdx(null);
      engine.dispose();
      engineRef.current = null;
      setHud(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Global keyboard shortcuts (H toggle manual, F9 instant test build)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (session.kind === 'menu') return;
      if (e.key === 'h' || e.key === 'H') {
        setPanelOpen(v => !v);
      } else if (e.key === 'F9' && session.kind === 'model') {
        e.preventDefault();
        engineRef.current?.autoBuildAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session.kind]);

  const handleFeelChange = (next: FeelSettings) => {
    setFeel(next);
    const store = saveFeelSettings(next);
    refreshSaveMeta(store);
    engineRef.current?.updateFeel(next);
  };

  const startFreshModel = (model: BrickModel) => {
    setSession({
      kind: 'model',
      model,
      initialElapsedSec: 0,
    });
  };

  const resumeActiveBuild = () => {
    const ab = saveStore.activeBuild;
    if (!ab) return;
    const m = ab.customModel ?? getModelById(ab.modelId) ?? MODELS[0];
    setSession({
      kind: 'model',
      model: m,
      initialRecords: ab.bricks,
      initialOpenedPacks: ab.openedPacks,
      initialBoxOpened: ab.boxOpened ?? (ab.bricks.length > 0 || ab.openedPacks.some(Boolean)),
      initialElapsedSec: ab.elapsedSec,
    });
  };

  const openSandbox = (resume: boolean) => {
    setSession({
      kind: 'sandbox',
      initialRecords: resume ? saveStore.sandbox?.bricks : undefined,
      initialPalette: resume ? saveStore.sandbox?.palette : undefined,
    });
  };

  const runAnimalTidy = (autoCount?: number) => {
    const engine = engineRef.current;
    if (!engine || tidyOverlay) return;
    const tod = hud?.timeOfDay ?? 'day';
    const hasSmallOverflow = Boolean(
      hud?.trayCounts.some((c, i) => i !== hud.deepTrayIndex && c > (hud.traySoftCaps[i] ?? 22))
    );
    const hasStray = (autoCount ?? hud?.strayDeskCount ?? 0) > 0;
    if (!hasStray && !hasSmallOverflow) {
      setTidyOverlay({
        title: tod === 'day' ? '窗外乳牛探頭看了一下' : '窗外貓頭鷹眨了眨眼',
        message: '目前桌面與各小盤都還很整齊，沒有散落或滿出來的積木需要整理喔！',
        timeOfDay: tod,
      });
      const tEnd = window.setTimeout(() => setTidyOverlay(null), 1500);
      tidyTimersRef.current.push(tEnd);
      return;
    }

    const prefix =
      autoCount !== undefined
        ? `桌上散落了 ${autoCount} 顆積木！`
        : '';

    engine.playAnimalTidyAnimation();
    setTidyOverlay({
      title: tod === 'day' ? '窗外乳牛走進書桌整理零件…' : '夜棲貓頭鷹飛入書桌收拾零件…',
      message:
        tod === 'day'
          ? `${prefix}草地黑白乳牛跨過窗台走近桌面，用鼻子把散落與溢出的積木推進盤子與深籃（不分類顏色）。`
          : `${prefix}樹梢貓頭鷹展翅飛進窗內盤旋，拍翅把散落桌面的積木收攏回盤子與深籃中。`,
      timeOfDay: tod,
    });
    const tRun = window.setTimeout(() => {
      engineRef.current?.tidyOverflowWithAnimal();
    }, 1250);
    const tEnd = window.setTimeout(() => {
      setTidyOverlay(null);
    }, 3300);
    tidyTimersRef.current.push(tRun, tEnd);
  };

  autoTidyHandlerRef.current = (strayCount: number) => {
    runAnimalTidy(strayCount);
  };

  const triggerAnimalTidy = () => runAnimalTidy();

  const backToMenu = () => {
    // Flush latest snapshot before leaving
    const engine = engineRef.current;
    if (engine && session.kind !== 'menu') {
      const { records, openedPacks } = engine.exportRecords();
      const latestNames = loadSaveStore().trayNames;
      if (session.kind === 'sandbox') {
        refreshSaveMeta(
          saveSandboxState({
            bricks: records,
            palette: engine.getPalette(),
            trayNames: latestNames,
            updatedAt: Date.now(),
          })
        );
      } else if (session.kind === 'model' && !completedRecordedRef.current) {
        const elapsedSec =
          baseElapsedRef.current + Math.round((Date.now() - sessionStartMsRef.current) / 1000);
        refreshSaveMeta(
          saveActiveBuild({
            modelId: session.model.id,
            customModel: session.model.isCustom ? session.model : undefined,
            boxOpened: hud?.boxOpened ?? true,
            openedPacks,
            trayNames: latestNames,
            elapsedSec,
            bricks: records,
            updatedAt: Date.now(),
          })
        );
      }
    }
    setSession({ kind: 'menu' });
  };

  return (
    <div className="relative w-full h-full bg-[#15120f] overflow-hidden">
      {/* 主選單 / 圖紙庫 / 成品櫃 */}
      {session.kind === 'menu' && (
        <WorkshopMenu
          saveStore={saveStore}
          saveBytes={saveBytes}
          onSelectModel={startFreshModel}
          onResumeActive={resumeActiveBuild}
          onDiscardActive={() => refreshSaveMeta(saveActiveBuild(null))}
          onOpenSandbox={openSandbox}
          onOpenMaskBuilder={() => setShowMaskModal(true)}
          onOpenFeelSettings={() => setShowFeelModal(true)}
          onRemoveShowcase={id => refreshSaveMeta(removeShowcaseEntry(id))}
        />
      )}

      {/* 3D WebGL 畫布容器 */}
      {session.kind !== 'menu' && (
        <>
          <div ref={canvasMountRef} className="w-full h-full" />

          {/* WebGL Context Lost 優雅降級 */}
          {contextLost && (
            <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#15120f]/95 text-center p-6">
              <p className="text-base font-semibold text-white mb-2">3D 渲染內容暫時中斷</p>
              <p className="text-xs text-[#94a2b3] mb-4">系統已自動保存目前進度，請返回主選單重新載入。</p>
              <button
                type="button"
                onClick={backToMenu}
                className="px-4 py-2 rounded-xl bg-[#7fe3ff] text-[#0c141c] text-xs font-semibold"
              >
                返回模型庫
              </button>
            </div>
          )}

          {/* 左上精簡 HUD */}
          <div className="fixed left-2 sm:left-3 top-2 sm:top-3 z-10 flex flex-col gap-2 max-w-[calc(100vw-68px)] sm:max-w-[410px]">
            <div className="flex items-center gap-1.5 sm:gap-2 rounded-xl bg-[#11151b]/92 border border-white/10 px-2 sm:px-2.5 py-1.5 sm:py-2 shadow-xl">
              <button
                type="button"
                onClick={backToMenu}
                className="flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-lg bg-[#1e2530] hover:bg-[#2a3342] text-xs font-medium text-[#dce5f0] whitespace-nowrap transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">模型庫</span>
              </button>

              <div className="min-w-0 px-1 flex-1">
                <div className="text-xs font-semibold text-white truncate">
                  {activeModel?.name}
                  <span className="ml-2 text-[#7fe3ff] font-normal tabular-nums">
                    {session.kind === 'model'
                      ? `${hud?.matchedCount ?? 0}/${plan.length}`
                      : `${hud?.totalBricks ?? 0} 顆`}
                  </span>
                </div>
                <div className="text-[10.5px] text-[#8490a0] tabular-nums truncate">
                  {hud?.currentView === 'build'
                    ? '組裝區'
                    : hud?.currentView === 'subpad'
                      ? '子組裝台'
                      : hud?.currentView === 'tray'
                        ? (hud.trayNames[hud.activeTray] ?? `盤 ${(hud.activeTray ?? 0) + 1}`)
                        : '全景'}{' '}
                  · {hud?.resolvedControlStyle === 'tap' ? '點選拿放' : '長按拖曳'} ·{' '}
                  <span ref={fpsSpanRef}>60 fps</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  handleFeelChange({
                    ...feel,
                    controlStyle: (hud?.resolvedControlStyle ?? 'drag') === 'tap' ? 'drag' : 'tap',
                  })
                }
                title="快速切換操作手感：點選拿放（單手/手機友善）↔ 長按拖曳"
                className="px-2 py-1 rounded-lg bg-[#1b2430] hover:bg-[#253142] border border-white/10 text-[10.5px] font-medium text-[#9beaff] whitespace-nowrap shrink-0"
              >
                {(hud?.resolvedControlStyle ?? 'drag') === 'tap' ? '點放' : '拖曳'}
              </button>

              <button
                type="button"
                onClick={() => setShowFeelModal(true)}
                title="手感與震動設定"
                className="p-1.5 rounded-lg text-[#9aa6b5] hover:text-white hover:bg-white/10 shrink-0"
              >
                <SlidersHorizontal className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setHudCompact(v => !v)}
                title={hudCompact ? '展開操作提示' : '收起操作提示'}
                className="p-1.5 rounded-lg text-[#9aa6b5] hover:text-white hover:bg-white/10 shrink-0"
              >
                {hudCompact ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </button>
            </div>

            {/* 房間窗景與動物整理列 */}
            {hud && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => engineRef.current?.setCurtainOpen(!hud.curtainOpen)}
                  title="開關正前方書桌窗戶的窗簾，調整桌面光線與視野"
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-medium whitespace-nowrap transition-colors ${
                    hud.curtainOpen
                      ? 'bg-[#1b232e]/95 border-white/14 text-[#dce5f0] hover:bg-[#25303f]'
                      : 'bg-[#2a2219]/95 border-[#d8b482]/45 text-[#f2d6ad]'
                  }`}
                >
                  <Blinds className="w-3.5 h-3.5 text-[#f2d6ad]" />
                  {hud.curtainOpen ? '窗簾：開' : '窗簾：關'}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    engineRef.current?.setTimeOfDay(hud.timeOfDay === 'day' ? 'night' : 'day')
                  }
                  title="切換窗外白天（草地乳牛）或夜晚（樹梢貓頭鷹）"
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-medium whitespace-nowrap transition-colors ${
                    hud.timeOfDay === 'night'
                      ? 'bg-[#192038]/95 border-[#8cb4ff]/45 text-[#c7daff]'
                      : 'bg-[#1f2922]/95 border-[#7fdc9d]/40 text-[#c9f7d7]'
                  }`}
                >
                  {hud.timeOfDay === 'night' ? (
                    <Moon className="w-3.5 h-3.5 text-[#a9c6ff]" />
                  ) : (
                    <Sun className="w-3.5 h-3.5 text-[#ffd966]" />
                  )}
                  {hud.timeOfDay === 'night' ? '窗外：夜晚' : '窗外：白天'}
                </button>

                <button
                  type="button"
                  onClick={triggerAnimalTidy}
                  title="桌面散落 6 顆以上積木會自動召喚動物整理；也可隨時手動呼叫（不分類顏色）"
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-medium whitespace-nowrap transition-colors ${
                    hud.strayDeskCount > 0
                      ? 'bg-[#362717]/95 border-[#f4c430]/75 text-[#ffe18c]'
                      : 'bg-[#171d26]/92 border-white/12 text-[#b8c4d2] hover:text-white'
                  }`}
                >
                  <PawPrint className="w-3.5 h-3.5 text-[#f4c430]" />
                  {hud.strayDeskCount > 0
                    ? `呼叫動物整理（散落 ${hud.strayDeskCount}）`
                    : '呼叫動物整理'}
                </button>
              </div>
            )}

            {!hudCompact && (
              <div className="rounded-xl bg-[#11151b]/88 border border-white/10 px-3 py-2 text-[11px] leading-relaxed text-[#c6d0dc] pointer-events-none">
                {hud?.resolvedControlStyle === 'tap' ? (
                  <div>
                    <b className="text-[#7fe3ff]">點積木拿起</b> → 按螢幕 <b className="text-[#7fe3ff]">旋轉</b> →{' '}
                    <b className="text-[#7fe3ff]">再點底板</b> 拼上；雙指縮放與旋轉視角（可抬頭看窗外）
                  </div>
                ) : (
                  <div>
                    <b className="text-[#7fe3ff]">拖曳積木</b> 對位（<b className="text-[#7fe3ff]">R</b> 或第二指輕點轉 90°）
                    · <b className="text-[#f4c430]">F</b> 翻找 · <b className="text-[#ff9c5c]">X</b> 拆件器
                  </div>
                )}
                <div className="text-[#8e9aa8]">
                  {feel.placementMode === 'instant'
                    ? '放開／點擊綠框即壓緊；Ctrl+Z 復原 · 1~4 切換 3 小盤與地獄深籃'
                    : '放開先輕放微調 → 再輕點喀嗒壓緊 · 1~4 切換小盤與深籃'}
                </div>
              </div>
            )}
          </div>

          {/* 溢出與操作提示橫幅 */}
          {hud?.overflowNotice && (
            <div className="fixed left-1/2 top-3 -translate-x-1/2 z-20 px-3.5 py-2 rounded-xl bg-[#2c2115]/95 border border-[#f4c430]/60 text-xs text-[#ffe39a] shadow-2xl pointer-events-none max-w-[90vw] text-center">
              {hud.overflowNotice.message}
            </div>
          )}

          {/* 右側可收合說明書（H 快捷鍵） */}
          {session.kind === 'model' &&
            (panelOpen ? (
              <InstructionPanel
                model={session.model}
                plan={plan}
                steps={steps}
                matchedIndices={hud?.matchedIndices ?? []}
                manualMode={manualMode}
                onManualModeChange={setManualMode}
                activeStepIdx={activeStepIdx}
                onSelectStep={setActiveStepIdx}
                onZoomStep={setZoomStep}
                onZoomLayer={setZoomLayer}
                onCollapse={() => setPanelOpen(false)}
                showStepGuide={feel.showStepGuide}
                onToggleStepGuide={() =>
                  handleFeelChange({ ...feel, showStepGuide: !feel.showStepGuide })
                }
                manualYawDeg={manualYawDeg}
                manualPitchDeg={manualPitchDeg}
                onRotateManual={handleRotateManual}
              />
            ) : (
              <button
                type="button"
                onClick={() => setPanelOpen(true)}
                className="fixed right-3 top-3 z-10 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#11151b]/92 border border-white/12 text-xs font-medium text-[#dbe4ef] hover:border-[#7fe3ff]/50 shadow-lg"
              >
                <PanelRightOpen className="w-4 h-4 text-[#7fe3ff]" />
                展開說明書（H）
              </button>
            ))}

          {/* 未開箱提示按鈕 */}
          {session.kind === 'model' && hud && !hud.boxOpened && (
            <div className="fixed left-1/2 bottom-20 -translate-x-1/2 z-20 flex flex-col items-center gap-2 pointer-events-auto">
              <button
                type="button"
                disabled={hud.boxOpening}
                onClick={() => engineRef.current?.openBox(false)}
                className="flex items-center gap-2.5 px-5 py-3 rounded-2xl bg-[#f4c430] hover:bg-[#ffd54f] text-[#1a150f] text-sm font-bold shadow-2xl border border-white/30 transition-transform active:scale-95 disabled:opacity-70"
              >
                <Package className="w-5 h-5" />
                {hud.boxOpening
                  ? '正在開箱取出分裝小袋…'
                  : `點擊桌上的 ${session.model.name} 積木箱（或點此開箱）`}
              </button>
              <span className="text-[11px] text-[#c6d0dc] bg-[#11151b]/92 px-3 py-1 rounded-lg border border-white/10 text-center max-w-[90vw]">
                內含 {(hud.pouches.length || fallbackPouches.length)} 袋依顏色與尺寸分裝的小袋 · 開箱後每袋可看見真實零件，任選倒進 3 小盤或地獄深籃
              </span>
            </div>
          )}

          {/* 左下：3小盤+1地獄深籃管理 & 分裝小袋 / 工具列（抓放、翻找、拆件器、復原）/ 自由模式 */}
          <div className="fixed left-2 sm:left-3 bottom-2 sm:bottom-3 z-10 flex flex-col items-start gap-1.5 max-w-[calc(100vw-16px)] sm:max-w-[calc(100vw-350px)]">
            {hud && (session.kind === 'sandbox' || hud.boxOpened) && (
              <div className="flex flex-col gap-1.5 rounded-xl bg-[#11151b]/95 border border-white/12 p-2 shadow-xl max-w-full">
                {/* 3 個可命名小盤 + 1 個地獄深籃 */}
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-[#8e9cab]">盤籃目標：</span>
                  {hud.trayNames.map((tName, tIdx) => {
                    const isDeep = tIdx === hud.deepTrayIndex;
                    const count = hud.trayCounts[tIdx] ?? 0;
                    const cap = hud.traySoftCaps[tIdx] ?? 22;
                    const isFull = !isDeep && count >= cap;
                    const active = hud.activeTray === tIdx;
                    return (
                      <div key={tIdx} className="inline-flex items-center">
                        <button
                          type="button"
                          onClick={() => engineRef.current?.focusTray(tIdx, false)}
                          title={
                            isDeep
                              ? '擺在最左側的大容量地獄深籃：可手動將滿盤的積木倒進來，或在裡面直接翻找、撈 10 顆回小盤'
                              : `小盤建議上限約 ${cap} 顆；倒太多滿出掉到桌面上時，動物會自動來幫忙收拾，也可以手動倒進「${hud.trayNames[hud.deepTrayIndex] ?? '地獄深籃'}」`
                          }
                          className={`flex items-center gap-1 px-2 py-0.5 rounded-l-md font-medium border transition-colors whitespace-nowrap ${
                            active
                              ? isDeep
                                ? 'bg-[#d97706] text-[#1a1004] border-[#f59e0b]'
                                : 'bg-[#7fe3ff] text-[#0c141c] border-[#7fe3ff]'
                              : isDeep
                                ? 'bg-[#2a1d11] text-[#fbbf77] border-[#b45309]/50 hover:border-[#f59e0b]'
                                : 'bg-[#1a2028] text-[#b4c0ce] border-white/10 hover:text-white'
                          }`}
                        >
                          <span>{tName}</span>
                          <span
                            className={`text-[10px] tabular-nums ${
                              active
                                ? 'opacity-85'
                                : isFull
                                  ? 'text-[#f87171]'
                                  : 'opacity-75'
                            }`}
                          >
                            {isDeep ? `${count}顆` : `${count}/${cap}`}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingTrayIdx(tIdx);
                            setEditingTrayText(tName);
                          }}
                          title={`重新命名「${tName}」`}
                          className={`px-1.5 py-0.5 rounded-r-md border border-l-0 transition-colors ${
                            active
                              ? isDeep
                                ? 'bg-[#b45309] text-[#fff2dc] border-[#f59e0b]'
                                : 'bg-[#5bc5e3] text-[#0c141c] border-[#7fe3ff]'
                              : 'bg-[#151a22] text-[#7f8d9c] border-white/10 hover:text-white'
                          }`}
                        >
                          <Pencil className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    );
                  })}

                  {session.kind === 'model' && hud.openedPacks.filter(v => !v).length > 1 && (
                    <button
                      type="button"
                      onClick={() => engineRef.current?.openAllRemainingIntoTray(hud.activeTray)}
                      className="ml-0.5 px-2 py-0.5 rounded-md bg-[#263242] hover:bg-[#314054] text-[#dce5f0] border border-white/12 whitespace-nowrap"
                      title="把剩下未拆的小袋全部倒進目前選取的盤／深籃裡"
                    >
                      剩餘全倒進「{hud.trayNames[hud.activeTray] ?? `盤 ${hud.activeTray + 1}`}」
                    </button>
                  )}
                </div>

                {/* 盤名編輯列 */}
                {editingTrayIdx !== null && (
                  <form
                    onSubmit={e => {
                      e.preventDefault();
                      if (editingTrayText.trim()) {
                        engineRef.current?.renameTray(editingTrayIdx, editingTrayText);
                      }
                      setEditingTrayIdx(null);
                    }}
                    className="flex items-center gap-1.5 pt-1 border-t border-white/8 text-[11px]"
                  >
                    <span className="text-[#9fb0c4] whitespace-nowrap">
                      替盤 {editingTrayIdx + 1} 取名：
                    </span>
                    <input
                      type="text"
                      value={editingTrayText}
                      maxLength={12}
                      autoFocus
                      onChange={e => setEditingTrayText(e.target.value)}
                      placeholder="輸入盤子名稱（最多 12 字）"
                      className="w-36 px-2 py-0.5 rounded bg-[#0c1016] border border-[#7fe3ff]/50 text-white text-xs focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="px-2 py-0.5 rounded bg-[#7fe3ff] text-[#0c141c] font-semibold"
                    >
                      確定
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingTrayIdx(null)}
                      className="px-2 py-0.5 rounded bg-[#1f2630] text-[#9fb0c4] hover:text-white"
                    >
                      取消
                    </button>
                  </form>
                )}

                {/* 地獄深籃 ↔ 小盤 雙向倒料列 */}
                {((hud.trayCounts[hud.deepTrayIndex] ?? 0) > 0 ||
                  (hud.activeTray !== hud.deepTrayIndex && (hud.trayCounts[hud.activeTray] ?? 0) > 0)) && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-white/8 text-[11px]">
                    {(hud.trayCounts[hud.deepTrayIndex] ?? 0) > 0 && (
                      <>
                        <span className="text-[#f5c076] flex items-center gap-1 whitespace-nowrap">
                          <ArrowDownToLine className="w-3 h-3" />
                          從{hud.trayNames[hud.deepTrayIndex] ?? '地獄深籃'}撈 10 顆倒進：
                        </span>
                        {hud.trayNames.map((tName, tIdx) =>
                          tIdx === hud.deepTrayIndex ? null : (
                            <button
                              key={`pour_${tIdx}`}
                              type="button"
                              onClick={() => engineRef.current?.pourFromDeepToTray(tIdx, 10)}
                              className="px-2 py-0.5 rounded bg-[#272018] hover:bg-[#3a2d1d] border border-[#f59e0b]/40 text-[#ffd89b] whitespace-nowrap transition-colors"
                            >
                              {tName}
                            </button>
                          )
                        )}
                      </>
                    )}
                    {hud.activeTray !== hud.deepTrayIndex &&
                      (hud.trayCounts[hud.activeTray] ?? 0) > 0 && (
                        <button
                          type="button"
                          onClick={() => engineRef.current?.dumpTrayToDeep(hud.activeTray)}
                          className="ml-auto px-2 py-0.5 rounded bg-[#251a14] hover:bg-[#382419] border border-[#fb923c]/35 text-[#fdba74] whitespace-nowrap transition-colors"
                          title="把目前小盤的積木全部倒進地獄深籃騰出空間"
                        >
                          把「{hud.trayNames[hud.activeTray]}」倒回深籃
                        </button>
                      )}
                  </div>
                )}

                {/* 依顏色與尺寸分拆的小袋子清單（袋內緊密顯示積木，點即拆袋倒出） */}
                {session.kind === 'model' && (
                  <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-0.5 pt-1 border-t border-white/8">
                    {(hud.pouches.length ? hud.pouches : fallbackPouches).map((pouch, idx) => {
                      const opened = Boolean(hud.openedPacks[idx]);
                      const pouring = hud.pouringPack === idx;
                      const pouredTray = hud.packTrayMap[idx];
                      const colDef = session.model.palette[pouch.colorIdx];
                      const hexStr = colDef ? `#${colDef.hex.toString(16).padStart(6, '0')}` : '#999999';
                      const targetName = hud.trayNames[hud.activeTray] ?? `盤 ${hud.activeTray + 1}`;
                      return (
                        <button
                          key={idx}
                          type="button"
                          disabled={opened}
                          onClick={() => engineRef.current?.openPack(idx, false, hud.activeTray)}
                          title={`${pouch.label}（${pouch.count} 顆）`}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-left text-[11px] transition-colors whitespace-nowrap ${
                            pouring
                              ? 'bg-[#223244]/95 border-[#7fe3ff]/70 text-[#7fe3ff]'
                              : opened
                                ? 'bg-[#171c23]/65 border-white/8 text-[#6e7b8b] cursor-default'
                                : 'bg-[#1b222c]/95 border-white/16 hover:border-[#7fe3ff]/60 text-[#e4ecf5]'
                          }`}
                        >
                          <span
                            className={`w-2.5 h-2.5 rounded-sm shrink-0 border ${
                              colDef?.transparent ? 'border-[#9beaff]' : 'border-black/40'
                            }`}
                            style={{
                              backgroundColor: hexStr,
                              opacity: opened ? 0.45 : colDef?.transparent ? 0.65 : 1,
                            }}
                          />
                          <PackageOpen
                            className={`w-3 h-3 shrink-0 ${opened && !pouring ? 'text-[#5b6675]' : 'text-[#7fe3ff]'}`}
                          />
                          <span>
                            <strong className="font-semibold">
                              {pouring
                                ? `倒進 ${targetName}`
                                : opened
                                  ? `${pouch.label} (${pouredTray !== null && pouredTray !== undefined ? (hud.trayNames[pouredTray] ?? `盤${pouredTray + 1}`) : '已開'})`
                                  : `${pouch.label} → ${targetName}`}
                            </strong>
                            <span className="ml-1 tabular-nums opacity-75">{pouch.count}顆</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 主工具模式列：抓取 / 手指翻找 / 橘色拆件器 / 復原 / 搖晃 / 找本步零件 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex items-center p-1 rounded-xl bg-[#11151b]/95 border border-white/14 shadow-lg">
                <button
                  type="button"
                  onClick={() => engineRef.current?.setInteractionMode('grab')}
                  title="抓取並拼放積木（快捷鍵 G）"
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    (hud?.interactionMode ?? 'grab') === 'grab'
                      ? 'bg-[#7fe3ff] text-[#0c141c] font-semibold'
                      : 'text-[#b4c0ce] hover:text-white'
                  }`}
                >
                  <MousePointer className="w-3.5 h-3.5" />
                  抓取
                </button>
                <button
                  type="button"
                  onClick={() =>
                    engineRef.current?.setInteractionMode(
                      hud?.interactionMode === 'rummage' ? 'grab' : 'rummage'
                    )
                  }
                  title="手指翻找模式：直接在零件堆裡撥開壓在底下的積木（快捷鍵 F）"
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    hud?.interactionMode === 'rummage'
                      ? 'bg-[#f4c430] text-[#1a150f] font-semibold'
                      : 'text-[#b4c0ce] hover:text-white'
                  }`}
                >
                  <Hand className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">翻找 (F)</span>
                  <span className="sm:hidden">翻找</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    engineRef.current?.setInteractionMode(
                      hud?.interactionMode === 'separator' ? 'grab' : 'separator'
                    )
                  }
                  title="橘色拆件器：點擊已拼好的結構，只精準翹起單一顆積木不拆散整塊（快捷鍵 X）"
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    hud?.interactionMode === 'separator'
                      ? 'bg-[#ff7f32] text-[#1a0d05] font-semibold'
                      : 'text-[#ffb98a] hover:text-white'
                  }`}
                >
                  <Wrench className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">拆件器 (X)</span>
                  <span className="sm:hidden">拆件</span>
                </button>
              </div>

              <button
                type="button"
                disabled={!(hud?.canUndo ?? false)}
                onClick={() => engineRef.current?.undoLastAction()}
                title="復原上一步移動或放置（Ctrl+Z）"
                className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-[#1b222c]/95 hover:bg-[#26303d] border border-white/14 text-xs font-medium text-[#dce5f0] whitespace-nowrap transition-colors disabled:opacity-35 disabled:pointer-events-none"
              >
                <Undo2 className="w-3.5 h-3.5 text-[#7fe3ff]" />
                <span>復原</span>
              </button>

              <button
                type="button"
                onClick={() => engineRef.current?.stirTray()}
                title="搖晃目前籃子裡堆疊的積木，讓底層零件翻上來"
                className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-[#1b222c]/95 hover:bg-[#26303d] border border-white/14 text-xs font-medium text-[#dce5f0] whitespace-nowrap transition-colors"
              >
                <Shuffle className="w-3.5 h-3.5 text-[#f4c430]" />
                <span className="hidden sm:inline">搖晃籃子</span>
                <span className="sm:hidden">搖晃</span>
              </button>

              {session.kind === 'model' && hud?.boxOpened && (
                <button
                  type="button"
                  onClick={() => engineRef.current?.highlightCurrentStepParts()}
                  title="讓目前步驟需要的積木在籃子裡跳動閃亮提示"
                  className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-[#1b222c]/95 hover:bg-[#26303d] border border-white/14 text-xs font-medium text-[#dce5f0] whitespace-nowrap transition-colors"
                >
                  <Search className="w-3.5 h-3.5 text-[#7fe3ff]" />
                  <span className="hidden sm:inline">找本步零件</span>
                  <span className="sm:hidden">找零件</span>
                </button>
              )}
            </div>

            {session.kind === 'model' && hud?.hasSubAssemblies && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    engineRef.current?.setSubAssemblyMode(!(hud?.subAssemblyEnabled ?? false))
                  }
                  title="先在右側子組裝台單獨拼好頭部等區塊，再整塊抓起合體到主體"
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium whitespace-nowrap transition-colors ${
                    hud?.subAssemblyEnabled
                      ? 'bg-[#332a18]/95 border-[#f4c430]/75 text-[#ffe082]'
                      : 'bg-[#1b222c]/95 border-white/14 text-[#dce5f0] hover:bg-[#26303d]'
                  }`}
                >
                  <Boxes className="w-3.5 h-3.5 text-[#f4c430]" />
                  <span>
                    {hud?.subAssemblyEnabled
                      ? `分區中：${hud.activeSubName} (${hud.subMatchedCount}/${hud.subPlanCount})`
                      : `分區組裝：${hud.activeSubName}`}
                  </span>
                </button>
                {hud?.subAssemblyEnabled && hud?.subReadyToMerge && (
                  <button
                    type="button"
                    onClick={() => engineRef.current?.mergeSubAssemblyToMain()}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#6fdc9a] hover:bg-[#8be7af] text-[#0c1812] text-xs font-semibold whitespace-nowrap shadow-lg"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    一鍵合體（或整塊拖上主體）
                  </button>
                )}
              </div>
            )}

            {session.kind === 'model' && hud?.hasStandMount && (
              <div className="flex flex-wrap items-center gap-1.5">
                {!hud.standMounted ? (
                  <button
                    type="button"
                    disabled={!hud.standReadyToMount}
                    onClick={() => engineRef.current?.mountCharacterOnStand()}
                    title="先把右半邊小人拼好，再點擊（或直接點桌上的透明斜角支架）讓小人斜躺騰空展示！"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold whitespace-nowrap transition-colors ${
                      hud.standReadyToMount
                        ? 'bg-[#6fdc9a] hover:bg-[#8be7af] border-[#9ff3bf] text-[#0c1a12] shadow-lg'
                        : 'bg-[#1b222c]/95 border-white/14 text-[#8fa1b5] opacity-75 cursor-not-allowed'
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>
                      {hud.standReadyToMount
                        ? '把小人放上透明斜角支架'
                        : '右邊小人拼好後可放上斜角支架'}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => engineRef.current?.unmountCharacterFromStand()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#273140]/95 hover:bg-[#334054] border border-[#7fe3ff]/45 text-xs font-medium text-[#b5ecff] whitespace-nowrap transition-colors"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    <span>從支架取回地面微調</span>
                  </button>
                )}
              </div>
            )}

            {session.kind === 'sandbox' && (
              <div className="flex flex-col gap-1.5 rounded-xl bg-[#11151b]/95 border border-white/12 p-2.5 max-w-[680px]">
                {hud && hud.totalBricks === 0 && (
                  <div className="text-[11px] text-[#9beaff] bg-[#16222e] border border-[#7fe3ff]/30 rounded-lg px-2.5 py-1">
                    目前桌面淨空：請挑選形狀、顏色與材質，點擊「訂購並倒入」將積木送進指定盤子或深籃！
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="flex flex-wrap items-center gap-1">
                    {(['1x1', '1x2', '1x3', '1x4', '2x2', '2x3', '2x4', '4x4', 'L3', 'slope1x1', 'slope1x2'] as ShapeKey[]).map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSbShape(s)}
                        className={`px-2 py-1 rounded-lg text-[11px] font-medium border whitespace-nowrap ${
                          sbShape === s
                            ? 'bg-[#7fe3ff] text-[#0c141c] border-[#7fe3ff]'
                            : 'bg-[#1a2028] text-[#aeb9c7] border-white/10 hover:text-white'
                        }`}
                      >
                        {SHAPES[s].label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1 bg-[#171c23] p-0.5 rounded-lg border border-white/10">
                    {([1, 4] as const).map(qty => (
                      <button
                        key={qty}
                        type="button"
                        onClick={() => setSbSpawnQty(qty)}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium tabular-nums whitespace-nowrap ${
                          sbSpawnQty === qty
                            ? 'bg-[#2a3646] text-[#7fe3ff]'
                            : 'text-[#8e9cab] hover:text-white'
                        }`}
                      >
                        ×{qty} 顆
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => engineRef.current?.spawnSandboxBrick(sbShape, sbColor, sbSpawnQty)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#263242] hover:bg-[#314054] text-xs font-medium text-white whitespace-nowrap"
                  >
                    <Plus className="w-3.5 h-3.5 text-[#7fe3ff]" />
                    訂購並倒入「{hud?.trayNames[hud?.activeTray ?? 0] ?? `盤 ${(hud?.activeTray ?? 0) + 1}`}」
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      const exported = engineRef.current?.exportSandboxAsModel('我的自由作品');
                      if (!exported) {
                        setSandboxCopied('empty');
                        setTimeout(() => setSandboxCopied(null), 1800);
                        return;
                      }
                      try {
                        await navigator.clipboard.writeText(encodeModelShareCode(exported));
                        setSandboxCopied('ok');
                        setTimeout(() => setSandboxCopied(null), 2000);
                      } catch {
                        setSandboxCopied('ok');
                        setTimeout(() => setSandboxCopied(null), 2000);
                      }
                    }}
                    title="把目前桌上的自由創作轉成 BW1 分享碼，可給朋友在模型庫匯入拼砌"
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#1d3129] hover:bg-[#264237] border border-[#6fdc9a]/40 text-xs font-medium text-[#9ef2be] whitespace-nowrap"
                  >
                    {sandboxCopied === 'ok' ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Share2 className="w-3.5 h-3.5" />
                    )}
                    {sandboxCopied === 'ok'
                      ? '已複製分享碼'
                      : sandboxCopied === 'empty'
                        ? '請先拼幾顆'
                        : '分享作品碼'}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      refreshSaveMeta(saveSandboxState(null));
                      setSession({ kind: 'sandbox' });
                    }}
                    title="清空重來"
                    className="ml-auto p-1.5 rounded-lg text-[#9aa6b5] hover:text-[#ff9c9c] hover:bg-white/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* 現有色票 + 透明水晶支撐 + 調色盤自訂色彩 */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-white/8">
                  {sbPalette.map((c, idx) => (
                    <button
                      key={`${c.code}_${idx}`}
                      type="button"
                      title={c.transparent ? `${c.name}（透明材質）` : c.name}
                      onClick={() => setSbColor(idx)}
                      className={`w-5 h-5 rounded-md border-2 transition-transform shrink-0 ${
                        sbColor === idx ? 'border-white scale-110' : c.transparent ? 'border-[#9fe4ff]/70' : 'border-black/40'
                      }`}
                      style={{
                        backgroundColor: '#' + c.hex.toString(16).padStart(6, '0'),
                        opacity: c.transparent ? 0.58 : 1,
                      }}
                    />
                  ))}

                  <span className="text-[11px] text-[#9fb0c4] ml-1 whitespace-nowrap">
                    {sbPalette[sbColor]?.name}
                  </span>

                  <div className="flex flex-wrap items-center gap-1.5 ml-auto pl-2 border-l border-white/10">
                    <label
                      className="flex items-center gap-1 text-[11px] text-[#b4c0ce] cursor-pointer"
                      title="打開系統調色盤挑選任意積木顏色"
                    >
                      <input
                        type="color"
                        value={sbCustomHex}
                        onChange={e => setSbCustomHex(e.target.value)}
                        className="w-6 h-6 rounded border border-white/20 bg-transparent cursor-pointer p-0"
                      />
                    </label>
                    <div className="flex items-center rounded-lg bg-[#181d25] border border-white/12 p-0.5 gap-0.5">
                      {(
                        [
                          ['plastic', '亮塑'],
                          ['matte', '霧面'],
                          ['metallic', '金屬'],
                          ['glass', '玻璃'],
                        ] as Array<[MaterialFinish, string]>
                      ).map(([fin, label]) => (
                        <button
                          key={fin}
                          type="button"
                          onClick={() => setSbCustomFinish(fin)}
                          className={`px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap transition-colors ${
                            sbCustomFinish === fin
                              ? 'bg-[#2a3848] text-[#9beaff] font-semibold'
                              : 'text-[#8e9cab] hover:text-white'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const hexNum = parseInt(sbCustomHex.replace('#', ''), 16);
                        const engine = engineRef.current;
                        if (!engine || Number.isNaN(hexNum)) return;
                        const finishPrefix =
                          sbCustomFinish === 'glass'
                            ? '玻璃 '
                            : sbCustomFinish === 'metallic'
                              ? '金屬 '
                              : sbCustomFinish === 'matte'
                                ? '霧面 '
                                : '';
                        const idx = engine.addSandboxColor(
                          hexNum,
                          `${finishPrefix}${sbCustomHex.toUpperCase()}`,
                          sbCustomFinish === 'glass',
                          sbCustomFinish
                        );
                        setSbPalette(engine.getPalette());
                        setSbColor(idx);
                        engine.spawnSandboxBrick(sbShape, idx, sbSpawnQty);
                      }}
                      className="px-2 py-1 rounded-lg bg-[#f4c430] hover:bg-[#ffd54f] text-[#1a150f] text-[11px] font-semibold whitespace-nowrap"
                    >
                      調色並產出
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 智慧視角導航條：左右旋轉鏡頭 + 組裝區 + 每個籃子特寫 + 全景 */}
            <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[#11151b]/95 border border-white/12 shadow-lg">
              <button
                type="button"
                onClick={() => engineRef.current?.orbitStep(-1)}
                title="鏡頭向左旋轉 45°"
                className="p-1.5 rounded-lg text-[#b4c0ce] hover:text-white hover:bg-[#232b37] transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => engineRef.current?.focusBuildArea()}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  hud?.currentView === 'build' || hud?.currentView === 'subpad'
                    ? 'bg-[#7fe3ff] text-[#0c141c] font-semibold'
                    : 'text-[#b4c0ce] hover:text-white hover:bg-[#1f2732]'
                }`}
              >
                組裝區
              </button>
              {Array.from({ length: hud?.trayCount ?? 1 }).map((_, tIdx) => {
                const isDeep = tIdx === hud?.deepTrayIndex;
                const active = hud?.currentView === 'tray' && hud?.activeTray === tIdx;
                return (
                  <button
                    key={tIdx}
                    type="button"
                    onClick={() => engineRef.current?.focusTray(tIdx, true)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                      active
                        ? isDeep
                          ? 'bg-[#d97706] text-[#1a1004] font-semibold'
                          : 'bg-[#f4c430] text-[#1a150f] font-semibold'
                        : isDeep
                          ? 'text-[#fbbf77] hover:text-white hover:bg-[#2a1d11]'
                          : 'text-[#9fb0c4] hover:text-white hover:bg-[#1f2732]'
                    }`}
                  >
                    {hud?.trayNames[tIdx] ?? `盤 ${tIdx + 1}`}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => engineRef.current?.switchView('wide')}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  hud?.currentView === 'wide'
                    ? 'bg-[#2a3646] text-[#7fe3ff]'
                    : 'text-[#9fb0c4] hover:text-white hover:bg-[#1f2732]'
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                全景
              </button>
              <button
                type="button"
                onClick={() => engineRef.current?.orbitStep(1)}
                title="鏡頭向右旋轉 45°"
                className="p-1.5 rounded-lg text-[#b4c0ce] hover:text-white hover:bg-[#232b37] transition-colors"
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* 浮動手持動作列（手上有積木時出現，單手拇指可直接點旋轉、帶回組裝區、或放回籃子） */}
          {hud?.heldActive && (
            <div
              onPointerDown={e => e.stopPropagation()}
              className="fixed right-2 sm:right-3 bottom-2 sm:bottom-3 z-20 flex flex-wrap items-center justify-end gap-2"
            >
              {(hud?.heldCount ?? 1) <= 1 ? (
                <button
                  type="button"
                  onClick={() => engineRef.current?.rotateHeld()}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-[#7fe3ff] hover:bg-[#9beaff] active:scale-95 text-[#0c141c] text-xs font-bold shadow-2xl whitespace-nowrap transition-transform"
                >
                  <RotateCw className="w-4 h-4" />
                  旋轉 90°（R）
                </button>
              ) : (
                <div className="px-3 py-2 rounded-xl bg-[#2a2417]/95 border border-[#f4c430]/60 text-[#ffe082] text-xs font-medium whitespace-nowrap shadow-xl">
                  整塊拖曳合體中（{hud.heldCount} 顆）
                </div>
              )}

              {hud.currentView === 'tray' && (
                <button
                  type="button"
                  onClick={() => engineRef.current?.focusBuildArea()}
                  className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl bg-[#6fdc9a] hover:bg-[#8be7af] active:scale-95 text-[#0c1812] text-xs font-bold shadow-2xl whitespace-nowrap transition-transform"
                >
                  帶回組裝區
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}

              <button
                type="button"
                onClick={() => engineRef.current?.returnHeldToTray()}
                className="px-3 py-2.5 rounded-2xl bg-[#202733]/95 hover:bg-[#2b3444] border border-white/15 text-xs font-medium text-[#dce5f0] shadow-xl whitespace-nowrap"
              >
                放回{hud.trayNames[hud.activeTray] ?? '盤子'}
              </button>
            </div>
          )}

          {/* 動物整理即時 3D 動畫非遮罩字幕條 */}
          {tidyOverlay && (
            <div className="fixed left-1/2 top-16 -translate-x-1/2 z-40 w-[min(92vw,460px)] pointer-events-none select-none">
              <div className="flex items-start gap-3 rounded-2xl border border-[#f4c430]/55 bg-[#11151b]/88 px-4 py-3 shadow-2xl">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#241f18] border border-[#f4c430]/45">
                  {tidyOverlay.timeOfDay === 'night' ? (
                    <Moon className="h-4 w-4 text-[#a9c6ff]" />
                  ) : (
                    <PawPrint className="h-4 w-4 text-[#f4c430]" />
                  )}
                </div>
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold tracking-wide text-[#ffe8a3]">
                    {tidyOverlay.title}
                  </h3>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-[#d4dde8]">
                    {tidyOverlay.message}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* 待放上透明斜角支架提醒 */}
          {hud &&
            session.kind === 'model' &&
            hud.hasStandMount &&
            !hud.standMounted &&
            hud.matchedCount === plan.length &&
            plan.length > 0 && (
              <div className="fixed left-1/2 top-16 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-[#292112]/95 border border-[#f4c430]/70 text-[#ffe39a] shadow-2xl">
                <Sparkles className="w-4 h-4 text-[#f4c430] shrink-0" />
                <div className="text-xs font-medium">
                  積木全部拼好囉！把小人放上透明斜角支架即可完成展示
                </div>
                <button
                  type="button"
                  onClick={() => engineRef.current?.mountCharacterOnStand()}
                  className="px-3 py-1 rounded-lg bg-[#f4c430] hover:bg-[#ffd54f] text-[#1a150f] text-xs font-bold whitespace-nowrap"
                >
                  放上斜角支架
                </button>
              </div>
            )}

          {/* 完成慶祝橫幅 */}
          {hud?.isComplete && session.kind === 'model' && (
            <div className="fixed left-1/2 top-16 -translate-x-1/2 z-20 flex items-center gap-3 px-5 py-3 rounded-2xl bg-[#142920]/95 border border-[#5adc8c]/65 text-[#a8f5c8] shadow-2xl">
              <CheckCircle2 className="w-5 h-5 text-[#6fdc9a] shrink-0" />
              <div>
                <div className="text-sm font-semibold">
                  {session.model.name} 完成拼砌 ✓
                </div>
                <div className="text-xs text-[#89d9ab] tabular-nums">
                  {plan.length} 顆全部就位 · 已收錄至成品櫃
                </div>
              </div>
              <button
                type="button"
                onClick={backToMenu}
                className="ml-2 px-3 py-1.5 rounded-lg bg-[#6fdc9a] text-[#0d1c15] text-xs font-semibold whitespace-nowrap hover:bg-[#8be7af]"
              >
                <Sparkles className="w-3.5 h-3.5 inline mr-1" />
                看成品櫃
              </button>
            </div>
          )}

          {/* 步驟 3D 等角放大視窗 */}
          {zoomStep && session.kind === 'model' && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/82 p-4"
              onClick={() => setZoomStep(null)}
            >
              <div
                className="w-full max-w-xl rounded-2xl bg-[#171b22] border border-white/14 p-5 text-[#dfe7f1]"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <h3 className="text-sm font-semibold text-[#7fe3ff] tabular-nums">
                    步驟 {zoomStep.stepIndex + 1} · 第 {zoomStep.layer + 1} 層 · 本步 {zoomStep.bricks.length} 顆
                  </h3>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        handleRotateManual(((manualYawDeg - 45) % 360 + 360) % 360, manualPitchDeg)
                      }
                      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#10141b] hover:bg-[#232b37] border border-white/10 text-xs text-[#cfd8e3] whitespace-nowrap"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      左轉
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRotateManual((manualYawDeg + 45) % 360, manualPitchDeg)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#10141b] hover:bg-[#232b37] border border-white/10 text-xs text-[#cfd8e3] whitespace-nowrap"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                      右轉
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRotateManual(0, 26)}
                      className="px-2 py-1 rounded-lg bg-[#10141b] hover:bg-[#232b37] border border-white/10 text-xs text-[#9fb0c4] hover:text-white whitespace-nowrap"
                    >
                      正面
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRotateManual(180, 26)}
                      className="px-2 py-1 rounded-lg bg-[#10141b] hover:bg-[#232b37] border border-white/10 text-xs text-[#9fb0c4] hover:text-white whitespace-nowrap"
                    >
                      背面
                    </button>
                    <span className="text-xs text-[#7fe3ff] tabular-nums px-1 whitespace-nowrap">
                      {formatViewDirection(manualYawDeg)} {Math.round(manualYawDeg)}°
                    </span>
                    <button
                      type="button"
                      onClick={() => setZoomStep(null)}
                      className="ml-1 text-xs text-[#8794a4] hover:text-white whitespace-nowrap"
                    >
                      關閉
                    </button>
                  </div>
                </div>
                <div className="aspect-[4/3] w-full rounded-xl bg-[#0f1319] p-3">
                  <IsometricStepSvg
                    bricks={zoomStep.bricks}
                    prevBricks={zoomStep.prevBricks}
                    palette={session.model.palette}
                    boardW={session.model.board.w}
                    boardD={session.model.board.d}
                    yawDeg={manualYawDeg}
                    pitchDeg={manualPitchDeg}
                    interactive
                    onRotateChange={handleRotateManual}
                  />
                </div>
                <p className="mt-3 text-xs text-[#8794a4] text-center">
                  可直接在圖上拖曳旋轉 360°（藍三角為正面）· 灰色為已完成結構，亮色為本步驟 {zoomStep.bricks.length} 顆積木
                </p>
              </div>
            </div>
          )}

          {/* 分層俯視放大視窗 */}
          {zoomLayer !== null && session.kind === 'model' && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/82 p-4"
              onClick={() => setZoomLayer(null)}
            >
              <div
                className="w-full max-w-lg rounded-2xl bg-[#171b22] border border-white/14 p-5 text-[#dfe7f1]"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#7fe3ff] flex items-center gap-1.5">
                    <Maximize2 className="w-4 h-4" />
                    第 {zoomLayer + 1} 層俯視圖
                  </h3>
                  <button
                    type="button"
                    onClick={() => setZoomLayer(null)}
                    className="text-xs text-[#8794a4] hover:text-white"
                  >
                    關閉
                  </button>
                </div>
                <LayerGridDiagram layer={zoomLayer} plan={plan} model={session.model} />
                <p className="mt-3 text-xs text-[#8794a4]">點任意空白處關閉</p>
              </div>
            </div>
          )}
        </>
      )}

      {/* 手感與模式設定 Modal */}
      {showFeelModal && (
        <FeelSettingsModal
          feel={feel}
          onChange={handleFeelChange}
          onClose={() => setShowFeelModal(false)}
        />
      )}

      {/* 圖片 / 遮罩轉積木 Modal */}
      {showMaskModal && (
        <MaskBuilderModal
          onPlayCustom={custom => {
            setShowMaskModal(false);
            startFreshModel(custom);
          }}
          onClose={() => setShowMaskModal(false)}
        />
      )}
    </div>
  );
}
