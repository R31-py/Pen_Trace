/* ==========================================================================
   tracker-worker.js — Phase 3: Pencil / Marker Tracking (MVP: colored marker)

   Receives raw RGBA pixel buffers from the main thread (already downscaled
   to ~320x240 by camera.js) and an HSV target range, and returns the
   centroid of matching pixels plus a confidence score.

   Deliberately NOT using OpenCV.js here: for a single-color blob centroid,
   a hand-rolled HSV scan is a few hundred lines lighter, has zero external
   dependency / no multi-MB wasm to fetch for a PWA that must work offline,
   and is easily fast enough at 320x240. The architecture (postMessage in,
   {x,y,confidence} out) is intentionally the same shape a future
   contour/ML-based worker would use, so swapping the detector later
   (Section 6: "architecture should remain extensible") doesn't touch
   marker.js or anything downstream.
   ========================================================================== */

/* eslint-disable no-restricted-globals */

let target = { h: 340, s: 70, v: 70 }; // degrees 0-360, percent 0-100
let tolerance = { h: 18, s: 35, v: 35 };
let minPixels = 12;      // below this, treat as "not detected"
let maxPixels = 6000;    // above this, probably lighting/skin false-positive

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return [h, s * 100, v * 100];
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function process(buffer, width, height) {
  const data = new Uint8ClampedArray(buffer);
  let sumX = 0, sumY = 0, count = 0;
  let minX = width, maxX = 0, minY = height, maxY = 0;

  // Stride sampling: checking every pixel at 320x240 is fine, but every
  // other pixel roughly halves cost with negligible accuracy loss for a
  // centroid calculation.
  const stride = 2;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [h, s, v] = rgbToHsv(r, g, b);

      if (
        hueDist(h, target.h) <= tolerance.h &&
        Math.abs(s - target.s) <= tolerance.s &&
        Math.abs(v - target.v) <= tolerance.v
      ) {
        sumX += x; sumY += y; count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Adjust for stride sampling
  const effectiveCount = count * (stride * stride);

  if (count === 0 || effectiveCount < minPixels) {
    return { detected: false, confidence: 0 };
  }

  const cx = sumX / count;
  const cy = sumY / count;

  const boxW = Math.max(1, maxX - minX);
  const boxH = Math.max(1, maxY - minY);
  const boxArea = boxW * boxH;
  // density = how "blob-like" (vs scattered false positives) the match is
  const density = Math.min(1, (count) / (boxArea / (stride * stride) + 1));

  let sizeScore;
  if (effectiveCount > maxPixels) {
    sizeScore = Math.max(0, 1 - (effectiveCount - maxPixels) / maxPixels);
  } else {
    sizeScore = Math.min(1, effectiveCount / (minPixels * 4));
  }

  const confidence = Math.max(0, Math.min(1, 0.5 * density + 0.5 * sizeScore));

  return {
    detected: confidence > 0.15,
    x: cx,
    y: cy,
    confidence,
    pixelCount: effectiveCount,
  };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'config') {
    if (msg.target) target = msg.target;
    if (msg.tolerance) tolerance = msg.tolerance;
    if (msg.minPixels != null) minPixels = msg.minPixels;
    if (msg.maxPixels != null) maxPixels = msg.maxPixels;
    return;
  }
  if (msg.type === 'frame') {
    const result = process(msg.buffer, msg.width, msg.height);
    self.postMessage({ type: 'result', frameId: msg.frameId, ...result });
  }
  if (msg.type === 'sample') {
    // Used during marker color calibration: caller sends a small patch of
    // pixels around the user's tap and we return the average HSV so
    // marker.js can set it as the new target.
    const data = new Uint8ClampedArray(msg.buffer);
    let h = 0, s = 0, v = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [hh, ss, vv] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      h += hh; s += ss; v += vv; n++;
    }
    self.postMessage({
      type: 'sample-result',
      h: n ? h / n : 0,
      s: n ? s / n : 0,
      v: n ? v / n : 0,
    });
  }
};
