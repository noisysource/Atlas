// Calling Atlas on WhatsApp (#304): a voice call to Atlas's WhatsApp number,
// answered by Gemini Live, which talks by itself and asks Atlas (ask_atlas,
// the page's /ask) for anything real.
//
// How a call goes:
// 1. Meta sends a "calls" webhook (event "connect") with the caller's WebRTC
//    offer. Only numbers in data/whatsapp.json are answered; others are
//    rejected.
// 2. Atlas answers the offer with its own WebRTC peer (werift), and sends the
//    answer to Meta with pre_accept, then accept.
// 3. Media: the caller's voice is Opus at 48 kHz. It's decoded, cut to 16 kHz,
//    and streamed to Gemini Live, which hears when a sentence ends by itself.
//    Gemini's voice (24 kHz) is raised to 48 kHz, encoded to Opus in 20 ms
//    frames, and sent back at that pace. When the caller talks over it, what's
//    queued is dropped.
// 4. Either side hangs up: the peer and the Live session close. A call ends
//    by itself after 10 minutes.
//
// Nothing said is logged: only the call's events and counts.

import OpusScript from "opusscript";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from "werift";
import type { Logger } from "../types.js";

export const CALL_RATE = 48_000;
const FRAME = 960; // 20 ms at 48 kHz
const MAX_CALL_MS = 10 * 60_000;
const ICE_WAIT_MS = 4_000;
/** At most this much of his voice is queued to be played (beyond it, the oldest goes). */
const MAX_QUEUE_FRAMES = 50 * 60;

// ── Audio: rates and frames ────────────────────────────────────────────────

/** 48 kHz → 16 kHz: the average of every three samples (a simple low-pass, enough for speech). */
export const down48to16 = (pcm: Int16Array): Int16Array => {
  const out = new Int16Array(Math.floor(pcm.length / 3));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(((pcm[i * 3] ?? 0) + (pcm[i * 3 + 1] ?? 0) + (pcm[i * 3 + 2] ?? 0)) / 3);
  return out;
};

/** 24 kHz → 48 kHz: each sample, then halfway to the next. */
export const up24to48 = (pcm: Int16Array): Int16Array => {
  const out = new Int16Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i] ?? 0;
    const b = pcm[i + 1] ?? a;
    out[i * 2] = a;
    out[i * 2 + 1] = Math.round((a + b) / 2);
  }
  return out;
};

/** Stereo, interleaved → mono. */
export const toMono = (pcm: Int16Array, channels: number): Int16Array => {
  if (channels <= 1) return pcm;
  const out = new Int16Array(Math.floor(pcm.length / channels));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[i * channels + c] ?? 0;
    out[i] = Math.round(sum / channels);
  }
  return out;
};

export const pcmOf = (b: Buffer): Int16Array => new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 2)));
export const bytesOf = (pcm: Int16Array): Buffer => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/** Cuts audio into whole 20 ms frames; what's left waits for more. */
export const makeFramer = (frame = FRAME) => {
  let rest = new Int16Array(0);
  return (pcm: Int16Array): Int16Array[] => {
    const all = new Int16Array(rest.length + pcm.length);
    all.set(rest);
    all.set(pcm, rest.length);
    const frames: Int16Array[] = [];
    let at = 0;
    for (; at + frame <= all.length; at += frame) frames.push(all.slice(at, at + frame));
    rest = all.slice(at);
    return frames;
  };
};

// ── The brain on the other end ─────────────────────────────────────────────

/** What answers the call: hears 16 kHz mono, plays 24 kHz mono. */
export type CallBrain = (hooks: { readonly play: (pcm24k: Int16Array) => void; readonly interrupted: () => void; readonly hangUp: () => void }) => Promise<{
  readonly hear: (pcm16k: Int16Array) => void;
  readonly close: () => void;
}>;

// ── One call ───────────────────────────────────────────────────────────────

export type CallLine = {
  /** Sends a Calls API action for this call (pre_accept, accept, terminate, reject). */
  readonly action: (action: "pre_accept" | "accept" | "terminate" | "reject", sdp?: string) => Promise<boolean>;
};

/** The negotiated Opus payload type and channels, from an SDP. */
export const opusOf = (sdp: string): { pt: number; channels: number } | undefined => {
  const m = /a=rtpmap:(\d+) opus\/48000(?:\/(\d))?/i.exec(sdp);
  return m ? { pt: Number(m[1]), channels: Number(m[2] ?? "1") } : undefined;
};

export const makeCall = async (deps: { readonly offer: string; readonly line: CallLine; readonly brain: CallBrain; readonly log?: Logger; readonly stunServer?: string }) => {
  const log = deps.log;
  const pc = new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: CALL_RATE, channels: 2 })] },
    iceServers: [{ urls: deps.stunServer ?? "stun:stun.l.google.com:19302" }],
  });
  const opus = new OpusScript(CALL_RATE, 1, OpusScript.Application.VOIP);
  const opusIn = new OpusScript(CALL_RATE, 2, OpusScript.Application.VOIP);
  const out = new MediaStreamTrack({ kind: "audio" });
  let closed = false;
  let queue: Int16Array[] = [];
  const framer = makeFramer();
  let seq = Math.floor(Math.random() * 65535);
  let ts = Math.floor(Math.random() * 2 ** 31);
  const timers: { pacer?: ReturnType<typeof setInterval>; timeout?: ReturnType<typeof setTimeout> } = {};
  let heard = 0;
  let played = 0;

  const end = async (why: string, tell = true) => {
    if (closed) return;
    closed = true;
    if (timers.pacer) clearInterval(timers.pacer);
    if (timers.timeout) clearTimeout(timers.timeout);
    brain?.close();
    if (tell) await deps.line.action("terminate").catch(() => false);
    await pc.close().catch(() => undefined);
    opus.delete();
    opusIn.delete();
    log?.info("whatsapp call ended", { why, heardFrames: heard, playedFrames: played });
  };

  let brain: Awaited<ReturnType<CallBrain>> | undefined;
  try {
    brain = await deps.brain({
      play: (pcm24k) => {
        for (const f of framer(up24to48(pcm24k))) queue.push(f);
        if (queue.length > MAX_QUEUE_FRAMES) queue = queue.slice(-MAX_QUEUE_FRAMES);
      },
      interrupted: () => {
        queue = [];
      },
      hangUp: () => void end("brain"),
    });
  } catch (e) {
    await deps.line.action("reject").catch(() => false);
    log?.warn("whatsapp call rejected", { why: "brain", reason: e instanceof Error ? e.message : "unknown" });
    return { end };
  }

  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      if (closed || rtp.payload.length === 0) return;
      try {
        const pcm = toMono(pcmOf(opusIn.decode(rtp.payload)), 2);
        heard += 1;
        brain?.hear(down48to16(pcm));
      } catch {
        // A packet Opus can't read (or DTX): skipped.
      }
    });
  });

  await pc.setRemoteDescription({ type: "offer", sdp: deps.offer });
  pc.addTrack(out);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  // The answer goes with every candidate in it (Meta doesn't trickle).
  const started = Date.now();
  while (pc.iceGatheringState !== "complete" && Date.now() - started < ICE_WAIT_MS) await new Promise((r) => setTimeout(r, 50));
  const sdp = pc.localDescription?.sdp ?? "";
  const pt = opusOf(sdp)?.pt ?? opusOf(deps.offer)?.pt ?? 111;

  if (!(await deps.line.action("pre_accept", sdp))) {
    await end("pre_accept refused", false);
    return { end };
  }
  if (!(await deps.line.action("accept", sdp))) {
    await end("accept refused", false);
    return { end };
  }
  log?.info("whatsapp call answered", { pt });

  // His voice, 20 ms at a time; silence (nothing sent) when there's nothing to say.
  timers.pacer = setInterval(() => {
    const frame = queue.shift();
    if (!frame || closed) return;
    try {
      const payload = opus.encode(bytesOf(frame), FRAME);
      seq = (seq + 1) & 0xffff;
      ts = (ts + FRAME) >>> 0;
      out.writeRtp(new RtpPacket(new RtpHeader({ payloadType: pt, sequenceNumber: seq, timestamp: ts, marker: false }), Buffer.from(payload)));
      played += 1;
    } catch {
      // One frame lost: the next goes on.
    }
  }, 20);
  timers.timeout = setTimeout(() => void end("too long"), MAX_CALL_MS);
  pc.connectionStateChange.subscribe((s) => {
    if (s === "failed" || s === "closed") void end(`connection ${s}`, s === "failed");
  });
  return { end };
};
