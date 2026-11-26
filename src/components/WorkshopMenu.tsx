import React, { useMemo } from 'react';
import { Boxes, Play, SlidersHorizontal, Sparkles, Trash2, Wand2 } from 'lucide-react';
import type { BrickModel, WorkshopSaveStore } from '../types/brick';
import { MODELS, getModelById } from '../data/models';
import { buildPlan, buildSteps } from '../engine/brickPlanner';
import { IsometricStepSvg } from './IsometricStepSvg';

interface Props {
  saveStore: WorkshopSaveStore;
  saveBytes: number;
  onSelectModel: (model: BrickModel) => void;
  onResumeActive: () => void;
  onDiscardActive: () => void;
  onOpenSandbox: (resume: boolean) => void;
  onOpenMaskBuilder: () => void;
  onOpenFeelSettings: () => void;
  onRemoveShowcase: (id: string) => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

export const WorkshopMenu: React.FC<Props> = ({
  saveStore,
  saveBytes,
  onSelectModel,
  onResumeActive,
  onDiscardActive,
  onOpenSandbox,
  onOpenMaskBuilder,
  onOpenFeelSettings,
  onRemoveShowcase,
}) => {
  const modelStats = useMemo(() => {
    return MODELS.map(m => {
      const plan = buildPlan(m);
      const steps = buildSteps(plan);
      const trays = Math.max(1, ...m.packs.map(p => p.trayIndex + 1));
      return { model: m, plan, stepCount: steps.length, trays };
    });
  }, []);

  const activeModel = useMemo(() => {
    if (!saveStore.activeBuild) return null;
    return (
      saveStore.activeBuild.customModel ??
      getModelById(saveStore.activeBuild.modelId) ??
      null
    );
  }, [saveStore.activeBuild]);

  const activePlacedCount = useMemo(() => {
    if (!saveStore.activeBuild) return 0;
    return saveStore.activeBuild.bricks.filter(
      b => b.state === 'pressed' || b.state === 'placed'
    ).length;
  }, [saveStore.activeBuild]);

  return (
    <div
      className="fixed inset-0 z-40 overflow-y-auto text-[#e8eef6]"
      style={{
        background: 'radial-gradient(circle at 50% 18%, #2a241c 0%, #14110e 65%, #0e0c0a 100%)',
      }}
    >
      <div className="max-w-6xl mx-auto px-5 py-8 md:py-10 space-y-8">
        {/* 頂部標題與工具列 */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-6 border-b border-white/10">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-[0.14em] text-[#f3e9d8]">
              積 木 工 坊
            </h1>
            <p className="mt-1.5 text-sm text-[#988f80]">
              翻找零件 · 旋轉對位 · 即時磁吸與喀嗒壓緊
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => onOpenSandbox(Boolean(saveStore.sandbox))}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#222933] hover:bg-[#2c3543] border border-white/12 text-xs font-medium text-[#e3ebf5] whitespace-nowrap transition-colors"
            >
              <Boxes className="w-4 h-4 text-[#7fe3ff]" />
              {saveStore.sandbox ? '無限自由模式（續玩）' : '無限自由模式'}
            </button>
            <button
              type="button"
              onClick={onOpenMaskBuilder}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#222933] hover:bg-[#2c3543] border border-white/12 text-xs font-medium text-[#e3ebf5] whitespace-nowrap transition-colors"
            >
              <Wand2 className="w-4 h-4 text-[#f4c430]" />
              圖片／遮罩轉積木
            </button>
            <button
              type="button"
              onClick={onOpenFeelSettings}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#222933] hover:bg-[#2c3543] border border-white/12 text-xs font-medium text-[#e3ebf5] whitespace-nowrap transition-colors"
            >
              <SlidersHorizontal className="w-4 h-4 text-[#9fb0c4]" />
              手感設定
            </button>
          </div>
        </header>

        {/* 製作中存檔（最多 1 組） */}
        {saveStore.activeBuild && activeModel && (
          <section className="rounded-2xl bg-[#1a222b] border border-[#7fe3ff]/35 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-xs text-[#7fe3ff] font-medium">繼續上次未完成的桌面</div>
              <div className="text-lg font-semibold text-white">
                {activeModel.name}
                <span className="ml-3 text-sm font-normal text-[#96a3b3] tabular-nums">
                  已固定 {activePlacedCount} 顆 · 用時 {formatDuration(saveStore.activeBuild.elapsedSec)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onDiscardActive}
                className="px-3 py-2 rounded-xl bg-[#252c36] hover:bg-[#323b48] text-xs text-[#b5c0ce] transition-colors"
              >
                捨棄進度
              </button>
              <button
                type="button"
                onClick={onResumeActive}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#7fe3ff] hover:bg-[#9beaff] text-[#0c141c] text-xs font-semibold transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                繼續拼砌
              </button>
            </div>
          </section>
        )}

        {/* 模型圖紙選擇區 */}
        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-base font-semibold text-[#f0e6d6]">模型圖紙</h2>
            <span className="text-xs text-[#8b8172] tabular-nums">
              共 {modelStats.length} 款 · 本機存檔容量 {(saveBytes / 1024).toFixed(1)} KB
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {modelStats.map(({ model, plan, stepCount, trays }) => (
              <div
                key={model.id}
                onClick={() => onSelectModel(model)}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectModel(model);
                  }
                }}
                className="group rounded-2xl bg-[#191c22] border border-white/10 hover:border-[#7fe3ff]/55 hover:-translate-y-0.5 transition-all p-3.5 cursor-pointer flex flex-col"
              >
                <div className="aspect-[4/3] w-full rounded-xl bg-[#11151b] p-2 mb-3 overflow-hidden">
                  <IsometricStepSvg
                    bricks={plan}
                    palette={model.palette}
                    boardW={model.board.w}
                    boardD={model.board.d}
                    showAllBright
                  />
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-base font-semibold text-white group-hover:text-[#7fe3ff] transition-colors">
                    {model.name}
                  </h3>
                  <span className="text-xs text-[#8ef0b4] shrink-0">{model.difficulty}</span>
                </div>
                <p className="mt-1 text-xs text-[#919dab] line-clamp-2">{model.subtitle}</p>
                <div className="mt-3 pt-2.5 border-t border-white/8 text-[11.5px] text-[#7f8c9c] tabular-nums flex items-center justify-between">
                  <span>
                    {plan.length} 顆 · {model.masks.length} 層 · {stepCount} 步
                  </span>
                  <span>{trays > 1 ? `${trays} 托盤` : `${model.packs.length} 包`}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 成品櫃（最多 3 組） */}
        <section className="pb-6">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-base font-semibold text-[#f0e6d6] flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#f4c430]" />
              成品櫃
            </h2>
            <span className="text-xs text-[#8b8172] tabular-nums">
              {saveStore.showcase.length} / 3 格展示位
            </span>
          </div>

          {saveStore.showcase.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/12 bg-[#14171c]/70 p-6 text-center text-xs text-[#7d8897]">
              尚未有完成作品。完成任一組模型後將自動陳列於成品櫃（最多保留 3 件最新作品）。
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {saveStore.showcase.map(item => {
                const m = getModelById(item.modelId);
                const plan = m ? buildPlan(m) : [];
                return (
                  <div
                    key={item.id}
                    className="rounded-2xl bg-[#18221e] border border-[#5adc8c]/35 p-3.5 flex items-center gap-3"
                  >
                    <div className="w-20 h-16 rounded-lg bg-[#101614] p-1 shrink-0">
                      {m ? (
                        <IsometricStepSvg
                          bricks={plan}
                          palette={m.palette}
                          boardW={m.board.w}
                          boardD={m.board.d}
                          showAllBright
                        />
                      ) : null}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-white truncate">{item.modelName}</div>
                      <div className="text-[11px] text-[#9ee8bc] tabular-nums mt-0.5">
                        {item.brickCount} 顆 · {item.layerCount} 層
                      </div>
                      <div className="text-[11px] text-[#7f9a8c] tabular-nums">
                        耗時 {formatDuration(item.elapsedSec)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveShowcase(item.id)}
                      title="移出成品櫃"
                      className="p-1.5 rounded-lg text-[#7f9a8c] hover:text-[#ff9c9c] hover:bg-white/5 shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
