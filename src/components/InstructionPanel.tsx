import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Layers, Lightbulb, ListOrdered, Maximize2, Palette, PanelRightClose } from 'lucide-react';
import type { BrickModel, BuildStep, ManualViewMode, PlanBrick } from '../types/brick';
import { SHAPES } from '../engine/brickPlanner';
import { IsometricStepSvg } from './IsometricStepSvg';

interface Props {
  model: BrickModel;
  plan: PlanBrick[];
  steps: BuildStep[];
  matchedIndices: number[];
  manualMode: ManualViewMode;
  onManualModeChange: (m: ManualViewMode) => void;
  activeStepIdx: number;
  onSelectStep: (idx: number) => void;
  onZoomStep: (step: BuildStep) => void;
  onZoomLayer: (layer: number) => void;
  onCollapse: () => void;
  showStepGuide: boolean;
  onToggleStepGuide: () => void;
}

function summarizeParts(bricks: PlanBrick[], palette: BrickModel['palette']) {
  const map = new Map<string, { shape: PlanBrick['shape']; color: number; count: number }>();
  for (const b of bricks) {
    const key = `${b.shape}:${b.color}`;
    const prev = map.get(key);
    if (prev) prev.count++;
    else map.set(key, { shape: b.shape, color: b.color, count: 1 });
  }
  return [...map.values()].map(item => ({
    ...item,
    hex: '#' + (palette[item.color]?.hex ?? 0xeceff2).toString(16).padStart(6, '0'),
    colorName: palette[item.color]?.name ?? '',
    colorCode: palette[item.color]?.code ?? String(item.color + 1),
  }));
}

export const LayerGridDiagram: React.FC<{
  layer: number;
  plan: PlanBrick[];
  model: BrickModel;
}> = React.memo(({ layer, plan, model }) => {
  const { cells } = useMemo(() => {
    const Wd = model.board.w;
    const Ht = model.board.d;
    const owner = Array.from({ length: Ht }, () => Array<number>(Wd).fill(-1));
    const color = Array.from({ length: Ht }, () => Array<number | null>(Wd).fill(null));
    const prev = Array.from({ length: Ht }, () => Array<boolean>(Wd).fill(false));

    plan.forEach((p, i) => {
      if (p.layer < layer) {
        for (const c of p.cells) {
          const [x, z] = c.split(',').map(Number);
          if (prev[z] && prev[z][x] !== undefined) prev[z][x] = true;
        }
      } else if (p.layer === layer) {
        for (const c of p.cells) {
          const [x, z] = c.split(',').map(Number);
          if (owner[z] && owner[z][x] !== undefined) {
            owner[z][x] = i;
            color[z][x] = p.color;
          }
        }
      }
    });

    const out: {
      key: string;
      on: boolean;
      isPrev: boolean;
      bg: string;
      borderTop: string;
      borderBottom: string;
      borderLeft: string;
      borderRight: string;
    }[] = [];

    for (let z = 0; z < Ht; z++) {
      for (let x = 0; x < Wd; x++) {
        const idx = owner[z][x];
        const on = idx >= 0;
        const isPrev = !on && prev[z][x];
        let bg = 'transparent';
        let borderTop = '1px solid rgba(255,255,255,0.06)';
        let borderBottom = '1px solid rgba(255,255,255,0.06)';
        let borderLeft = '1px solid rgba(255,255,255,0.06)';
        let borderRight = '1px solid rgba(255,255,255,0.06)';
        if (on && color[z][x] !== null) {
          const hex = (model.palette[color[z][x]!]?.hex ?? 0xeceff2).toString(16).padStart(6, '0');
          bg = `#${hex}`;
          const same = (dx: number, dz: number) => {
            const nx = x + dx;
            const nz = z + dz;
            return nz >= 0 && nz < Ht && nx >= 0 && nx < Wd && owner[nz][nx] === idx;
          };
          borderTop = !same(0, -1) ? '2px solid #0b0e12' : '1px solid rgba(0,0,0,0.12)';
          borderBottom = !same(0, 1) ? '2px solid #0b0e12' : '1px solid rgba(0,0,0,0.12)';
          borderLeft = !same(-1, 0) ? '2px solid #0b0e12' : '1px solid rgba(0,0,0,0.12)';
          borderRight = !same(1, 0) ? '2px solid #0b0e12' : '1px solid rgba(0,0,0,0.12)';
        } else if (isPrev) {
          bg = '#3a434e';
          borderTop = '1px solid #262d36';
          borderBottom = '1px solid #262d36';
          borderLeft = '1px solid #262d36';
          borderRight = '1px solid #262d36';
        }
        out.push({ key: `${x}_${z}`, on, isPrev, bg, borderTop, borderBottom, borderLeft, borderRight });
      }
    }
    return { cells: out };
  }, [layer, plan, model]);

  return (
    <div
      className="grid gap-0 bg-[#0e1116] p-1 rounded"
      style={{ gridTemplateColumns: `repeat(${model.board.w}, minmax(0, 1fr))` }}
    >
      {cells.map(c => (
        <div
          key={c.key}
          className="relative aspect-square w-full box-border"
          style={{
            backgroundColor: c.bg,
            backgroundImage: c.on
              ? 'linear-gradient(180deg, rgba(255,255,255,0.28), rgba(0,0,0,0.18))'
              : undefined,
            borderTop: c.borderTop,
            borderBottom: c.borderBottom,
            borderLeft: c.borderLeft,
            borderRight: c.borderRight,
          }}
        >
          {c.on && (
            <span
              className="absolute inset-[28%] rounded-full bg-black/20"
              aria-hidden="true"
            />
          )}
        </div>
      ))}
    </div>
  );
});

export const InstructionPanel: React.FC<Props> = ({
  model,
  plan,
  steps,
  matchedIndices,
  manualMode,
  onManualModeChange,
  activeStepIdx,
  onSelectStep,
  onZoomStep,
  onZoomLayer,
  onCollapse,
  showStepGuide,
  onToggleStepGuide,
}) => {
  const [showColorTable, setShowColorTable] = useState(false);
  const matchedSet = useMemo(() => new Set(matchedIndices), [matchedIndices]);

  const currentStep = steps[activeStepIdx] ?? steps[0];
  const stepParts = useMemo(
    () => (currentStep ? summarizeParts(currentStep.bricks, model.palette) : []),
    [currentStep, model.palette]
  );

  const layers = useMemo(() => {
    const byLayer = new Map<number, PlanBrick[]>();
    for (const p of plan) {
      let arr = byLayer.get(p.layer);
      if (!arr) {
        arr = [];
        byLayer.set(p.layer, arr);
      }
      arr.push(p);
    }
    return [...byLayer.entries()].sort((a, b) => a[0] - b[0]);
  }, [plan]);

  return (
    <aside className="fixed right-3 top-3 bottom-16 w-[316px] max-w-[calc(100vw-24px)] z-10 flex flex-col rounded-xl bg-[#11151b]/95 border border-white/10 text-[#d6dee9] shadow-2xl">
      {/* 標題與快捷工具 */}
      <div className="flex items-center justify-between gap-1.5 px-3 pt-2.5 pb-2 border-b border-white/10">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-[#7fe3ff] truncate">
            {model.name} · 組裝說明書
          </h2>
          <p className="text-[11px] text-[#8490a0] tabular-nums">
            {matchedIndices.length}/{plan.length} 顆完成
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setShowColorTable(v => !v)}
            title="色號對照表"
            className={`p-1.5 rounded-lg transition-colors ${
              showColorTable
                ? 'bg-[#253040] text-[#7fe3ff]'
                : 'text-[#9aa6b5] hover:text-white hover:bg-white/10'
            }`}
          >
            <Palette className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onToggleStepGuide}
            title={showStepGuide ? '關閉桌面虛影提示' : '在組裝區提示本步虛影'}
            className={`p-1.5 rounded-lg transition-colors ${
              showStepGuide
                ? 'bg-[#362c18] text-[#f4c430]'
                : 'text-[#9aa6b5] hover:text-white hover:bg-white/10'
            }`}
          >
            <Lightbulb className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            title="隱藏說明書（H）"
            className="p-1.5 rounded-lg text-[#9aa6b5] hover:text-white hover:bg-white/10 transition-colors"
          >
            <PanelRightClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 色號對照表（可展開） */}
      {showColorTable && (
        <div className="px-3 py-2 bg-[#0c0f14] border-b border-white/10">
          <div className="text-[10.5px] text-[#8b98a8] mb-1.5">積木色號對照表</div>
          <div className="flex flex-wrap gap-1.5">
            {model.palette.map((c, idx) => (
              <div
                key={idx}
                className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#161c24] border border-white/10 text-[10.5px]"
              >
                <span
                  className="w-2.5 h-2.5 rounded-[2px] border border-black/40 shrink-0"
                  style={{ backgroundColor: '#' + c.hex.toString(16).padStart(6, '0') }}
                />
                <span className="font-mono text-[#7fe3ff]">#{c.code}</span>
                <span className="text-[#cfd8e3]">{c.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 分段切換：步驟制 vs 分層總覽 */}
      <div className="px-3 pt-2 pb-1.5">
        <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#0b0e12] border border-white/10">
          <button
            type="button"
            onClick={() => onManualModeChange('steps')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-[11.5px] font-medium whitespace-nowrap transition-colors ${
              manualMode === 'steps'
                ? 'bg-[#222a35] text-white'
                : 'text-[#8490a0] hover:text-white'
            }`}
          >
            <ListOrdered className="w-3.5 h-3.5" />
            步驟制 (3–6顆)
          </button>
          <button
            type="button"
            onClick={() => onManualModeChange('layers')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-[11.5px] font-medium whitespace-nowrap transition-colors ${
              manualMode === 'layers'
                ? 'bg-[#222a35] text-white'
                : 'text-[#8490a0] hover:text-white'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            分層俯視
          </button>
        </div>
      </div>

      {/* 主內容區 */}
      {manualMode === 'steps' && currentStep ? (
        <div className="flex-1 flex flex-col min-h-0 px-3 pb-3 pt-1">
          {/* 步驟導覽列 */}
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <button
              type="button"
              disabled={activeStepIdx <= 0}
              onClick={() => onSelectStep(Math.max(0, activeStepIdx - 1))}
              className="p-1.5 rounded-lg bg-[#1a2028] border border-white/10 text-[#cfd8e3] disabled:opacity-35 hover:bg-[#252d38] transition-colors"
              title="上一步"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="text-center min-w-0">
              {currentStep.sectionName && (
                <div className="text-[10.5px] font-medium text-[#f4c430] truncate">
                  {currentStep.sectionName}
                </div>
              )}
              <div className="text-[13px] font-semibold text-white tabular-nums">
                步驟 {currentStep.stepIndex + 1} / {steps.length}
              </div>
              <div className="text-[11px] text-[#8490a0] tabular-nums">
                第 {currentStep.layer + 1} 層 · 本步 {currentStep.bricks.filter(b => matchedSet.has(b.index)).length}/{currentStep.bricks.length} 顆
              </div>
            </div>
            <button
              type="button"
              disabled={activeStepIdx >= steps.length - 1}
              onClick={() => onSelectStep(Math.min(steps.length - 1, activeStepIdx + 1))}
              className="p-1.5 rounded-lg bg-[#1a2028] border border-white/10 text-[#cfd8e3] disabled:opacity-35 hover:bg-[#252d38] transition-colors"
              title="下一步"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* 當前步驟所需零件清單（含色號標示） */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {stepParts.map(pt => (
              <div
                key={`${pt.shape}_${pt.color}`}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#0b0e12] border border-white/10 text-[11px] text-[#d4dde8]"
                title={`${pt.colorName} (#${pt.colorCode})`}
              >
                <span className="flex items-center">
                  {Array.from({ length: SHAPES[pt.shape].cells.length }).map((_, i) => (
                    <i
                      key={i}
                      className="w-2 h-2 block border border-[#10141a] -ml-[1px] first:ml-0 rounded-[1px]"
                      style={{ backgroundColor: pt.hex }}
                    />
                  ))}
                </span>
                <span className="font-mono text-[10px] text-[#8da2b8]">#{pt.colorCode}</span>
                <span className="tabular-nums font-medium">×{pt.count}</span>
              </div>
            ))}
          </div>

          {/* 3D 等角小圖卡片 */}
          <button
            type="button"
            onClick={() => onZoomStep(currentStep)}
            className="relative w-full aspect-[4/3] rounded-xl bg-[#161c24] border border-white/12 hover:border-[#7fe3ff]/50 transition-colors p-2 group cursor-pointer"
          >
            <IsometricStepSvg
              bricks={currentStep.bricks}
              prevBricks={currentStep.prevBricks}
              palette={model.palette}
              boardW={model.board.w}
              boardD={model.board.d}
            />
            <span className="absolute right-2 bottom-2 flex items-center gap-1 text-[10.5px] text-[#9fb0c4] bg-[#0e1218]/90 px-2 py-0.5 rounded border border-white/10 group-hover:text-white">
              <Maximize2 className="w-3 h-3" />
              放大 3D 圖
            </span>
          </button>

          {/* 步驟快速索引列表 */}
          <div className="mt-2.5 flex-1 overflow-y-auto pr-1 space-y-1">
            {steps.map(st => {
              const done = st.bricks.filter(b => matchedSet.has(b.index)).length;
              const allDone = done === st.bricks.length;
              const isCur = st.stepIndex === activeStepIdx;
              return (
                <button
                  key={st.stepIndex}
                  type="button"
                  onClick={() => onSelectStep(st.stepIndex)}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left text-[11.5px] border transition-colors ${
                    isCur
                      ? 'bg-[#1f2936] border-[#7fe3ff]/65 text-white'
                      : allDone
                        ? 'bg-[#16261f] border-[#5adc8c]/35 text-[#9ee8bc]'
                        : 'bg-[#171c23] border-white/8 text-[#9aa6b5] hover:bg-[#1e252e]'
                  }`}
                >
                  <span className="font-medium tabular-nums truncate">
                    步驟 {st.stepIndex + 1} · 第 {st.layer + 1} 層
                  </span>
                  <span className="tabular-nums shrink-0 text-[11px]">
                    {done}/{st.bricks.length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 pb-3 pt-1 space-y-2">
          <p className="text-[11px] text-[#7f8b9a]">
            點任一層可放大；灰＝下層已完成，彩＝本層
          </p>
          {layers.map(([L, items]) => {
            const done = items.filter(p => matchedSet.has(p.index)).length;
            const allDone = done === items.length;
            const parts = summarizeParts(items, model.palette);
            return (
              <button
                key={L}
                type="button"
                onClick={() => onZoomLayer(L)}
                className={`w-full text-left flex items-start gap-2.5 p-2 rounded-xl border transition-colors ${
                  allDone
                    ? 'bg-[#182a22] border-[#5adc8c]/45'
                    : 'bg-[#192028] border-white/10 hover:border-[#7fe3ff]/45'
                }`}
              >
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 tabular-nums ${
                    allDone ? 'bg-[#6fdc9a] text-[#101614]' : 'bg-[#e8eef6] text-[#12161c]'
                  }`}
                >
                  {L + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between text-[11.5px] font-semibold mb-1">
                    <span>第 {L + 1} 層</span>
                    <span className={`tabular-nums ${allDone ? 'text-[#6fdc9a]' : 'text-[#8b95a3]'}`}>
                      {done}/{items.length}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {parts.map(pt => (
                      <span
                        key={`${pt.shape}_${pt.color}`}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#0e1116] border border-white/10 text-[10px]"
                      >
                        <span className="flex">
                          {Array.from({ length: SHAPES[pt.shape].cells.length }).map((_, i) => (
                            <i
                              key={i}
                              className="w-1.5 h-1.5 block border border-[#12161c]"
                              style={{ backgroundColor: pt.hex }}
                            />
                          ))}
                        </span>
                        ×{pt.count}
                      </span>
                    ))}
                  </div>
                  <LayerGridDiagram layer={L} plan={plan} model={model} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
};
