/** Tiny synthesized game sounds (WebAudio, no audio assets).
 *  Found: bright two-note chime · Miss: low grave buzz · Finish: little fanfare arpeggio. */

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  if (ctx.state === 'suspended') void ctx.resume(); // created/resumed inside a user gesture (click)
  return ctx;
}

function tone(freq: number, at: number, dur: number, type: OscillatorType, gainPeak = 0.18, glideTo?: number) {
  const ac = audio(); if (!ac) return;
  const t0 = ac.currentTime + at;
  const osc = ac.createOscillator(); const gain = ac.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(gainPeak, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
}

/** ✅ Correct find: quick ascending major chime (E5 → B5). */
export function playFound() { tone(659.25, 0, 0.14, 'sine', 0.2); tone(987.77, 0.07, 0.22, 'sine', 0.2); }

/** ❌ Miss: low, grave descending buzz. */
export function playMiss() { tone(160, 0, 0.28, 'sawtooth', 0.12, 82); tone(110, 0, 0.28, 'triangle', 0.14, 73); }

/** 🎉 Level complete: synthesized fanfare (C-E-G-C arpeggio + sparkle). */
export function playFanfare() {
  const seq: [number, number][] = [[523.25, 0], [659.25, 0.11], [783.99, 0.22], [1046.5, 0.33]];
  for (const [f, at] of seq) { tone(f, at, 0.34, 'triangle', 0.2); tone(f / 2, at, 0.3, 'sine', 0.08); }
  tone(1318.5, 0.46, 0.4, 'sine', 0.16); tone(1567.98, 0.55, 0.5, 'sine', 0.12);
}
