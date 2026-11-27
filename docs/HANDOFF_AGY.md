# 積木工坊（Brick Workshop 3D）— 本地 Antigravity (`agy`) 接手開發文件

本文件為交接給本地開發環境 / Antigravity (`agy`) 的技術現況與待辦指南，方便直接接續完成剩餘 UI、模型與後續功能迭代。

---

## 一、專案技術棧與快速驗證

- **前端框架**：React 19 + TypeScript + Vite + Tailwind CSS v4 (`@import "tailwindcss";`)
- **3D 與物理**：Three.js + `@dimforge/rapier3d-compat`（單檔主引擎於 `src/engine/BrickWorkshopEngine.ts`）
- **常用指令**：
  ```bash
  npm install
  npm run dev      # Vite + Express dev server (Port 3000)
  npm run lint     # tsc --noEmit 型別檢查
  npm run build    # 正式打包檢查
  ```

> **重要不變量**：`src/engine/brickPlanner.ts` 中的 `CELL = 0.55`、`BRICK_H = CELL * 1.2`、`STUD_R`、`STUD_H` 為所有物理碰撞、對齊格點與說明書投影的基準常數，**請勿隨意修改**。

---

## 二、程式碼架構總覽

| 檔案路徑 | 職責說明 |
| :--- | :--- |
| `src/types/brick.ts` | 核心型別：`ShapeKey`（11 種）、`MaterialFinish`、`BrickModel`（含 `largePlateLayers` / `allowLargePlates`、`specialBricks`、`standMount`）、`WorkshopHudSnapshot` |
| `src/engine/brickPlanner.ts` | 積木拆解填磚 (`fillMask`)、最小磚數精算 (`solveExactComponent`)、分包分袋 (`assignSortedPouches`)、步驟產生 (`buildSteps`) |
| `src/engine/brickGeometry.ts` | 帶微倒角與縫隙的 3D 積木幾何快取（支援方形、L3、斜坡、2×3 / 2×4 / 4×4 大板） |
| `src/engine/roomDiorama.ts` | 書桌前方牆面、可開關窗簾、日夜切換田園／星空場景、3D 乳牛／貓頭鷹常駐與**進房整理動畫** (`triggerTidyAnimation`) |
| `src/engine/BrickWorkshopEngine.ts` | Three.js 場景 + Rapier3D 物理世界、雙控制模式（拖曳／點放）、拆件器 (`X`)、翻找 (`F`)、復原、商品開箱與分裝袋動畫、沙盒下單 (`orderSandboxBatch`) |
| `src/data/models.ts` | 所有內建 3D 模型體素遮罩與 `SANDBOX_PALETTE`（共 11 組現成模型） |
| `src/components/InstructionPanel.tsx` | 右側說明書（步驟制／分層俯視、可匯出的 `BrickMiniIcon`、色號對照表） |
| `src/components/IsometricStepSvg.tsx` | 支援 360° 拖曳旋轉的 3D 等角步驟圖 Canvas 渲染器 |
| `src/components/MaskBuilderModal.tsx` | 圖片匯入量化轉積木與逐層遮罩編輯器（支援匯出 JSON 與 `BW1:` 分享碼） |
| `src/components/WorkshopMenu.tsx` | 主選單、圖紙庫、3 格成品櫃、`BW1:` 分享碼匯入與本地存檔監控 |
| `src/services/boxArtwork.ts` | 商品彩繪箱封面與側面貼圖的即時 Canvas 繪製 |
| `src/services/storage.ts` | `localStorage` 存檔封裝與容量計算 |
| `src/services/modelShare.ts` | 玩家自創作品 `BW1:` 分享碼編解碼 |
| `src/services/crazyGames.ts` | CrazyGames SDK 封裝接口 |
| `src/App.tsx` | 主介面 HUD、視角導航條、盤籃管理列、沙盒訂購面板與非遮罩動物字幕條 |

---

## 三、最新已完成狀態（交接時已實作並通過編譯／型別檢查）

1. **新增大型板磚規格 (`2x3`、`2x4`、`4x4`)**
   - `src/types/brick.ts` 與 `src/engine/brickPlanner.ts` 已加入 `2x3`、`2x4`、`4x4` 與 `FILL_TEMPLATES_LARGE`。
   - `BrickModel` 新增 `largePlateLayers?: number[]` 與 `allowLargePlates?: boolean`，可指定模型特定樓層（例如餐盤、底座 L0）優先使用 `4x4` / `2x4` / `2x3` 大板，其餘樓層仍保持精緻小件細節。
   - `src/components/InstructionPanel.tsx` 的 `BrickMiniIcon` 已匯出並針對大板縮小比例，避免零件標籤過寬。
   - `src/engine/BrickWorkshopEngine.ts` 在盤子與深籃投放積木時已改用依積木尺寸計算的安全邊距 (`Math.max(1.15, Math.max(bb.w, bb.d) * 0.56)`)，避免 `4x4` 卡到盤壁。

2. **3D 乳牛／貓頭鷹進房整理動畫（取消黑屏過場）**
   - `src/engine/roomDiorama.ts` 新增 `triggerTidyAnimation(tod)`：
     - **白天**：草地乳牛會跨過圍欄與窗台走到書桌靠鏡頭側（微調放大約 `1.32x`），左右擺頭把積木掃進盤籃再躍回草地；若原本關著窗簾會自動微掀，結束後復位。
     - **夜晚**：樹梢貓頭鷹會展翅拍翼飛進窗內，在書桌上空盤旋俯衝後飛回枝頭。
   - `src/engine/BrickWorkshopEngine.ts` 已暴露 `playAnimalTidyAnimation()`。
   - `src/App.tsx` 已將 `tidyOverlay` 改為頂部**半透明非遮罩浮動字幕 (`pointer-events-none`)**，並在 `1250ms`（動物抵桌中央掃動時）同步呼叫 `tidyOverflowWithAnimal()`。

3. **無盡自由模式開局淨空與批次訂購引擎 API**
   - `src/engine/BrickWorkshopEngine.ts` 已移除 `spawnSandboxStarterSet()`，開局桌面保持淨空 (`boxOpened = true`)。
   - 已實作 `engine.orderSandboxBatch(items: Array<{ shape: ShapeKey; colorIdx: number; qty: number }>)`，支援一次將多種形狀／顏色零件整批倒入目前選中的盤子或深籃。
   - `src/App.tsx` 已在沙盒模式顯示淨空提示與全部 11 種形狀按鈕。

4. **白兔眼睛遮擋修復**
   - `src/data/models.ts` 中 `BUNNY_L7` 的 `z=6` 前突白磚（`'.....0000.....'`）原本正對著 `z=5` 雙眼（`'....020020....'`）導致正面看不到眼睛，已清為 `'..............'` 讓黑眼睛完整露出。

---

## 四、建議本地 `agy` 接續實作的待辦項目

### 待辦 1：無盡自由模式進階訂購面板（`src/components/SandboxOrderPanel.tsx`）
目前 `src/App.tsx` 仍使用精簡內聯工具列（系統 `<input type="color">` + 單一色票按鈕），建議抽成獨立元件 `src/components/SandboxOrderPanel.tsx` 強化以下功能：
1. **標準積木色號直接輸入 + `#HEX` 輸入**：
   - 在 `src/data/models.ts` 匯出完整 `STANDARD_BRICK_COLORS` 對照表（例如 `01` 積木白、`05` 奶油白、`21` 消防紅、`23` 海洋藍、`24` 陽光黃、`26` 石墨黑、`28` 森野綠、`38` 陶土橘、`41` 透明玻璃、`43` 透藍玻璃、`106` 活力橘、`124` 薰衣紫、`140` 晴空藍、`141` 亮葉綠、`192` 木頭棕、`194` 金屬銀、`222` 櫻花粉、`226` 亮金黃、`283` 粉膚、`297` 耀眼金、`308` 深焙棕）。
   - 輸入數字色號（如 `297`、`21`）或 `#FF6B9E` 即時同步顏色與名稱標籤。
2. **可拖曳 2D 調色盤（Canvas SV 方塊 + Hue 色相條）**：
   - 使用 `<canvas>` 搭配 `setPointerCapture` 實作流暢的按住拖動微調（飽和度/明度平面 + 色相滑條），比原生系統 `<input type="color">` 更直覺且可在各平台保持一致外觀。
3. **訂購購物車清單**：
   - 支援選擇「形狀 × 顏色 × 材質 × 數量」後點「加入訂單」，最後點擊「一鍵打包下單」呼叫已經寫好的 `engine.orderSandboxBatch(cartItems)` 整批倒入盤中（同時保留「立即訂購倒入」單鍵快捷）。

### 待辦 2：依附圖延伸創作《日式豚骨拉麵餐盤組 (`ramen_set`)》
使用者已上傳拉麵積木參考圖於 **`public/assets/aistudio/image_3ac222db.png`**，需求明確指示：
- **不要與參考圖完全相同**，而是升級為「**大餐盤 + 主碗拉麵 + 右側小菜與茶杯**」。
- **餐盤底層請用大塊積木**：設定 `board: { w: 22, d: 14 }`、`largePlateLayers: [0]`，讓 `L0` 深核桃木餐盤自動拆解成 `4x4` 與 `2x4` 大板。
- 建議層數結構（約 10～12 層）：
  - `L0`（`largePlateLayers: [0]`）：`20×12` 深核桃木餐盤底座（自動使用 `4x4` / `2x4`）。
  - `L1–L5`：左側 (`x=1..10`) 米白搭朱紅紋陶瓷拉麵碗＋透琥珀玻璃高湯 (`finish: 'glass'`)；右側 (`x=13..18`) 白色小菜盤（金黃煎餃／唐揚雞搭配 `slope1x1` 造型＋嫩綠高麗菜絲點綴）與翡翠綠抹茶杯 (`glass`)。
  - `L6–L10`：叉燒肉片（可搭 `slope1x1` 斜切層次）、半熟溏心蛋、粉白魚板、蔥花、立體海苔片，以及懸空夾起的奶油色拉麵條＋深木色筷子（底部可加 1～2 顆微細透明支撐點確保物理與判定支撐）。
- **實作後務必跑模型自我檢驗腳本**，確認：
  1. 每一層字元寬度與行數完全等長；
  2. `specialBricks` 與 `masks` 座標零重疊；
  3. 非 `specialBricks` 樓層格點皆有下層支撐或屬於合理懸挑；
  4. `buildPlan(model)` 與 `assignSortedPouches` 無錯誤且總格數與盤面一致。

### 待辦 3：看圖自動產積木工作流強化
- 若希望讓使用者上傳圖片也能產出「多層立體作品」（目前 `MaskBuilderModal.tsx` 預設是將 2D 圖片轉為 2 層浮雕）：
  - 若採規則演算法：可依像素明度／中心距離推算 3～4 層浮雕高度（淺景深浮雕效果最佳）。
  - 若採 AI 輔助（見使用者原始問題「給一個圖形能否照著產出」）：文字／多視角圖片轉 `BrickModel` 的 `masks[]` JSON 需要由模型理解物件正交體素結構；需特別注意**正交格點限制**（例如斜向 45° 的筷子或斜角手臂，在純格點積木中須以階梯狀體素逼近，或加入透明底座支撐與斜坡磚 `slope1x1` / `slope1x2` 模擬斜邊）。

### 待辦 4：其餘長期優化（詳見 `docs/ROADMAP_AND_NOTES.md`）
- 依材質區分音效音色（`plastic` / `matte` / `metallic` / `glass`）。
- CrazyGames SDK 雲端存檔與插頁／激勵廣告接線。
- Capacitor 手機打包與原生物理震動接線。
