// Sound for the MP4 export.
//
// The live player plays sounds through bonk.io's SoundHandler, which starts a
// Howl the moment the renderer calls `game.soundManager.playSound(...)`. The
// export renders much faster than real time, so playing them would be useless.
// Instead, during the export we:
//
//   1. swap in a recorder for `game.soundManager` around each render call. It
//      applies the same rules as bonk's SoundHandler (dedupe per step, at most
//      10 of one sound playing at once, a volume budget per render) and notes
//      each sound with its time in the video;
//   2. mix those sounds offline (OfflineAudioContext) from the game's own
//      sound files (GameResources.soundStrings), with the same volume and
//      stereo position Howler would use;
//   3. encode the mix with WebCodecs (AAC if the browser can, else Opus) and
//      hand the chunks to the MP4 muxer.

export const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const AUDIO_BITRATE = 128_000;

// The same limits as bonk.io's SoundHandler.
const MAX_PLAYING_PER_TYPE = 10;
const MAX_VOLUME_PER_RENDER = 15;
const PENDING_STEP_SOUNDS = 5;
// Played on one shared Howl each in bonk's handler, so they skip the limits.
const SINGLETON_SOUNDS = new Set(["capIncrease", "capDecrease"]);

// Muxer codec name + WebCodecs codec string, in order of preference. AAC plays
// everywhere; Chrome on Linux can't encode it, so Opus is the fallback.
const CODECS = [
  { muxer: "aac", codec: "mp4a.40.2" },
  { muxer: "opus", codec: "opus" },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Pick an audio codec and decode every game sound. Returns null when the
 * browser can't encode audio, so the caller exports video only, as before.
 */
export async function prepareExportAudio() {
  if (typeof AudioEncoder === "undefined" || typeof OfflineAudioContext === "undefined") return null;

  let codec = null;
  for (const c of CODECS) {
    const config = { codec: c.codec, sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate: AUDIO_BITRATE };
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) {
        codec = { muxer: c.muxer, config };
        break;
      }
    } catch {}
  }
  if (!codec) return null;

  // GameResources.js declares `class GameResources` in a classic script: that
  // is a global binding but not a property of globalThis, so use the bare name
  // (as bonk's own code does).
  // eslint-disable-next-line no-undef
  const strings = (typeof GameResources !== "undefined" && GameResources.soundStrings) || {};
  const decoder = new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE);
  const buffers = new Map();
  await Promise.all(
    Object.entries(strings).map(async ([type, uri]) => {
      if (typeof uri !== "string" || !uri) return;
      try {
        const bytes = await (await fetch(uri)).arrayBuffer();
        buffers.set(type, await decoder.decodeAudioData(bytes));
      } catch (err) {
        console.warn(`export audio: couldn't decode sound "${type}"`, err);
      }
    })
  );
  return { codec, buffers };
}

/**
 * A stand-in for bonk's SoundHandler that records instead of playing.
 * `now()` gives the current time in the video, in seconds.
 */
export function createSoundRecorder({ now, buffers }) {
  const events = [];
  const sounds = {}; // type -> { ends: number[], sumVolThisStep }
  const pending = []; // recent { i: type, f: step }, for the per-step dedupe

  return {
    events,
    playSound(type, stereoPosition, volume, step) {
      const t = now();
      const s = (sounds[type] ??= { ends: [], sumVolThisStep: 0 });
      s.ends = s.ends.filter((end) => end > t); // sounds that have finished
      if (s.ends.length >= MAX_PLAYING_PER_TYPE) return;
      if (s.sumVolThisStep >= MAX_VOLUME_PER_RENDER) return;
      if (step != undefined && pending.some((p) => p.f === step && p.i === type)) return;

      const vol = Number(volume);
      const pan = Number(stereoPosition);
      events.push({
        type,
        t,
        volume: Number.isFinite(vol) && vol > 0 ? vol : 0,
        pan: Number.isFinite(pan) ? clamp(pan, -1, 1) : 0,
      });
      if (SINGLETON_SOUNDS.has(type)) return;

      s.ends.push(t + (buffers.get(type)?.duration ?? 0));
      s.sumVolThisStep += vol || 0;
      pending.push({ i: type, f: step });
      if (pending.length > PENDING_STEP_SOUNDS) pending.shift();
    },
    resetSumVols() {
      for (const type in sounds) sounds[type].sumVolThisStep = 0;
    },
  };
}

/** Mix the recorded sounds into a stereo AudioBuffer `seconds` long. */
export async function mixSounds(events, buffers, seconds) {
  const length = Math.max(1, Math.ceil(seconds * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(CHANNELS, length, SAMPLE_RATE);
  for (const ev of events) {
    const buffer = buffers.get(ev.type);
    if (!buffer || !(ev.volume > 0) || ev.t >= seconds) continue;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = ev.volume; // Howler sets the gain to the Howl's volume
    const panner = ctx.createStereoPanner();
    panner.pan.value = ev.pan; // Howl.stereo() uses a StereoPannerNode too
    src.connect(gain).connect(panner).connect(ctx.destination);
    src.start(Math.max(0, ev.t));
  }
  const mix = await ctx.startRendering();

  // Many overlapping sounds can sum past full scale. Scale the whole mix down
  // instead of letting the encoder clip it.
  let peak = 0;
  for (let c = 0; c < CHANNELS; c++) {
    for (const v of mix.getChannelData(c)) if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  if (peak > 1) {
    const k = 0.98 / peak;
    for (let c = 0; c < CHANNELS; c++) {
      const data = mix.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] *= k;
    }
  }
  return mix;
}

/** Silence, for when mixing fails after the muxer already has an audio track. */
export function silence(seconds) {
  const length = Math.max(1, Math.ceil(seconds * SAMPLE_RATE));
  return new AudioBuffer({ length, numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE });
}

/** Encode an AudioBuffer and pass each chunk to `onChunk(chunk, meta)`. */
export async function encodeAudio(buffer, codec, onChunk) {
  let failure = null;
  const encoder = new AudioEncoder({
    output: onChunk,
    error: (err) => (failure = err),
  });
  encoder.configure(codec.config);

  const FRAMES = 4_800; // 100 ms per AudioData
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let off = 0; off < buffer.length; off += FRAMES) {
    const n = Math.min(FRAMES, buffer.length - off);
    const data = new Float32Array(n * CHANNELS); // planar: all left, then all right
    data.set(left.subarray(off, off + n), 0);
    data.set(right.subarray(off, off + n), n);
    const audio = new AudioData({
      format: "f32-planar",
      sampleRate: SAMPLE_RATE,
      numberOfFrames: n,
      numberOfChannels: CHANNELS,
      timestamp: Math.round((off / SAMPLE_RATE) * 1e6),
      data,
    });
    encoder.encode(audio);
    audio.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
}
