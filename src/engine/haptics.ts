export type HapticKind =
  | 'pick'
  | 'place'
  | 'snap'
  | 'snapGroup'
  | 'pluck'
  | 'rot'
  | 'rattle'
  | 'shake'
  | 'box'
  | 'undo'
  | 'complete';

let hapticsEnabled = true;
let lastRattleVibeMs = 0;

export function setHapticsEnabled(val: boolean): void {
  hapticsEnabled = val;
}

export function triggerHaptic(kind: HapticKind): void {
  if (!hapticsEnabled) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;

  try {
    if (kind === 'rattle') {
      const now = performance.now();
      if (now - lastRattleVibeMs < 95) return;
      lastRattleVibeMs = now;
      navigator.vibrate(4);
      return;
    }

    switch (kind) {
      case 'rot':
        navigator.vibrate(6);
        break;
      case 'pick':
      case 'undo':
        navigator.vibrate(9);
        break;
      case 'place':
        navigator.vibrate(11);
        break;
      case 'snap':
        navigator.vibrate(18);
        break;
      case 'snapGroup':
        navigator.vibrate([14, 22, 12]);
        break;
      case 'pluck':
        navigator.vibrate([10, 14, 18]);
        break;
      case 'shake':
        navigator.vibrate([10, 20, 10]);
        break;
      case 'box':
        navigator.vibrate([12, 24, 16]);
        break;
      case 'complete':
        navigator.vibrate([22, 36, 26, 36, 48]);
        break;
    }
  } catch {
    // Ignore vibration errors on unsupported browsers
  }
}
