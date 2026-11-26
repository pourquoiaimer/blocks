import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Maximize2,
  PackageOpen,
  PanelRightOpen,
  Plus,
  RotateCw,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  BrickModel,
  BuildStep,
  FeelSettings,
  ManualViewMode,
  SavedBrickRecord,
  ShapeKey,
  WorkshopHudSnapshot,
  WorkshopSaveStore,
} from './types/brick';
import { MODELS, SANDBOX_PALETTE, getModelById } from './data/models';
import { SHAPES, buildPlan, buildSteps } from './engine/brickPlanner';
import { BrickWorkshopEngine } from './engine/BrickWorkshopEngine';
import {
  getSaveByteSize,
  loadSaveStore,
  pushShowcaseEntry,
  removeShowcaseEntry,
  saveActiveBuild,
  saveFeelSettings,
  saveSandboxState,
} from './services/storage';
import { cgGameplayStart, cgGameplayStop, cgHappytime, initCrazyGames } from './services/crazyGames';
import { WorkshopMenu } from './components/WorkshopMenu';
import { InstructionPanel, LayerGridDiagram } from './components/InstructionPanel';
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
      initialElapsedSec: number;
    }
  | {
      kind: 'sandbox';
      initialRecords?: SavedBrickRecord[];
    };

const SANDBOX_MODEL: BrickModel = {
  id: 'sandbox',
  name: '無限自由模式',
  subtitle: '8 色 ABS 零件無限供應 · 雙托盤自由創作',
  difficulty: '標準',
  palette: SANDBOX_PALETTE,
  board: { w: 18, d: 14 },
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
  const [panelOpen, setPanelOpen] = useState(true);
  const [hudCompact, setHudCompact] = useState(false);

  const [showFeelModal, setShowFeelModal] = useState(false);
  const [showMaskModal, setShowMaskModal] = useState(false);
  const [zoomStep, setZoomStep] = useState<BuildStep | null>(null);
  const [zoomLayer, setZoomLayer] = useState<number | null>(null);
  const [contextLost, setContextLost] = useState(false);

  // Sandbox dispenser controls
  const [sbShape, setSbShape] = useState<ShapeKey>('1x2');
  const [sbColor, setSbColor] = useState(0);

  const canvasMountRef = useRef<HTMLDivElement>(null);
  const fpsSpanRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<BrickWorkshopEngine | null>(null);
  const sessionStartMsRef = useRef<number>(Date.now());
  const baseElapsedRef = useRef<number>(0);
  const completedRecordedRef = useRef<boolean>(false);

  const activeModel = session.kind === 'model' ? session.model : session.kind === 'sandbox' ? SANDBOX_MODEL : null;
  const plan = useMemo(
    () => (session.kind === 'model' ? buildPlan(session.model) : []),
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
        onAutoSave: (records, openedPacks) => {
          if (cancelled) return;
          if (session.kind === 'sandbox') {
            const store = saveSandboxState({ bricks: records, updatedAt: Date.now() });
            refreshSaveMeta(store);
          } else if (session.kind === 'model' && !completedRecordedRef.current) {
            const elapsedSec =
              baseElapsedRef.current + Math.round((Date.now() - sessionStartMsRef.current) / 1000);
            const store = saveActiveBuild({
              modelId: session.model.id,
              customModel: session.model.isCustom ? session.model : undefined,
              openedPacks,
              elapsedSec,
              bricks: records,
              updatedAt: Date.now(),
            });
            refreshSaveMeta(store);
          }
        },
        onContextLost: () => {
          if (!cancelled) setContextLost(true);
        },
      },
      {
        isSandbox: session.kind === 'sandbox',
        sandboxPalette: SANDBOX_PALETTE,
      }
    );

    engineRef.current = engine;
    const initRecords = session.initialRecords;
    const initPacks = session.kind === 'model' ? session.initialOpenedPacks : undefined;

    void engine.init(initRecords, initPacks).then(() => {
      if (!cancelled) {
        cgGameplayStart();
        const st = buildSteps(session.kind === 'model' ? buildPlan(session.model) : []);
        if (st[0]) engine.setGuideBricks(st[0].bricks);
      }
    });

    return () => {
      cancelled = true;
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
      initialElapsedSec: ab.elapsedSec,
    });
  };

  const openSandbox = (resume: boolean) => {
    setSession({
      kind: 'sandbox',
      initialRecords: resume ? saveStore.sandbox?.bricks : undefined,
    });
  };

  const backToMenu = () => {
    // Flush latest snapshot before leaving
    const engine = engineRef.current;
    if (engine && session.kind !== 'menu') {
      const { records, openedPacks } = engine.exportRecords();
      if (session.kind === 'sandbox') {
        refreshSaveMeta(saveSandboxState({ bricks: records, updatedAt: Date.now() }));
      } else if (session.kind === 'model' && !completedRecordedRef.current) {
        const elapsedSec =
          baseElapsedRef.current + Math.round((Date.now() - sessionStartMsRef.current) / 1000);
        refreshSaveMeta(
          saveActiveBuild({
            modelId: session.model.id,
            customModel: session.model.isCustom ? session.model : undefined,
            openedPacks,
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
          <div className="fixed left-3 top-3 z-10 flex flex-col gap-2 max-w-[380px]">
            <div className="flex items-center gap-2 rounded-xl bg-[#11151b]/92 border border-white/10 px-2.5 py-2 shadow-xl">
              <button
                type="button"
                onClick={backToMenu}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#1e2530] hover:bg-[#2a3342] text-xs font-medium text-[#dce5f0] whitespace-nowrap transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                模型庫
              </button>

              <div className="min-w-0 px-1">
                <div className="text-xs font-semibold text-white truncate">
                  {activeModel?.name}
                  <span className="ml-2 text-[#7fe3ff] font-normal tabular-nums">
                    {session.kind === 'model'
                      ? `${hud?.matchedCount ?? 0}/${plan.length} 顆`
                      : `${hud?.totalBricks ?? 0} 顆`}
                  </span>
                </div>
                <div className="text-[10.5px] text-[#8490a0] tabular-nums">
                  {hud?.currentView === 'build'
                    ? '組裝中心'
                    : hud?.currentView === 'tray'
                      ? `托盤 ${((hud?.activeTray ?? 0) + 1)} 特寫`
                      : '全景視角'}{' '}
                  · {feel.placementMode === 'instant' ? '放開壓緊' : '輕放兩段'} ·{' '}
                  <span ref={fpsSpanRef}>60 fps</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowFeelModal(true)}
                title="手感設定"
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

            {!hudCompact && (
              <div className="rounded-xl bg-[#11151b]/88 border border-white/10 px-3 py-2 text-[11.5px] leading-relaxed text-[#c6d0dc] pointer-events-none">
                <div>
                  <b className="text-[#7fe3ff]">左鍵拖積木</b> 對位（<b className="text-[#7fe3ff]">R</b> 轉 90°）
                  · <b className="text-[#7fe3ff]">左鍵拖空白</b> 手翻找
                </div>
                <div>
                  {feel.placementMode === 'instant' ? (
                    <>
                      <b className="text-[#7fe3ff]">放開左鍵</b> 綠框處直接卡緊；拖回盤內即放回
                    </>
                  ) : (
                    <>
                      <b className="text-[#7fe3ff]">放開輕放</b> → 再輕點該顆即喀嗒壓緊
                    </>
                  )}
                </div>
                <div className="text-[#8e9aa8]">
                  Shift+點已拼積木單拔 · 右鍵拖轉視角 · Tab 切視角
                </div>
              </div>
            )}
          </div>

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

          {/* 左下：分包按鈕 / 多托盤切換 / 無限模式發磚器 */}
          <div className="fixed left-3 bottom-3 z-10 flex flex-wrap items-end gap-2 max-w-[calc(100vw-240px)]">
            {session.kind === 'model' && (
              <div className="flex flex-wrap gap-1.5">
                {session.model.packs.map((_, idx) => {
                  const opened = Boolean(hud?.openedPacks[idx]);
                  const pouring = hud?.pouringPack === idx;
                  const count = plan.filter(p => p.packIndex === idx).length;
                  return (
                    <button
                      key={idx}
                      type="button"
                      disabled={opened}
                      onClick={() => engineRef.current?.openPack(idx)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left text-xs transition-colors whitespace-nowrap ${
                        pouring
                          ? 'bg-[#223244]/95 border-[#7fe3ff]/70 text-[#7fe3ff]'
                          : opened
                            ? 'bg-[#171c23]/65 border-white/8 text-[#6e7b8b] cursor-default'
                            : 'bg-[#1b222c]/95 border-white/16 hover:border-[#7fe3ff]/60 text-[#e4ecf5]'
                      }`}
                    >
                      <PackageOpen className={`w-3.5 h-3.5 ${opened && !pouring ? 'text-[#5b6675]' : 'text-[#7fe3ff]'}`} />
                      <span>
                        <strong className="font-semibold">
                          {pouring ? `傾倒第 ${idx + 1} 包` : `第 ${idx + 1} 包`}
                        </strong>
                        <span className="ml-1.5 tabular-nums opacity-80">{count} 顆</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={() => engineRef.current?.stirTray()}
              title="撥開托盤裡堆疊的積木"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1b222c]/95 hover:bg-[#26303d] border border-white/14 text-xs font-medium text-[#dce5f0] whitespace-nowrap transition-colors"
            >
              <Shuffle className="w-3.5 h-3.5 text-[#f4c430]" />
              撥開積木
            </button>

            {session.kind === 'sandbox' && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[#11151b]/95 border border-white/12 p-2">
                <div className="flex items-center gap-1">
                  {(['1x1', '1x2', '1x4'] as ShapeKey[]).map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSbShape(s)}
                      className={`px-2 py-1 rounded-lg text-[11px] font-medium border ${
                        sbShape === s
                          ? 'bg-[#7fe3ff] text-[#0c141c] border-[#7fe3ff]'
                          : 'bg-[#1a2028] text-[#aeb9c7] border-white/10'
                      }`}
                    >
                      {SHAPES[s].label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  {SANDBOX_PALETTE.map((c, idx) => (
                    <button
                      key={c.name}
                      type="button"
                      title={c.name}
                      onClick={() => setSbColor(idx)}
                      className={`w-5 h-5 rounded-md border-2 transition-transform ${
                        sbColor === idx ? 'border-white scale-110' : 'border-black/40'
                      }`}
                      style={{ backgroundColor: '#' + c.hex.toString(16).padStart(6, '0') }}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => engineRef.current?.spawnSandboxBrick(sbShape, sbColor, 4)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#263242] hover:bg-[#314054] text-xs font-medium text-white whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5 text-[#7fe3ff]" />
                  倒 4 顆入盤
                </button>
                <button
                  type="button"
                  onClick={() => {
                    refreshSaveMeta(saveSandboxState(null));
                    setSession({ kind: 'sandbox' });
                  }}
                  title="清空重來"
                  className="p-1.5 rounded-lg text-[#9aa6b5] hover:text-[#ff9c9c] hover:bg-white/10"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* 多托盤切換按鈕 */}
            {(hud?.trayCount ?? 1) > 1 && (
              <div className="flex items-center gap-1 p-1 rounded-xl bg-[#11151b]/95 border border-white/12">
                {Array.from({ length: hud?.trayCount ?? 1 }).map((_, tIdx) => (
                  <button
                    key={tIdx}
                    type="button"
                    onClick={() => engineRef.current?.focusTray(tIdx)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                      hud?.activeTray === tIdx
                        ? 'bg-[#2a3646] text-[#7fe3ff]'
                        : 'text-[#8f9cab] hover:text-white'
                    }`}
                  >
                    托盤 {tIdx + 1}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 右下：觸控友善操作鈕 + 切換視角 */}
          <div className="fixed right-3 bottom-3 z-10 flex items-center gap-2">
            {hud?.heldActive && (
              <button
                type="button"
                onClick={() => engineRef.current?.rotateHeld()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#7fe3ff] text-[#0c141c] text-xs font-semibold shadow-lg whitespace-nowrap"
              >
                <RotateCw className="w-3.5 h-3.5" />
                旋轉 90°（R）
              </button>
            )}
            <button
              type="button"
              onClick={() => engineRef.current?.setSinglePluckMode(!(hud?.singlePluckMode ?? false))}
              className={`px-3 py-2 rounded-xl border text-xs font-medium whitespace-nowrap transition-colors ${
                hud?.singlePluckMode
                  ? 'bg-[#3d2b1f] border-[#f4c430]/70 text-[#ffd97d]'
                  : 'bg-[#1a2029]/95 border-white/12 text-[#cfd8e3] hover:bg-[#252d3a]'
              }`}
            >
              {hud?.singlePluckMode ? '單拔中（點擊單顆）' : '單拔切換'}
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.switchView()}
              className="px-3.5 py-2 rounded-xl bg-[#1a2029]/95 hover:bg-[#262f3c] border border-white/12 text-xs font-medium text-[#e4ecf5] whitespace-nowrap"
            >
              切換視角（Tab）
            </button>
          </div>

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
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#7fe3ff] tabular-nums">
                    步驟 {zoomStep.stepIndex + 1} · 第 {zoomStep.layer + 1} 層 · 本步 {zoomStep.bricks.length} 顆
                  </h3>
                  <button
                    type="button"
                    onClick={() => setZoomStep(null)}
                    className="text-xs text-[#8794a4] hover:text-white"
                  >
                    關閉
                  </button>
                </div>
                <div className="aspect-[4/3] w-full rounded-xl bg-[#0f1319] p-3">
                  <IsometricStepSvg
                    bricks={zoomStep.bricks}
                    prevBricks={zoomStep.prevBricks}
                    palette={session.model.palette}
                    boardW={session.model.board.w}
                    boardD={session.model.board.d}
                  />
                </div>
                <p className="mt-3 text-xs text-[#8794a4] text-center">
                  灰色為已完成結構，亮色為本步驟需拼放之 {zoomStep.bricks.length} 顆積木
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
