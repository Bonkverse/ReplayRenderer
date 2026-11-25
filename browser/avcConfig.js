// Checks, and if needed repairs, the H.264 decoder configuration (an
// AVCDecoderConfigurationRecord, "avcC", ISO/IEC 14496-15 §5.3.3) that
// VideoEncoder gives in meta.decoderConfig.description. The MP4 muxer writes it
// into the file as is.
//
// Why: Firefox's WebCodecs H.264 encoder (seen in Firefox 159 on Linux) returns
// a malformed record. The SPS and PPS each start with a doubled NAL header byte
// ("67 67 64 0c ..." instead of "67 64 0c ..."), and the reserved bits are
// zero ("03 01" instead of "ff e1"). Desktop and iOS players fall back to the
// SPS/PPS that Firefox also puts inside the keyframe, so the video plays there.
// Android decoders (and so Discord on Android) set up from the avcC alone, read
// a nonsense profile and show a black screen with only the audio playing.
//
// The fix: if the record isn't valid, build a new one from the SPS and PPS
// inside the first keyframe. A valid record (Chrome's) is left untouched.

const NAL_SPS = 7;
const NAL_PPS = 8;
const HIGH_PROFILES = new Set([100, 110, 122, 144]);

const toBytes = (buf) =>
  buf instanceof Uint8Array
    ? buf
    : ArrayBuffer.isView(buf)
      ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      : new Uint8Array(buf);

/**
 * Parse an avcC record. Returns { lengthSize, sps: Uint8Array[], pps: Uint8Array[] }
 * or null if it is too short or its lengths don't add up.
 */
export function parseAvcC(record) {
  const b = toBytes(record);
  if (b.length < 7) return null;
  let p = 5;
  const lengthSize = (b[4] & 3) + 1;
  const read = (count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      if (p + 2 > b.length) return null;
      const len = (b[p] << 8) | b[p + 1];
      p += 2;
      if (len === 0 || p + len > b.length) return null;
      out.push(b.subarray(p, p + len));
      p += len;
    }
    return out;
  };
  const sps = read(b[p++] & 31);
  if (!sps || p >= b.length) return null;
  const pps = read(b[p++]);
  if (!pps) return null;
  return { lengthSize, sps, pps };
}

/**
 * True if the record is one a strict decoder will accept: version 1, reserved
 * bits set, and at least one SPS and PPS whose NAL types are right and whose
 * profile/compatibility/level bytes match the record's header.
 */
export function isValidAvcC(record) {
  const b = toBytes(record);
  if (b.length < 7 || b[0] !== 1) return false;
  if ((b[4] & 0xfc) !== 0xfc || (b[5] & 0xe0) !== 0xe0) return false;
  const parsed = parseAvcC(b);
  if (!parsed || !parsed.sps.length || !parsed.pps.length) return false;
  const sps = parsed.sps[0];
  return (
    parsed.sps.every((s) => (s[0] & 31) === NAL_SPS) &&
    parsed.pps.every((s) => (s[0] & 31) === NAL_PPS) &&
    sps.length >= 4 &&
    sps[1] === b[1] && // profile_idc
    sps[2] === b[2] && // constraint flags
    sps[3] === b[3] // level_idc
  );
}

/** Split a length-prefixed access unit into NAL units. Null if malformed. */
export function splitNalUnits(data, lengthSize = 4) {
  const b = toBytes(data);
  const out = [];
  let p = 0;
  while (p < b.length) {
    if (p + lengthSize > b.length) return null;
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = len * 256 + b[p + i];
    p += lengthSize;
    if (len === 0 || p + len > b.length) return null;
    out.push(b.subarray(p, p + len));
    p += len;
  }
  return out;
}

// Exp-Golomb reader over an SPS's RBSP (emulation-prevention bytes removed).
function bitReader(nal) {
  const rbsp = [];
  for (let i = 1, zeros = 0; i < nal.length; i++) {
    if (zeros >= 2 && nal[i] === 3) {
      zeros = 0;
      continue;
    }
    rbsp.push(nal[i]);
    zeros = nal[i] === 0 ? zeros + 1 : 0;
  }
  let bit = 0;
  const u = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) {
      if (bit >> 3 >= rbsp.length) throw new Error("SPS ended early");
      v = (v << 1) | ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return v;
  };
  const ue = () => {
    let zeros = 0;
    while (u(1) === 0) if (++zeros > 31) throw new Error("bad Exp-Golomb code");
    return zeros ? (1 << zeros) - 1 + u(zeros) : 0;
  };
  return { u, ue };
}

/** For High profiles: chroma format and bit depths, which avcC repeats. */
function highProfileInfo(sps) {
  const r = bitReader(sps);
  r.u(24); // profile_idc, constraint flags, level_idc
  r.ue(); // seq_parameter_set_id
  const chromaFormat = r.ue();
  if (chromaFormat === 3) r.u(1); // separate_colour_plane_flag
  return { chromaFormat, lumaBits: r.ue() + 8, chromaBits: r.ue() + 8 };
}

/** Build an avcC record from SPS and PPS NAL units. */
export function buildAvcC(spsList, ppsList, lengthSize = 4) {
  const sps = spsList[0];
  const parts = [1, sps[1], sps[2], sps[3], 0xfc | (lengthSize - 1), 0xe0 | spsList.length];
  const push = (nal) => parts.push(nal.length >> 8, nal.length & 0xff, ...nal);
  spsList.forEach(push);
  parts.push(ppsList.length);
  ppsList.forEach(push);
  if (HIGH_PROFILES.has(sps[1])) {
    const { chromaFormat, lumaBits, chromaBits } = highProfileInfo(sps);
    parts.push(0xfc | chromaFormat, 0xf8 | (lumaBits - 8), 0xf8 | (chromaBits - 8), 0);
  }
  return new Uint8Array(parts);
}

/**
 * The avcC to give the muxer: `description` if it is valid, otherwise one
 * rebuilt from the SPS/PPS in `keyframe` (the first keyframe's bytes). Returns
 * null when there's nothing to rebuild from, so the caller keeps the original.
 */
export function repairAvcC(description, keyframe) {
  if (description && isValidAvcC(description)) return toBytes(description);
  const lengthSize = description && toBytes(description).length > 4 ? (toBytes(description)[4] & 3) + 1 : 4;
  const nals = keyframe && splitNalUnits(keyframe, lengthSize);
  if (!nals) return null;
  const sps = nals.filter((n) => (n[0] & 31) === NAL_SPS);
  const pps = nals.filter((n) => (n[0] & 31) === NAL_PPS);
  if (!sps.length || !pps.length || sps[0].length < 4) return null;
  try {
    const rebuilt = buildAvcC(sps, pps, lengthSize);
    return isValidAvcC(rebuilt) ? rebuilt : null;
  } catch {
    return null;
  }
}
