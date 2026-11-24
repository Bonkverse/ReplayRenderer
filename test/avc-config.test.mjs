// The H.264 decoder config check/repair (browser/avcConfig.js). The bytes below
// are real: Firefox 159's and Chrome 159's avcC for the same replay export,
// and the start of Firefox's first keyframe.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isValidAvcC, parseAvcC, repairAvcC, splitNalUnits } from "../browser/avcConfig.js";

const hex = (s) => Uint8Array.from(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));

// Firefox: doubled NAL header bytes ("67 67", "68 68"), reserved bits zero.
const FIREFOX_AVCC = hex(
  "01 64 0c 1f 03 01 00 11 67 67 64 0c 1f ac 18 d0 17 02 0f 24 f0 0f 08 84 6a 01 00 05 68 68 ee 3c 80"
);
// Chrome: a correct record, High profile with the chroma/bit-depth extension.
const CHROME_AVCC = hex(
  "01 64 0c 2a ff e1 00 14 67 64 0c 2a ac 18 d0 0b 80 ff cf 2c dc 04 34 04 1e 11 08 d4 01 00 04 68 ce 3c 80 fd f8 f8 00"
);
// Firefox keyframe: 4-byte lengths, then SPS, PPS and (the start of) an IDR slice.
const SPS = hex("67 64 0c 1f ac 18 d0 17 02 0f 24 f0 0f 08 84 6a");
const PPS = hex("68 ee 3c 80");
const IDR = hex("65 88 84 00 33 ff");
const withLength = (nal) => [0, 0, 0, nal.length, ...nal];
const FIREFOX_KEYFRAME = Uint8Array.from([...withLength(SPS), ...withLength(PPS), ...withLength(IDR)]);

describe("H.264 decoder config (avcC)", () => {
  test("Chrome's record is valid and kept byte for byte", () => {
    assert.equal(isValidAvcC(CHROME_AVCC), true);
    assert.deepEqual(repairAvcC(CHROME_AVCC, FIREFOX_KEYFRAME), CHROME_AVCC);
  });

  test("Firefox's record is detected as malformed", () => {
    assert.equal(isValidAvcC(FIREFOX_AVCC), false);
  });

  test("Firefox's record is rebuilt from the keyframe's SPS and PPS", () => {
    const fixed = repairAvcC(FIREFOX_AVCC, FIREFOX_KEYFRAME);
    assert.equal(isValidAvcC(fixed), true);
    assert.deepEqual([...fixed.subarray(0, 6)], [0x01, 0x64, 0x0c, 0x1f, 0xff, 0xe1]);
    const parsed = parseAvcC(fixed);
    assert.equal(parsed.lengthSize, 4);
    assert.deepEqual(parsed.sps, [SPS]);
    assert.deepEqual(parsed.pps, [PPS]);
    // High profile: 4:2:0, 8-bit luma and chroma, no SPS extensions
    assert.deepEqual([...fixed.subarray(-4)], [0xfd, 0xf8, 0xf8, 0x00]);
  });

  test("gives up (null) when the keyframe has no SPS/PPS to rebuild from", () => {
    assert.equal(repairAvcC(FIREFOX_AVCC, Uint8Array.from(withLength(IDR))), null);
    assert.equal(repairAvcC(FIREFOX_AVCC, hex("00 00 00 09 65")), null); // length runs past the end
  });

  test("splits length-prefixed NAL units", () => {
    assert.deepEqual(splitNalUnits(FIREFOX_KEYFRAME).map((n) => n[0] & 31), [7, 8, 5]);
  });
});
