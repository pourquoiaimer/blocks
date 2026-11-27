import type { BrickModel, ColorDef, MaterialFinish, SpecialBrickSpec } from '../types/brick';

const SHARE_PREFIX = 'BW1:';

interface CompactSharePayload {
  v: 1;
  n: string;
  b: [number, number];
  p: Array<[string, number, 0 | 1] | [string, number, 0 | 1, MaterialFinish]>;
  m: string[][];
  sp?: SpecialBrickSpec[];
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function encodeModelShareCode(model: BrickModel): string {
  const payload: CompactSharePayload = {
    v: 1,
    n: model.name.trim().slice(0, 32) || '玩家分享作品',
    b: [model.board.w, model.board.d],
    p: model.palette.slice(0, 12).map(c =>
      c.finish && c.finish !== 'plastic'
        ? [c.name.slice(0, 12), c.hex & 0xffffff, c.transparent ? 1 : 0, c.finish]
        : [c.name.slice(0, 12), c.hex & 0xffffff, c.transparent ? 1 : 0]
    ),
    m: model.masks,
    ...(model.specialBricks && model.specialBricks.length > 0
      ? { sp: model.specialBricks }
      : {}),
  };
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return SHARE_PREFIX + bytesToBase64Url(bytes);
}

export function decodeModelShareCode(raw: string): BrickModel | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    let parsed: unknown;
    if (trimmed.startsWith(SHARE_PREFIX)) {
      const bytes = base64UrlToBytes(trimmed.slice(SHARE_PREFIX.length));
      const json = new TextDecoder().decode(bytes);
      parsed = JSON.parse(json);
    } else if (trimmed.startsWith('{')) {
      parsed = JSON.parse(trimmed);
    } else {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') return null;

    // 支援完整 BrickModel JSON 或精簡 BW1 payload
    const obj = parsed as Partial<CompactSharePayload & BrickModel>;
    if (obj.v === 1 && Array.isArray(obj.m) && Array.isArray(obj.p)) {
      if (obj.m.length === 0 || obj.m.length > 24) return null;
      const d = obj.m[0]?.length ?? 0;
      const w = obj.m[0]?.[0]?.length ?? 0;
      if (w <= 0 || d <= 0 || w > 28 || d > 24) return null;

      const bw = Math.max(w, Math.min(28, Number(obj.b?.[0]) || 16));
      const bd = Math.max(d, Math.min(24, Number(obj.b?.[1]) || 12));
      const palette: ColorDef[] = obj.p.map((entry, idx) => {
        const finishRaw = entry[3];
        const finish: MaterialFinish | undefined =
          finishRaw === 'matte' || finishRaw === 'metallic' || finishRaw === 'glass' || finishRaw === 'plastic'
            ? finishRaw
            : undefined;
        return {
          code: String(idx + 1).padStart(2, '0'),
          name: String(entry[0] || `色${idx + 1}`),
          hex: Number(entry[1]) & 0xffffff,
          finish,
          transparent: Boolean(entry[2]) || finish === 'glass',
          opacity: entry[2] || finish === 'glass' ? 0.54 : undefined,
        };
      });
      if (palette.length === 0) return null;

      const masks = obj.m.map(layer => layer.map(row => String(row)));
      const mid = Math.max(0, Math.floor(masks.length / 2) - 1);
      const packs =
        masks.length > 4
          ? [
              { label: '第 1 包（基礎層）', maxLayer: mid, trayIndex: 0 },
              { label: '第 2 包（上層造型）', maxLayer: masks.length - 1, trayIndex: 1 },
            ]
          : [{ label: '第 1 包（全套零件）', maxLayer: masks.length - 1, trayIndex: 0 }];

      return {
        id: 'share_' + Date.now().toString(36),
        name: String(obj.n || '玩家分享作品'),
        subtitle: '來自玩家分享碼的自創積木作品',
        difficulty: masks.length >= 7 ? '進階' : masks.length >= 4 ? '標準' : '入門',
        palette,
        board: { w: bw, d: bd },
        masks,
        specialBricks: Array.isArray(obj.sp) ? obj.sp : undefined,
        packs,
        isCustom: true,
      };
    }

    if (Array.isArray(obj.masks) && Array.isArray(obj.palette) && obj.board) {
      if (obj.masks.length === 0 || obj.palette.length === 0) return null;
      return {
        id: obj.id || 'share_' + Date.now().toString(36),
        name: obj.name || '玩家匯入作品',
        subtitle: obj.subtitle || '玩家自創分享圖紙',
        difficulty: obj.difficulty || '標準',
        palette: obj.palette,
        board: obj.board,
        masks: obj.masks,
        specialBricks: Array.isArray(obj.specialBricks) ? obj.specialBricks : undefined,
        standMount: obj.standMount,
        packs:
          Array.isArray(obj.packs) && obj.packs.length > 0
            ? obj.packs
            : [{ label: '第 1 包（全套零件）', maxLayer: obj.masks.length - 1, trayIndex: 0 }],
        isCustom: true,
      };
    }

    return null;
  } catch {
    return null;
  }
}
