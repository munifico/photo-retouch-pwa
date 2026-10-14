import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { embedIccProfile } from '../imageio.js';

// PIL 로 만든 JFIF JPEG (프로필 없음)
const plain = readFileSync(new URL('./fixtures/plain.jpg', import.meta.url));

const segments = (buf) => {
  const out = [];
  let pos = 2;
  while (buf[pos] === 0xff && buf[pos + 1] !== 0xda) {
    const len = (buf[pos + 2] << 8) | buf[pos + 3];
    out.push({ marker: buf[pos + 1], sig: String.fromCharCode(...buf.subarray(pos + 4, pos + 16)) });
    pos += 2 + len;
  }
  return out;
};

test('ICC 프로필(APP2)을 JFIF 뒤에 넣는다', async () => {
  const out = new Uint8Array(await (await embedIccProfile(new Blob([plain]))).arrayBuffer());
  const segs = segments(out);
  assert.equal(segs[0].marker, 0xe0); // JFIF 가 맨 앞 유지
  assert.equal(segs[1].marker, 0xe2);
  assert.equal(segs[1].sig, 'ICC_PROFILE\0');
  assert.equal(out.length, plain.length + 2 + 2 + 12 + 2 + 536);
});

test('이미 ICC 가 있으면 그대로', async () => {
  const once = await embedIccProfile(new Blob([plain]));
  const twice = await embedIccProfile(once);
  assert.equal(twice, once);
});

test('JPEG 가 아니면 그대로', async () => {
  const b = new Blob([new Uint8Array([1, 2, 3])]);
  assert.equal(await embedIccProfile(b), b);
});
