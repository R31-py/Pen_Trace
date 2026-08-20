/* ==========================================================================
   reference.js — Phase 9: Reference Image

   Pipeline:
     source image (user import)
       -> processed image (opacity/brightness/contrast/grayscale/invert/
          blur/threshold/edge-detection \u2014 Section 15), cached, only
          recomputed when a processing control changes
       -> placement (position/scale/rotation in normalized paper space,
          set via touch gestures \u2014 Section 17)
       -> warped onto an offscreen bake canvas via image-warp.js, through
          Calibration's homography, only recomputed when placement or
          calibration changes
       -> composited onto the visible reference-canvas every frame (cheap)

   Lock/unlock (Section 16): while locked, gesture handlers are detached
   entirely, so pinch/pan/camera movement cannot touch the reference \u2014
   only the (fixed) paper coordinate system it already lives in matters.
   ========================================================================== */

(function () {
  'use strict';

  const canvas = document.getElementById('reference-canvas');
  const ctx = canvas.getContext('2d');

  const bakeCanvas = document.createElement('canvas');
  const bakeCtx = bakeCanvas.getContext('2d');

  const sourceCanvas = document.createElement('canvas'); // raw imported image, downscaled
  const processedCanvas = document.createElement('canvas'); // after Section 15 filters
  const processedCtx = processedCanvas.getContext('2d');
  const outlineCanvas = document.createElement('canvas'); // built once per image, for guideMode 'outline'
  const outlineCtx = outlineCanvas.getContext('2d');

  const state = {
    hasImage: false,
    locked: false,
    // placement: where the image sits in normalized (0..1) paper space
    placement: { cx: 0.5, cy: 0.5, w: 0.8, rotation: 0 }, // h derived from aspect
    aspect: 1,
    processing: {
      opacity: 0.7,
      brightness: 1,     // 0.3 - 1.7
      contrast: 1,        // 0.3 - 1.7
      grayscale: false,
      invert: false,
      blur: 0,             // px, 0-6
      edgeDetect: false,
      threshold: null,     // null = off, else 0-255
    },
    needsBake: false,
    guideMode: 'normal', // normal | outline | ghost (Phase 10 adds guided/path)
  };

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (listeners[evt] || []).forEach((fn) => fn(payload)); }

  // ---- import ----
  function loadFromFile(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1000; // cap resolution: this is a tracing reference, not a print master
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        sourceCanvas.width = Math.round(img.width * scale);
        sourceCanvas.height = Math.round(img.height * scale);
        sourceCanvas.getContext('2d').drawImage(img, 0, 0, sourceCanvas.width, sourceCanvas.height);

        state.hasImage = true;
        state.aspect = sourceCanvas.width / sourceCanvas.height;
        state.placement = { cx: 0.5, cy: 0.5, w: 0.8, rotation: 0 };
        applyProcessing();
        buildOutlineCanvas();
        URL.revokeObjectURL(img.src);
        emit('loaded');
        resolve();
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // ---- processing (Section 15) ----
  function applyProcessing() {
    if (!state.hasImage) return;
    const w = sourceCanvas.width, h = sourceCanvas.height;
    processedCanvas.width = w;
    processedCanvas.height = h;

    const p = state.processing;
    const filters = [];
    filters.push(`brightness(${p.brightness})`);
    filters.push(`contrast(${p.contrast})`);
    if (p.grayscale) filters.push('grayscale(1)');
    if (p.invert) filters.push('invert(1)');
    if (p.blur > 0) filters.push(`blur(${p.blur}px)`);

    processedCtx.clearRect(0, 0, w, h);
    processedCtx.filter = filters.join(' ');
    processedCtx.drawImage(sourceCanvas, 0, 0);
    processedCtx.filter = 'none';

    if (p.edgeDetect) applySobelEdgeDetect();
    if (p.threshold != null) applyThreshold(p.threshold);

    state.needsBake = true;
    emit('processed');
  }

  function applySobelEdgeDetect() {
    const w = processedCanvas.width, h = processedCanvas.height;
    const src = processedCtx.getImageData(0, 0, w, h);
    const out = processedCtx.createImageData(w, h);
    const d = src.data, o = out.data;

    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }

    const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let sx = 0, sy = 0, k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const v = gray[(y + ky) * w + (x + kx)];
            sx += v * gx[k];
            sy += v * gy[k];
            k++;
          }
        }
        const mag = Math.min(255, Math.sqrt(sx * sx + sy * sy));
        const idx = (y * w + x) * 4;
        // white background, dark lines \u2014 reads like a clean tracing outline
        const val = 255 - mag;
        o[idx] = o[idx + 1] = o[idx + 2] = val;
        o[idx + 3] = 255;
      }
    }
    processedCtx.putImageData(out, 0, 0);
  }

  function applyThreshold(cutoff) {
    const w = processedCanvas.width, h = processedCanvas.height;
    const imgData = processedCtx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = lum >= cutoff ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    processedCtx.putImageData(imgData, 0, 0);
  }

  /** Independent edge-line rendering for guideMode 'outline' \u2014 built once
   *  from the ORIGINAL image, so it doesn't depend on whatever the user has
   *  toggled in the manual processing controls. */
  function buildOutlineCanvas() {
    const w = sourceCanvas.width, h = sourceCanvas.height;
    outlineCanvas.width = w;
    outlineCanvas.height = h;
    const src = sourceCanvas.getContext('2d').getImageData(0, 0, w, h);
    const out = outlineCtx.createImageData(w, h);
    const d = src.data, o = out.data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }
    const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let sx = 0, sy = 0, k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const v = gray[(y + ky) * w + (x + kx)];
            sx += v * gx[k]; sy += v * gy[k]; k++;
          }
        }
        const mag = Math.min(255, Math.sqrt(sx * sx + sy * sy));
        const idx = (y * w + x) * 4;
        o[idx] = o[idx + 1] = o[idx + 2] = 0;
        o[idx + 3] = mag > 40 ? Math.min(255, mag * 1.5) : 0; // transparent except on edges
      }
    }
    outlineCtx.putImageData(out, 0, 0);
  }

  function setProcessing(partial) {
    state.processing = { ...state.processing, ...partial };
    applyProcessing();
  }

  // ---- placement (Section 17) ----
  function uvToPaperNormalized(u, v) {
    // image UV [0,1]x[0,1] -> placed rectangle in normalized paper space,
    // centered at (cx,cy), width w (aspect-locked height), rotated.
    const { cx, cy, w, rotation } = state.placement;
    const h = w / state.aspect;
    const lx = (u - 0.5) * w;
    const ly = (v - 0.5) * h;
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    return {
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    };
  }

  function fitToPaper() {
    state.placement = { cx: 0.5, cy: 0.5, w: Math.min(1, state.aspect >= 1 ? 1 : state.aspect), rotation: 0 };
    // width in normalized units such that height also <=1
    if (state.aspect < 1) state.placement.w = state.aspect; else state.placement.w = 1;
    invalidateBake();
  }

  function invalidateBake() { state.needsBake = true; }

  // ---- gestures (disabled while locked) ----
  const pointers = new Map();
  let gestureStart = null;

  function attachGestures() {
    canvas.style.pointerEvents = 'auto';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
  }
  function detachGestures() {
    canvas.style.pointerEvents = 'none';
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    pointers.clear();
    gestureStart = null;
  }

  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gestureStart = snapshotGesture();
  }
  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) handlePan();
    else if (pointers.size >= 2) handlePinchRotate();
  }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    gestureStart = pointers.size ? snapshotGesture() : null;
  }

  function snapshotGesture() {
    const pts = [...pointers.values()];
    return {
      pts,
      placement: { ...state.placement },
      midpoint: pts.length ? avgPoint(pts) : null,
      dist: pts.length === 2 ? dist(pts[0], pts[1]) : null,
      angle: pts.length === 2 ? angle(pts[0], pts[1]) : null,
    };
  }
  function avgPoint(pts) {
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function angle(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }

  function handlePan() {
    if (!gestureStart || !window.Calibration || !window.Calibration.isCalibrated) return;
    const cur = [...pointers.values()][0];
    const start = gestureStart.pts[0];
    if (!start) return;
    const curNorm = window.Calibration.cameraToNormalized(cur.x, cur.y);
    const startNorm = window.Calibration.cameraToNormalized(start.x, start.y);
    if (!curNorm || !startNorm) return;
    state.placement.cx = gestureStart.placement.cx + (curNorm.x - startNorm.x);
    state.placement.cy = gestureStart.placement.cy + (curNorm.y - startNorm.y);
    invalidateBake();
  }

  function handlePinchRotate() {
    if (!gestureStart || gestureStart.pts.length < 2) return;
    const pts = [...pointers.values()];
    if (pts.length < 2) return;
    const d = dist(pts[0], pts[1]);
    const a = angle(pts[0], pts[1]);
    const scaleFactor = gestureStart.dist ? d / gestureStart.dist : 1;
    const rotDelta = a - gestureStart.angle;

    state.placement.w = Math.max(0.05, Math.min(3, gestureStart.placement.w * scaleFactor));
    state.placement.rotation = gestureStart.placement.rotation + rotDelta;
    invalidateBake();
  }

  function lock() {
    state.locked = true;
    detachGestures();
    emit('locked');
  }
  function unlock() {
    state.locked = false;
    if (state.hasImage) attachGestures();
    emit('unlocked');
  }

  window.PencilCamera && window.PencilCamera.on && window.PencilCamera.on('resize', () => {
    bakeCanvas.width = canvas.width;
    bakeCanvas.height = canvas.height;
    invalidateBake();
  });
  window.Calibration && window.Calibration.on && window.Calibration.on('complete', invalidateBake);

  // ---- baking + rendering ----
  function bake() {
    bakeCtx.clearRect(0, 0, bakeCanvas.width, bakeCanvas.height);
    if (!state.hasImage || !window.Calibration || !window.Calibration.isCalibrated) {
      state.needsBake = false;
      return;
    }
    const dpr = window.PencilCamera.dpr;
    bakeCtx.save();
    bakeCtx.globalAlpha = effectiveOpacity();
    const source = state.guideMode === 'outline' ? outlineCanvas : processedCanvas;
    window.ImageWarp.warpImage(bakeCtx, source, (u, v) => {
      const paperPt = uvToPaperNormalized(u, v);
      const disp = window.Calibration.normalizedToCamera(paperPt.x, paperPt.y);
      return { x: disp.x * dpr, y: disp.y * dpr };
    }, 14);
    bakeCtx.restore();
    state.needsBake = false;
  }

  function effectiveOpacity() {
    const base = state.processing.opacity;
    if (state.guideMode === 'ghost') return Math.min(base, 0.18);
    if (state.guideMode === 'path') return Math.min(base, 0.12); // tracing.js draws the explicit path on top
    if (state.guideMode === 'outline') return Math.max(base, 0.85); // alpha channel already encodes edges
    return base;
  }

  function render() {
    if (state.needsBake) bake();
    const dpr = window.PencilCamera.dpr;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    if (!state.hasImage) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bakeCanvas, 0, 0);
    ctx.restore();
  }

  window.PencilCamera && window.PencilCamera.onFrame && window.PencilCamera.onFrame(render);

  window.Reference = {
    loadFromFile,
    setProcessing,
    fitToPaper,
    lock,
    unlock,
    on,
    setGuideMode(mode) { state.guideMode = mode; invalidateBake(); },
    paperNormalizedToUV(x, y) {
      const { cx, cy, w, rotation } = state.placement;
      const h = w / state.aspect;
      const dx = x - cx, dy = y - cy;
      const cos = Math.cos(-rotation), sin = Math.sin(-rotation);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      return { u: lx / w + 0.5, v: ly / h + 0.5 };
    },
    uvToPaperNormalized,
    getSourceCanvas() { return sourceCanvas; },
    get hasImage() { return state.hasImage; },
    get locked() { return state.locked; },
    get processing() { return { ...state.processing }; },
    get placement() { return { ...state.placement }; },
    get aspect() { return state.aspect; },
  };
})();
