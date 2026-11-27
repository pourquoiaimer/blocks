import React, { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Layers,
  Lightbulb,
  ListOrdered,
  Maximize2,
  Palette,
  PanelRightClose,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
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
  manualYawDeg: number;
  manualPitchDeg: number;
  onRotateManual: (yawDeg: number, pitchDeg: number) => void;
}

export function formatViewDirection(yawDeg: number): string {
  const norm = ((yawDeg % 360) + 360) % 360;
  if (norm < 23 || norm >= 338) return '正面';
  if (norm < 68) return '右前';
  if (norm < 113) return '右側';
  if (norm < 158) return '右後';
  if (norm < 203) return '背面';
  if (norm < 248) return '左後';
  if (norm < 293) return '左側';
  return '左前';
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
    transparent: Boolean(palette[item.color]?.transparent),
    finish: palette[item.color]?.finish,
  }));
}

export const BrickMiniIcon: React.FC<{
  shape: PlanBrick['shape'];
  hex: string;
  transparent?: boolean;
  small?: boolean;
}> = ({ shape, hex, transparent, small = false }) => {
  const unit =
    shape === '4x4'
      ? small
        ? 3.5
        : 4.5
      : shape === '2x4' || shape === '2x3'
        ? small
          ? 4.5
          : 5.8
        : small
          ? 6
          : 8;
  const stroke = transparent ? '#9fe4ff' : '#10141a';
  const fillOpacity = transparent ? 0.65 : 1;

  if (shape === 'slope1x1') {
    const w = unit + 2;
    const h = unit + 2;
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
        <polygon
          points={`1,${h - 1} ${w - 1},${h - 1} ${w - 1},${h - 3} 3,1 1,1`}
          fill={hex}
          fillOpacity={fillOpacity}
          stroke={stroke}
          strokeWidth={1}
        />
      </svg>
    );
  }

  if (shape === 'slope1x2') {
    const w = unit * 2 + 2;
    const h = unit + 2;
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
        <polygon
          points={`1,${h - 1} ${w - 1},${h - 1} ${w - 1},${h - 3} ${unit + 1},1 1,1`}
          fill={hex}
          fillOpacity={fillOpacity}
          stroke={stroke}
          strokeWidth={1}
        />
      </svg>
    );
  }

  const cells = SHAPES[shape].cells;
  const cols = Math.max(...cells.map(c => c[0])) + 1;
  const rows = Math.max(...cells.map(c => c[1])) + 1;
  return (
    <svg width={cols * unit} height={rows * unit} viewBox={`0 0 ${cols * unit} ${rows * unit}`} className="shrink-0">
      {cells.map(([cx, cz], i) => (
        <rect
          key={i}
          x={cx * unit + 0.5}
          y={cz * unit + 0.5}
          width={unit - 1}
          height={unit - 1}
          rx={1}
          fill={hex}
          fillOpacity={fillOpacity}
          stroke={stroke}
          strokeWidth={0.9}
        />
      ))}
    </svg>
  );
};

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
          const def = model.palette[color[z][x]!];
          const hex = (def?.hex ?? 0xeceff2).toString(16).padStart(6, '0');
          bg = def?.transparent ? `rgba(${(def.hex >> 16) & 255},${(def.hex >> 8) & 255},${def.hex & 255},0.48)` : `#${hex}`;
          const same = (dx: number, dz: number) => {
            const nx = x + dx;
            const nz = z + dz;
            return nz >= 0 && nz < Ht && nx >= 0 && nx < Wd && owner[nz][nx] === idx;
          };
          const edge = def?.transparent ? '#9fe4ff' : '#0b0e12';
          borderTop = !same(0, -1) ? `2px solid ${edge}` : '1px solid rgba(0,0,0,0.12)';
          borderBottom = !same(0, 1) ? `2px solid ${edge}` : '1px solid rgba(0,0,0,0.12)';
          borderLeft = !same(-1, 0) ? `2px solid ${edge}` : '1px solid rgba(0,0,0,0.12)';
          borderRight = !same(1, 0) ? `2px solid ${edge}` : '1px solid rgba(0,0,0,0.12)';
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
  manualYawDeg,
  manualPitchDeg,
  onRotateManual,
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
    <aside className="fixed right-2 sm:right-3 top-2 sm:top-3 bottom-24 sm:bottom-16 w-[288px] sm:w-[316px] max-w-[calc(100vw-16px)] z-20 flex flex-col rounded-xl bg-[#11151b]/95 border border-white/10 text-[#d6dee9] shadow-2xl">
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
                  className={`w-2.5 h-2.5 rounded-[2px] shrink-0 ${
                    c.transparent ? 'border border-[#9fe4ff] opacity-65' : 'border border-black/40'
                  }`}
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

          {/* 當前步驟所需零件清單（含色號與積木形狀標示） */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {stepParts.map(pt => (
              <div
                key={`${pt.shape}_${pt.color}`}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#0b0e12] border border-white/10 text-[11px] text-[#d4dde8]"
                title={`${pt.colorName} (#${pt.colorCode}) · ${SHAPES[pt.shape].label}`}
              >
                <BrickMiniIcon shape={pt.shape} hex={pt.hex} transparent={pt.transparent} />
                <span className="font-mono text-[10px] text-[#8da2b8]">#{pt.colorCode}</span>
                <span className="tabular-nums font-medium">×{pt.count}</span>
              </div>
            ))}
          </div>

          {/* 3D 步驟示意圖（支援拖曳自由旋轉與按鈕轉向） */}
          <div className="relative w-full rounded-xl bg-[#161c24] border border-white/12 p-2">
            <div className="flex items-center justify-between gap-1 mb-1.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onRotateManual(((manualYawDeg - 45) % 360 + 360) % 360, manualPitchDeg)}
                  title="向左旋轉 45°"
                  className="p-1 rounded-md bg-[#0e1218] hover:bg-[#222a36] border border-white/10 text-[#b7c4d4] hover:text-white transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onRotateManual((manualYawDeg + 45) % 360, manualPitchDeg)}
                  title="向右旋轉 45°"
                  className="p-1 rounded-md bg-[#0e1218] hover:bg-[#222a36] border border-white/10 text-[#b7c4d4] hover:text-white transition-colors"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onRotateManual(0, 26)}
                  title="切到正視角"
                  className="px-1.5 py-0.5 rounded-md bg-[#0e1218] hover:bg-[#222a36] border border-white/10 text-[10.5px] text-[#9fb0c4] hover:text-white whitespace-nowrap transition-colors"
                >
                  正面
                </button>
                <span className="text-[10.5px] text-[#7fe3ff] tabular-nums ml-1 whitespace-nowrap">
                  {formatViewDirection(manualYawDeg)} {Math.round(manualYawDeg)}°
                </span>
              </div>
              <button
                type="button"
                onClick={() => onZoomStep(currentStep)}
                className="flex items-center gap-1 text-[10.5px] text-[#9fb0c4] hover:text-white bg-[#0e1218] px-2 py-0.5 rounded-md border border-white/10 whitespace-nowrap transition-colors"
              >
                <Maximize2 className="w-3 h-3" />
                放大
              </button>
            </div>
            <div className="aspect-[4/3] w-full rounded-lg bg-[#10151c] overflow-hidden">
              <IsometricStepSvg
                bricks={currentStep.bricks}
                prevBricks={currentStep.prevBricks}
                palette={model.palette}
                boardW={model.board.w}
                boardD={model.board.d}
                yawDeg={manualYawDeg}
                pitchDeg={manualPitchDeg}
                interactive
                onRotateChange={onRotateManual}
                onClickCanvas={() => onZoomStep(currentStep)}
              />
            </div>
            <div className="mt-1 text-[10px] text-[#7c8a9b] text-center">
              可直接在圖上拖曳旋轉視角 · 藍三角為模型正面
            </div>
          </div>

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
                        <BrickMiniIcon shape={pt.shape} hex={pt.hex} transparent={pt.transparent} small />
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
