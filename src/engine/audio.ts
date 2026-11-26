let audioCtx: AudioContext | null = null;
let enabled = true;
let noiseBuffer: AudioBuffer | null = null;

export function setAudioEnabled(val: boolean): void {
  enabled = val;
}

export type SoundKind =
  | 'snap'
  | 'pick'
  | 'rot'
  | 'place'
  | 'pluck'
  | 'complete'
  | 'pour'
  | 'shake'
  | 'box'
  | 'rattle';

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) {
    return noiseBuffer;
  }
  const len = Math.floor(ctx.sampleRate * 0.08);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.35));
  }
  noiseBuffer = buf;
  return buf;
}

export function playClick(type: SoundKind = 'snap'): void {
  if (!enabled) return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioCtx) audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    const now = audioCtx.currentTime;

    if (type === 'complete') {
      // 明亮愉悅的完成慶祝號角和弦 + 三連發小煙火綻放音效
      const notes = [523.25, 659.25, 783.99, 987.77, 1046.5];
      notes.forEach((freq, idx) => {
        if (!audioCtx) return;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        const t = now + idx * 0.08;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.001, t);
        gain.gain.linearRampToValueAtTime(0.14, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.3);
      });

      const burstTimes = [0.18, 0.48, 0.8];
      burstTimes.forEach((delay, bIdx) => {
        if (!audioCtx) return;
        const bt = now + delay;
        const src = audioCtx.createBufferSource();
        src.buffer = getNoiseBuffer(audioCtx);
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1600 + bIdx * 550, bt);
        filter.Q.setValueAtTime(1.8, bt);
        const nGain = audioCtx.createGain();
        nGain.gain.setValueAtTime(0.001, bt);
        nGain.gain.linearRampToValueAtTime(0.14, bt + 0.008);
        nGain.gain.exponentialRampToValueAtTime(0.001, bt + 0.14);
        src.connect(filter);
        filter.connect(nGain);
        nGain.connect(audioCtx.destination);
        src.start(bt);
        src.stop(bt + 0.16);

        const chime = audioCtx.createOscillator();
        const cGain = audioCtx.createGain();
        chime.type = 'sine';
        chime.frequency.setValueAtTime(1174.66 + bIdx * 196, bt);
        chime.frequency.exponentialRampToValueAtTime(1567.98 + bIdx * 220, bt + 0.12);
        cGain.gain.setValueAtTime(0.06, bt);
        cGain.gain.exponentialRampToValueAtTime(0.001, bt + 0.16);
        chime.connect(cGain);
        cGain.connect(audioCtx.destination);
        chime.start(bt);
        chime.stop(bt + 0.18);
      });
      return;
    }

    if (type === 'rattle' || type === 'pour') {
      // 清脆真實的 ABS 塑膠碰撞摩擦聲（短促帶通濾波噪聲 + 輕敲音）
      const src = audioCtx.createBufferSource();
      src.buffer = getNoiseBuffer(audioCtx);
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(type === 'rattle' ? 2200 + Math.random() * 1400 : 1800 + Math.random() * 900, now);
      filter.Q.setValueAtTime(3.2, now);
      const nGain = audioCtx.createGain();
      nGain.gain.setValueAtTime(type === 'rattle' ? 0.065 : 0.055, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.042);
      src.connect(filter);
      filter.connect(nGain);
      nGain.connect(audioCtx.destination);
      src.start(now);
      src.stop(now + 0.045);

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      const freq = 620 + Math.random() * 480;
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.52, now + 0.025);
      gain.gain.setValueAtTime(0.032, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.028);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.03);
      return;
    }

    if (type === 'snap') {
      // 雙層塑膠咬合喀嗒聲：高頻瞬間卡榫 + 中低頻壓實共鳴
      const src = audioCtx.createBufferSource();
      src.buffer = getNoiseBuffer(audioCtx);
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.setValueAtTime(1600, now);
      const nGain = audioCtx.createGain();
      nGain.gain.setValueAtTime(0.11, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.026);
      src.connect(filter);
      filter.connect(nGain);
      nGain.connect(audioCtx.destination);
      src.start(now);
      src.stop(now + 0.03);

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(560, now);
      osc.frequency.exponentialRampToValueAtTime(135, now + 0.052);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.058);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.06);
      return;
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';

    if (type === 'place') {
      osc.frequency.setValueAtTime(340, now);
      osc.frequency.exponentialRampToValueAtTime(190, now + 0.045);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    } else if (type === 'pick') {
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(420, now + 0.04);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    } else if (type === 'pluck') {
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(210, now + 0.06);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
    } else if (type === 'shake') {
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(310, now + 0.07);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
    } else if (type === 'box') {
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(390, now + 0.14);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.17);
      return;
    } else {
      osc.frequency.setValueAtTime(340, now);
      osc.frequency.exponentialRampToValueAtTime(280, now + 0.035);
      gain.gain.setValueAtTime(0.07, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    }

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  } catch {
    // Ignore audio errors
  }
}
