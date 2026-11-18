// How loud Atlas's voice is right now, for the star to pulse with it (like
// Jarvis). Everything Atlas says goes through one output per AudioContext
// (`voiceOut`), with an analyser on it; `voiceLevel` reads that analyser.

/** @type {WeakMap<BaseAudioContext, { out: AudioNode, analyser: AnalyserNode, data: Uint8Array<ArrayBuffer> }>} */
const taps = new WeakMap();

/** @param {BaseAudioContext} ctx */
const tapOf = (ctx) => {
  let tap = taps.get(ctx);
  if (!tap) {
    const out = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    out.connect(analyser);
    out.connect(ctx.destination);
    tap = { out, analyser, data: new Uint8Array(new ArrayBuffer(analyser.fftSize)) };
    taps.set(ctx, tap);
  }
  return tap;
};

/** Where Atlas's voice is played: connect sources here instead of `ctx.destination`. @param {BaseAudioContext} ctx */
export const voiceOut = (ctx) => tapOf(ctx).out;

/**
 * The loudness of a block of samples (bytes centred on 128), 0 to 1.
 * Speech sits around 0.05–0.3 RMS; this stretches it to fill the range.
 * @param {ArrayLike<number>} bytes
 */
export const levelOf = (bytes) => {
  if (bytes.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = ((bytes[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / bytes.length) * 3.2);
};

/** Atlas's voice right now, 0 (silent) to 1. @param {BaseAudioContext | undefined} ctx */
export const voiceLevel = (ctx) => {
  const tap = ctx && taps.get(ctx);
  if (!tap) return 0;
  tap.analyser.getByteTimeDomainData(tap.data);
  return levelOf(tap.data);
};
