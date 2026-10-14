// 사진 디코딩 / 크기 제한 / JPEG 내보내기.
// iOS Safari: 캔버스 면적 한도(약 16.7MP)를 넘으면 실패하거나 하얗게 나온다 → 항상 긴 변 기준으로 축소해서 디코딩.
import { Renderer, CanvasTooLargeError } from './renderer.js';

export const IOS_MAX_PIXELS = 4096 * 4096; // 16,777,216
export const JPEG_QUALITY = 0.92;

export const MAX_RES_OPTIONS = [
  { id: '4', label: '4MP (빠름)', pixels: 4_000_000 },
  { id: '12', label: '12MP (기본)', pixels: 12_000_000 },
  { id: 'max', label: '최대 (약 16MP)', pixels: IOS_MAX_PIXELS },
];

export function maxPixelsFor(id) {
  return (MAX_RES_OPTIONS.find((o) => o.id === id) || MAX_RES_OPTIONS[1]).pixels;
}

export class DecodeError extends Error {}

export function fitSize(w, h, maxPixels, maxSide) {
  let s = 1;
  if (w * h > maxPixels) s = Math.sqrt(maxPixels / (w * h));
  s = Math.min(s, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)) };
}

function isHeic(file) {
  return /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '');
}

// 크기만 알아내기용 (Safari 는 naturalWidth 에 EXIF 회전이 반영됨)
function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new DecodeError(isHeic(file)
        ? 'HEIC 사진을 열 수 없습니다. 이 브라우저가 HEIC 를 지원하지 않습니다 (아이폰 사파리에서는 열립니다). 설정 > 카메라 > 포맷 > "높은 호환성" 으로 찍은 JPEG 를 쓰거나, 사진 앱에서 공유해 JPEG 로 변환해 주세요.'
        : `사진을 열 수 없습니다: ${file.name || '알 수 없는 파일'}`));
    };
    img.src = url;
  });
}

/**
 * 파일을 maxPixels / maxSide 이하로 축소해 디코딩한다 (EXIF 회전 반영).
 * @returns {Promise<{source: ImageBitmap|HTMLCanvasElement, width: number, height: number, origWidth: number, origHeight: number}>}
 */
export async function decodeImage(file, { maxPixels, maxSide }) {
  const { img, url } = await loadImageElement(file);
  try {
    const origWidth = img.naturalWidth;
    const origHeight = img.naturalHeight;
    const { w, h } = fitSize(origWidth, origHeight, maxPixels, maxSide);
    let source = null;
    try {
      source = await createImageBitmap(file, {
        imageOrientation: 'from-image', resizeWidth: w, resizeHeight: h, resizeQuality: 'high',
      });
      if (source.width * source.height > maxPixels * 1.01 || Math.max(source.width, source.height) > maxSide) {
        source.close();
        source = null;
      }
    } catch {
      source = null; // 옵션 미지원 등 → 캔버스로 대체
    }
    if (!source) {
      source = document.createElement('canvas');
      source.width = w;
      source.height = h;
      const ctx = source.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
    }
    return { source, width: source.width, height: source.height, origWidth, origHeight };
  } finally {
    URL.revokeObjectURL(url);
    img.src = '';
  }
}

export function releaseSource(source) {
  if (!source) return;
  if (typeof source.close === 'function') source.close();
  else if (source instanceof HTMLCanvasElement) source.width = source.height = 0;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG 인코딩 실패'))), 'image/jpeg', JPEG_QUALITY);
  });
}

/** 풀해상도 처리 → JPEG Blob. 한 장 처리 후 모든 GPU/비트맵 메모리를 해제한다. */
export async function exportJpeg(file, values, { maxPixels, p3 = true }) {
  let pixels = Math.min(maxPixels, IOS_MAX_PIXELS);
  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = document.createElement('canvas');
    const r = new Renderer(canvas, { preserveDrawingBuffer: true, p3 });
    try {
      const dec = await decodeImage(file, { maxPixels: pixels, maxSide: r.maxSide });
      try {
        r.setSource(dec.source);
      } finally {
        releaseSource(dec.source); // 텍스처에 올라갔으니 바로 해제
      }
      r.render(values);
      return { blob: await canvasToBlob(canvas), width: r.width, height: r.height };
    } catch (e) {
      if (!(e instanceof CanvasTooLargeError)) throw e;
      pixels = Math.floor(pixels * 0.6); // 기기가 버퍼를 못 잡으면 줄여서 재시도
    } finally {
      r.dispose();
      canvas.width = canvas.height = 0;
    }
  }
  throw new Error('이 기기에서 처리할 수 있는 크기를 찾지 못했습니다');
}

export function exportName(file) {
  const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
  return `${base}_edit.jpg`;
}
