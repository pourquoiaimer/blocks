import React from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { FeelSettings } from '../types/brick';
import { DEFAULT_FEEL } from '../services/storage';

interface Props {
  feel: FeelSettings;
  onChange: (next: FeelSettings) => void;
  onClose: () => void;
}

export const FeelSettingsModal: React.FC<Props> = ({ feel, onChange, onClose }) => {
  const update = <K extends keyof FeelSettings>(key: K, val: FeelSettings[K]) => {
    onChange({ ...feel, [key]: val });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-[#161a21] border border-white/14 p-5 text-[#e6edf6] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-base font-semibold text-white">手感與放置模式調整</h3>
            <p className="text-xs text-[#8a96a6]">每次調整單一參數即可立即在 3D 桌面實測</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#9aa6b5] hover:text-white hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4 text-sm">
          {/* 拿取與放置操作習慣（桌機／手機可自由切換） */}
          <div>
            <div className="text-xs font-medium text-[#a5b2c2] mb-1.5">拿取與放置方式（桌機／手機皆可切換）</div>
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-[#0e1116] border border-white/10">
              {(
                [
                  { id: 'auto', label: '自動偵測' },
                  { id: 'drag', label: '長按拖曳' },
                  { id: 'tap', label: '點選拿取' },
                ] as const
              ).map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => update('controlStyle', opt.id)}
                  className={`py-2 px-2 rounded-lg text-xs font-medium transition-colors ${
                    feel.controlStyle === opt.id
                      ? 'bg-[#7fe3ff] text-[#0c141c] font-semibold'
                      : 'text-[#8794a4] hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[#7c8898]">
              {feel.controlStyle === 'tap'
                ? '點一下拿起來浮空 → 可單手按「旋轉」，再點底板就放下。'
                : feel.controlStyle === 'drag'
                  ? '按住拖曳對位、放開即放下（觸控拖曳時另一指輕點可轉 90°）。'
                  : '觸控自動用「點選拿取」，滑鼠自動用「長按拖曳」，也可隨時手動強制切換。'}
            </p>
          </div>

          {/* 放置模式切換 */}
          <div>
            <div className="text-xs font-medium text-[#a5b2c2] mb-1.5">放置與壓緊機制</div>
            <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[#0e1116] border border-white/10">
              <button
                type="button"
                onClick={() => update('placementMode', 'instant')}
                className={`py-2 px-3 rounded-lg text-xs font-medium transition-colors ${
                  feel.placementMode === 'instant'
                    ? 'bg-[#2a3544] text-white'
                    : 'text-[#8794a4] hover:text-white'
                }`}
              >
                放開即壓緊（預設）
              </button>
              <button
                type="button"
                onClick={() => update('placementMode', 'two-step')}
                className={`py-2 px-3 rounded-lg text-xs font-medium transition-colors ${
                  feel.placementMode === 'two-step'
                    ? 'bg-[#2a3544] text-white'
                    : 'text-[#8794a4] hover:text-white'
                }`}
              >
                輕放後點擊壓緊
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-[#7c8898]">
              {feel.placementMode === 'instant'
                ? '放開／點擊綠框直接卡緊並與上下層連帶鎖定。'
                : '先輕放於顆粒上微調，再次輕點即壓緊喀嗒鎖定。'}
            </p>
          </div>

          {/* 拖曳平滑度 */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#a5b2c2]">拖曳跟手速度（lerp）</span>
              <span className="font-mono tabular-nums text-[#7fe3ff]">{feel.dragSmoothing}</span>
            </div>
            <input
              type="range"
              min={12}
              max={36}
              step={1}
              value={feel.dragSmoothing}
              onChange={e => update('dragSmoothing', Number(e.target.value))}
              className="w-full accent-[#7fe3ff]"
            />
          </div>

          {/* 手持懸浮高度 */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#a5b2c2]">手持懸浮高度（holdY 倍率）</span>
              <span className="font-mono tabular-nums text-[#7fe3ff]">
                {feel.holdHeightMul.toFixed(2)}×
              </span>
            </div>
            <input
              type="range"
              min={0.85}
              max={1.9}
              step={0.05}
              value={feel.holdHeightMul}
              onChange={e => update('holdHeightMul', Number(e.target.value))}
              className="w-full accent-[#7fe3ff]"
            />
          </div>

          {/* 吸附邊緣容差 */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#a5b2c2]">組裝區磁吸邊界容差</span>
              <span className="font-mono tabular-nums text-[#7fe3ff]">
                {feel.snapTolerance.toFixed(1)} 格
              </span>
            </div>
            <input
              type="range"
              min={0.8}
              max={2.2}
              step={0.1}
              value={feel.snapTolerance}
              onChange={e => update('snapTolerance', Number(e.target.value))}
              className="w-full accent-[#7fe3ff]"
            />
          </div>

          {/* 音效、震動觸覺、視角接力與步驟線框 */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <label className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#10141a] border border-white/10 cursor-pointer text-xs">
              <span>塑膠喀嗒音效</span>
              <input
                type="checkbox"
                checked={feel.soundEnabled}
                onChange={e => update('soundEnabled', e.target.checked)}
                className="accent-[#7fe3ff]"
              />
            </label>
            <label className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#10141a] border border-white/10 cursor-pointer text-xs">
              <span>手機震動回饋</span>
              <input
                type="checkbox"
                checked={feel.hapticsEnabled}
                onChange={e => update('hapticsEnabled', e.target.checked)}
                className="accent-[#7fe3ff]"
              />
            </label>
            <label className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#10141a] border border-white/10 cursor-pointer text-xs">
              <span>籃內取磚自動回組裝區</span>
              <input
                type="checkbox"
                checked={feel.autoFollowBuildView}
                onChange={e => update('autoFollowBuildView', e.target.checked)}
                className="accent-[#7fe3ff]"
              />
            </label>
            <label className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#10141a] border border-white/10 cursor-pointer text-xs">
              <span>當前步驟線框</span>
              <input
                type="checkbox"
                checked={feel.showStepGuide}
                onChange={e => update('showStepGuide', e.target.checked)}
                className="accent-[#7fe3ff]"
              />
            </label>
          </div>
        </div>

        <div className="mt-5 pt-3 border-t border-white/10 flex items-center justify-between">
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_FEEL })}
            className="flex items-center gap-1.5 text-xs text-[#9aa6b5] hover:text-white"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            恢復預設值
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-[#7fe3ff] text-[#0e141b] text-xs font-semibold hover:bg-[#9beaff] transition-colors"
          >
            套用並返回
          </button>
        </div>
      </div>
    </div>
  );
};
