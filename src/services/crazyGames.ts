interface CrazyGamesSdk {
  init?: () => Promise<void>;
  game?: {
    gameplayStart?: () => void;
    gameplayStop?: () => void;
    happytime?: () => void;
    loadingStart?: () => void;
    loadingStop?: () => void;
  };
  data?: {
    getItem?: (key: string) => string | null;
    setItem?: (key: string, value: string) => void;
  };
}

declare global {
  interface Window {
    CrazyGames?: {
      SDK?: CrazyGamesSdk;
    };
  }
}

let initialized = false;

export async function initCrazyGames(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const sdk = window.CrazyGames?.SDK;
    if (sdk?.init) {
      await sdk.init();
    }
    sdk?.game?.loadingStop?.();
  } catch {
    // Safe fallback when running standalone / itch.io / local dev
  }
}

export function cgGameplayStart(): void {
  try {
    window.CrazyGames?.SDK?.game?.gameplayStart?.();
  } catch {
    // noop
  }
}

export function cgGameplayStop(): void {
  try {
    window.CrazyGames?.SDK?.game?.gameplayStop?.();
  } catch {
    // noop
  }
}

export function cgHappytime(): void {
  try {
    window.CrazyGames?.SDK?.game?.happytime?.();
  } catch {
    // noop
  }
}
