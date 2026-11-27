import React, { useMemo, useRef, useState } from 'react';
import { Check, Copy, ImagePlus, Layers, Play, Share2, Trash2, X } from 'lucide-react';
import type { BrickModel, ColorDef } from '../types/brick';
import { buildPlan, hexToRgb, rgbDistSq } from '../engine/brickPlanner';
import { encodeModelShareCode } from '../services/modelShare';
import { IsometricStepSvg } from './IsometricStepSvg';

interface Props {
  onPlayCustom: (model: BrickModel) => void;
  onClose: () => void;
}

const DEFAULT_PALETTE: ColorDef[] = [
  { code: '01', name: '白', hex: 0xeceff2 },
  { code: '21', name: '紅', hex: 0xd93832 },
  { code: '23', name: '藍', hex: 0x2e79c7 },
  { code: '26', name: '黑', hex: 0x22262b },
];

const GRID_W = 12;
const GRID_D = 8;

function emptyGrid(): string[] {
  return Array.from({ length: GRID_D }, () => '.'.repeat(GRID_W));
}

function starterHeartMasks(): string[][] {
  const base = [
    '............',
    '..000..000..',
    '.0000000000.',
    '.0000000000.',
    '..00000000..',
    '...000000...',
    '....0000....',
    '.....00.....',
  ];
  const top = [
    '............',
    '..110..011..',
    '.1110000111.',
    '.1100000011.',
    '..10000001..',
    '...000000...',
    '....0000....',
    '............',
  ];
  return [base, base, top];
}

export const MaskBuilderModal: React.FC<Props> = ({ onPlayCustom, onClose }) => {
  const [name, setName] = useState('自訂像素愛心');
  const [palette, setPalette] = useState<ColorDef[]>(DEFAULT_PALETTE);
  const [masks, setMasks] = useState<string[][]>(starterHeartMasks);
  const [activeLayer, setActiveLayer] = useState(0);
  const [brushColor, setBrushColor] = useState<number | null>(1); // null = eraser '.'
  const [copied, setCopied] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const model: BrickModel = useMemo(
    () => ({
      id: 'custom_' + Date.now().toString(36),
      name: name.trim() || '自訂模型',
      subtitle: '由遮罩／圖片轉換工具生成',
      difficulty: '標準',
      palette,
      board: { w: 16, d: 12 },
      masks,
      packs:
        masks.length > 4
          ? [
              { label: '第 1 包（下層）', maxLayer: Math.floor(masks.length / 2) - 1, trayIndex: 0 },
              { label: '第 2 包（上層）', maxLayer: masks.length - 1, trayIndex: 1 },
            ]
          : [{ label: '第 1 包（全套零件）', maxLayer: masks.length - 1, trayIndex: 0 }],
      isCustom: true,
    }),
    [name, palette, masks]
  );

  const plan = useMemo(() => buildPlan(model), [model]);
  const counts = useMemo(() => {
    const tally: Record<string, number> = {
      '1x4': 0,
      '2x2': 0,
      '1x3': 0,
      L3: 0,
      '1x2': 0,
      '1x1': 0,
    };
    for (const p of plan) {
      tally[p.shape] = (tally[p.shape] ?? 0) + 1;
    }
    return tally;
  }, [plan]);

  const paintCell = (x: number, z: number) => {
    setMasks(prev => {
      const next = prev.map(layer => [...layer]);
      const row = next[activeLayer][z].split('');
      row[x] = brushColor === null ? '.' : String(brushColor);
      next[activeLayer][z] = row.join('');
      return next;
    });
  };

  const addLayer = (copyCurrent: boolean) => {
    setMasks(prev => {
      const nextLayer = copyCurrent ? [...prev[activeLayer]] : emptyGrid();
      const next = [...prev, nextLayer];
      setActiveLayer(next.length - 1);
      return next;
    });
  };

  const removeLayer = () => {
    if (masks.length <= 1) return;
    setMasks(prev => {
      const next = prev.filter((_, idx) => idx !== activeLayer);
      setActiveLayer(Math.max(0, activeLayer - 1));
      return next;
    });
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = GRID_W;
      canvas.height = GRID_D;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, GRID_W, GRID_D);
      ctx.drawImage(img, 0, 0, GRID_W, GRID_D);
      const data = ctx.getImageData(0, 0, GRID_W, GRID_D).data;
      const palRgb = palette.map(c => hexToRgb(c.hex));

      const rows: string[] = [];
      for (let z = 0; z < GRID_D; z++) {
        let row = '';
        for (let x = 0; x < GRID_W; x++) {
          const i = (z * GRID_W + x) * 4;
          const a = data[i + 3];
          if (a < 80) {
            row += '.';
            continue;
          }
          const rgb: [number, number, number] = [data[i], data[i + 1], data[i + 2]];
          // 過白背景視為透明底
          if (rgb[0] > 246 && rgb[1] > 246 && rgb[2] > 246 && x === 0) {
            row += '.';
            continue;
          }
          let bestIdx = 0;
          let bestDist = Infinity;
          palRgb.forEach((pRgb, idx) => {
            const d = rgbDistSq(rgb, pRgb);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = idx;
            }
          });
          row += String(bestIdx);
        }
        rows.push(row);
      }

      setMasks([rows, [...rows]]);
      setActiveLayer(0);
      setName(file.name.replace(/\.[^.]+$/, '') || '圖片模型');
      URL.revokeObjectURL(url);
    };
    img.src = url;
    e.target.value = '';
  };

  const copyModelJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(model, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const copyShareCode = async () => {
    try {
      await navigator.clipboard.writeText(encodeModelShareCode(model));
      setCopiedShare(true);
      setTimeout(() => setCopiedShare(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const curRows = masks[activeLayer] ?? emptyGrid();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl bg-[#161a21] border border-white/14 p-5 text-[#e6edf6] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div>
            <h3 className="text-base font-semibold text-white">圖片／遮罩轉積木工具</h3>
            <p className="text-xs text-[#8a96a6]">
              匯入圖片自動量化色盤，或逐層繪製遮罩，即時計算貪心填磚與 3D 等角預覽
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#9aa6b5] hover:text-white hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 mt-4">
          {/* 左側：遮罩編輯器 */}
          <div className="lg:col-span-7 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="模型名稱"
                className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg bg-[#0d1116] border border-white/14 text-sm text-white focus:outline-none focus:border-[#7fe3ff]"
              />
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#232b36] hover:bg-[#2f3947] border border-white/12 text-xs font-medium whitespace-nowrap"
              >
                <ImagePlus className="w-3.5 h-3.5 text-[#7fe3ff]" />
                匯入圖片轉積木
              </button>
            </div>

            {/* 畫筆色盤 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-[#8a96a6] mr-1">色盤畫筆：</span>
              {palette.map((c, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setBrushColor(idx)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-colors ${
                    brushColor === idx
                      ? 'bg-[#26303d] border-[#7fe3ff] text-white'
                      : 'bg-[#0e1217] border-white/10 text-[#9aa6b5]'
                  }`}
                >
                  <span
                    className="w-3 h-3 rounded-sm border border-black/30"
                    style={{ backgroundColor: '#' + c.hex.toString(16).padStart(6, '0') }}
                  />
                  {c.name}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setBrushColor(null)}
                className={`px-2.5 py-1 rounded-lg border text-xs transition-colors ${
                  brushColor === null
                    ? 'bg-[#26303d] border-[#7fe3ff] text-white'
                    : 'bg-[#0e1217] border-white/10 text-[#9aa6b5]'
                }`}
              >
                橡皮擦
              </button>
            </div>

            {/* 層切換列 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-[#8a96a6] flex items-center gap-1 mr-1">
                <Layers className="w-3.5 h-3.5" /> 樓層：
              </span>
              {masks.map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setActiveLayer(idx)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium tabular-nums border ${
                    activeLayer === idx
                      ? 'bg-[#7fe3ff] text-[#0c1218] border-[#7fe3ff]'
                      : 'bg-[#0e1217] text-[#9aa6b5] border-white/10 hover:text-white'
                  }`}
                >
                  L{idx + 1}
                </button>
              ))}
              <button
                type="button"
                onClick={() => addLayer(true)}
                className="px-2 py-1 rounded-md text-xs bg-[#222933] hover:bg-[#2d3644] border border-white/10"
              >
                + 複製上層
              </button>
              <button
                type="button"
                onClick={() => addLayer(false)}
                className="px-2 py-1 rounded-md text-xs bg-[#222933] hover:bg-[#2d3644] border border-white/10"
              >
                + 空白層
              </button>
              {masks.length > 1 && (
                <button
                  type="button"
                  onClick={removeLayer}
                  className="p-1.5 rounded-md text-[#e58484] hover:bg-red-500/15"
                  title="刪除本層"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* 12x8 格點畫布 */}
            <div
              className="grid gap-1 p-2.5 rounded-xl bg-[#0c0f14] border border-white/10"
              style={{ gridTemplateColumns: `repeat(${GRID_W}, minmax(0, 1fr))` }}
            >
              {curRows.map((row, z) =>
                row.split('').map((ch, x) => {
                  const isDot = ch === '.';
                  const cIdx = isDot ? -1 : Number(ch);
                  const hex =
                    cIdx >= 0 && palette[cIdx]
                      ? '#' + palette[cIdx].hex.toString(16).padStart(6, '0')
                      : 'transparent';
                  return (
                    <button
                      key={`${x}_${z}`}
                      type="button"
                      onClick={() => paintCell(x, z)}
                      className="aspect-square rounded-[3px] border border-white/10 hover:border-[#7fe3ff]/70 transition-colors"
                      style={{ backgroundColor: isDot ? '#151a22' : hex }}
                      aria-label={`格點 ${x},${z}`}
                    />
                  );
                })
              )}
            </div>
          </div>

          {/* 右側：即時 3D 等角預覽與輸出 */}
          <div className="lg:col-span-5 flex flex-col justify-between gap-3">
            <div className="rounded-xl bg-[#0e1218] border border-white/10 p-3">
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-medium text-[#cfd8e3]">即時 3D 等角預覽</span>
                <span className="text-[#7fe3ff] tabular-nums font-medium">
                  共 {plan.length} 顆 · {masks.length} 層
                </span>
              </div>
              <div className="aspect-[4/3] w-full rounded-lg bg-[#141920] p-2">
                <IsometricStepSvg
                  bricks={plan}
                  palette={palette}
                  boardW={model.board.w}
                  boardD={model.board.d}
                  showAllBright
                />
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#95a2b3] tabular-nums">
                {counts['4x4'] ? <span>4×4：{counts['4x4']}</span> : null}
                {counts['2x4'] ? <span>2×4：{counts['2x4']}</span> : null}
                {counts['2x3'] ? <span>2×3：{counts['2x3']}</span> : null}
                <span>1×4：{counts['1x4']}</span>
                <span>2×2：{counts['2x2']}</span>
                <span>1×3：{counts['1x3']}</span>
                <span>L3 轉角：{counts.L3}</span>
                <span>1×2：{counts['1x2']}</span>
                <span>1×1：{counts['1x1']}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                disabled={plan.length === 0}
                onClick={() => onPlayCustom(model)}
                className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl bg-[#7fe3ff] text-[#0c141b] font-semibold text-sm hover:bg-[#9beaff] disabled:opacity-40 transition-colors"
              >
                <Play className="w-4 h-4" />
                立即在 3D 工坊拼砌（{plan.length} 顆）
              </button>
              <button
                type="button"
                disabled={plan.length === 0}
                onClick={copyShareCode}
                className="flex items-center justify-center gap-2 w-full py-2 px-4 rounded-xl bg-[#27303d] hover:bg-[#323e4f] border border-[#7fe3ff]/30 text-xs font-medium text-[#cfe8f7] disabled:opacity-40 transition-colors"
              >
                {copiedShare ? <Check className="w-3.5 h-3.5 text-[#6fdc9a]" /> : <Share2 className="w-3.5 h-3.5 text-[#7fe3ff]" />}
                {copiedShare ? '已複製玩家分享碼（BW1）' : '複製玩家分享碼（可貼給朋友拼砌）'}
              </button>
              <button
                type="button"
                onClick={copyModelJson}
                className="flex items-center justify-center gap-2 w-full py-2 px-4 rounded-xl bg-[#202732] hover:bg-[#2a3340] border border-white/12 text-xs font-medium text-[#d6dee9] transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-[#6fdc9a]" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? '已複製 MODELS[] JSON' : '複製 MODELS[] JSON 定義'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
