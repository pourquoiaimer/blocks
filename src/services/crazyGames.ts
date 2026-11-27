interface CrazyGamesAdCallbacks {
  adStarted?: () => void;
  adFinished?: () => void;
  adError?: (err: unknown) => void;
}

interface CrazyGamesSdk {
  init?: () => Promise<void>;
  game?: {
    gameplayStart?: () => void;
    gameplayStop?: () => void;
    happytime?: () => void;
    loadingStart?: () => void;
    loadingStop?: () => void;
  };
  ad?: {
    requestAd?: (adType: 'midgame' | 'rewarded', callbacks?: CrazyGamesAdCallbacks) => void;
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

export function isCrazyGamesEnv(): boolean {
  try {
    return Boolean(window.CrazyGames?.SDK);
  } catch {
    return false;
  }
}

export async function initCrazyGames(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const sdk = window.CrazyGames?.SDK;
    sdk?.game?.loadingStart?.();
    if (sdk?.init) {
      await sdk.init();
    }
    sdk?.game?.loadingStop?.();
  } catch {
    // Safe fallback when running standalone / GitHub Pages / local dev
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

export function cgRequestAd(
  adType: 'midgame' | 'rewarded',
  callbacks?: {
    onPauseAudio?: () => void;
    onResumeAudio?: () => void;
    onRewardOrDone?: () => void;
  }
): void {
  try {
    const req = window.CrazyGames?.SDK?.ad?.requestAd;
    if (!req) {
      callbacks?.onRewardOrDone?.();
      return;
    }
    req(adType, {
      adStarted: () => callbacks?.onPauseAudio?.(),
      adFinished: () => {
        callbacks?.onResumeAudio?.();
        callbacks?.onRewardOrDone?.();
      },
      adError: () => {
        callbacks?.onResumeAudio?.();
        callbacks?.onRewardOrDone?.();
      },
    });
  } catch {
    callbacks?.onResumeAudio?.();
    callbacks?.onRewardOrDone?.();
  }
}
