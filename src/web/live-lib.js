// @ts-check
// Gemini Live on the page (#250), the parts that don't touch the page: PCM
// and base64.

export const LIVE_RATE = 24_000;

/** base64 16-bit little-endian PCM → samples in [-1, 1]. @param {string} b64 */
export const pcmFromBase64 = (b64) => {
  const bin = atob(b64);
  const n = Math.floor(bin.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 0x8000;
  }
  return out;
};

/** bytes → base64, in pieces (big arrays overflow String.fromCharCode). @param {Uint8Array} bytes */
export const base64Of = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

