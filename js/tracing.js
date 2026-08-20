/* ==========================================================================
   tracing.js — Phase 10: Tracing

   Since the reference is a raster image (not vector path data), the
   "target path" is derived as an edge-strength grid rather than an
   ordered line \u2014 this sidesteps needing full image vectorization while
   still satisfying the spec's requirements:
     - progress based on actual coverage, not time (Section 20)
     - on-target / near / far feedback (Section 19)
     - Normal / Outline / Ghost / Guided / Path guidance modes (Section 18)

   Grid built once per image (edge magnitude via Sobel, downsampled into
   an NxN grid of normalized image-UV cells). Coverage is a parallel
   boolean grid, set true (and never reset) the first time the tracked
   tip passes near a target cell while actively tracking \u2014 satisfying
   "avoid counting the same section repeatedly."
   ========================================================================== */

(function () {
  'use strict';

  const overlay = document.getElementById('overlay-canvas');
  const ctx = overlay.getContext('2d');

  const GRID_SIZE = 48;
  const EDGE_SAMPLE_RES = 180; // working resolution for the one-time Sobel pass
  const TARGET_THRESHOLD_FACTOR = 0.22; // relative to the grid's own max edge strength
  const HIT_RADIUS_UV = 0.035; // "close enough" to a target cell, in UV units

  const state = {
    active: false,
    guideMode: 'normal',
    gridN: GRID_SIZE,
    isTarget: null,
    covered: null,
    totalTargets: 0,
    coveredCount: 0,
    progress: 0,
    completed: false,
    lastState: 'none',
  };

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (listeners[evt] || []).forEach((fn) => fn(payload)); }

  function buildTargetGrid() {
    const src = window.Reference.getSourceCanvas();
    if (!src || !src.width) return;

    const scale = Math.min(1, EDGE_SAMPLE_RES / Math.max(src.width, src.height));
    const w = Math.max(2, Math.round(src.width * scale));
    const h = Math.max(2, Math.round(src.height * scale));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(src, 0, 0, w, h);
    const data = tctx.getImageData(0, 0, w, h).data;

    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    const mag = new Float32Array(w * h);
    const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    let maxMag = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let sx = 0, sy = 0, k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const v = gray[(y + ky) * w + (x + kx)];
            sx += v * gx[k]; sy += v * gy[k]; k++;
          }
        }
        const m = Math.sqrt(sx * sx + sy * sy);
        mag[y * w + x] = m;
        if (m > maxMag) maxMag = m;
      }
    }

    const n = state.gridN;
    const isTarget = new Uint8Array(n * n);
    const threshold = maxMag * TARGET_THRESHOLD_FACTOR;
    let total = 0;

    for (let gy2 = 0; gy2 < n; gy2++) {
      for (let gx2 = 0; gx2 < n; gx2++) {
        const x0 = Math.floor((gx2 / n) * w), x1 = Math.max(x0 + 1, Math.floor(((gx2 + 1) / n) * w));
        const y0 = Math.floor((gy2 / n) * h), y1 = Math.max(y0 + 1, Math.floor(((gy2 + 1) / n) * h));
        let best = 0;
        for (let y = y0; y < y1 && y < h; y++) {
          for (let x = x0; x < x1 && x < w; x++) {
            const m = mag[y * w + x];
            if (m > best) best = m;
          }
        }
        const idx = gy2 * n + gx2;
        if (best > threshold) {
          isTarget[idx] = 1;
          total++;
        }
      }
    }

    state.isTarget = isTarget;
    state.covered = new Uint8Array(n * n);
    state.totalTargets = total;
    state.coveredCount = 0;
    state.progress = 0;
    state.completed = false;
  }

  function start() {
    if (!window.Reference.hasImage) return false;
    buildTargetGrid();
    if (state.totalTargets === 0) return false;
    state.active = true;
    state.completed = false;
    emit('start');
    return true;
  }

  function stop() {
    state.active = false;
  }

  function restart() {
    if (!state.isTarget) return;
    state.covered = new Uint8Array(state.gridN * state.gridN);
    state.coveredCount = 0;
    state.progress = 0;
    state.completed = false;
    emit('progress', 0);
  }

  function setGuideMode(mode) {
    state.guideMode = mode;
    const refModeMap = { normal: 'normal', outline: 'outline', ghost: 'ghost', guided: 'normal', path: 'path' };
    window.Reference.setGuideMode(refModeMap[mode] || 'normal');
  }

  function uvToGrid(u, v) {
    return {
      gx: Math.max(0, Math.min(state.gridN - 1, Math.floor(u * state.gridN))),
      gy: Math.max(0, Math.min(state.gridN - 1, Math.floor(v * state.gridN))),
    };
  }

  function nearestTargetDistance(u, v) {
    if (!state.isTarget) return Infinity;
    const n = state.gridN;
    const { gx, gy } = uvToGrid(u, v);
    const searchR = Math.ceil(HIT_RADIUS_UV * n) + 2;
    let best = Infinity;
    for (let dy = -searchR; dy <= searchR; dy++) {
      for (let dx = -searchR; dx <= searchR; dx++) {
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (!state.isTarget[y * n + x]) continue;
        const cellU = (x + 0.5) / n, cellV = (y + 0.5) / n;
        const d = Math.hypot(cellU - u, cellV - v);
        if (d < best) best = d;
      }
    }
    return best;
  }

  function markCovered(u, v) {
    const { gx, gy } = uvToGrid(u, v);
    const n = state.gridN;
    const r = 1;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const idx = y * n + x;
        if (state.isTarget[idx] && !state.covered[idx]) {
          state.covered[idx] = 1;
          state.coveredCount++;
        }
      }
    }
    const progress = state.totalTargets ? state.coveredCount / state.totalTargets : 0;
    if (Math.abs(progress - state.progress) > 0.002) {
      state.progress = progress;
      emit('progress', progress);
    }
    if (!state.completed && progress >= 0.97) {
      state.completed = true;
      emit('complete');
    }
  }

  window.Tracking && window.Tracking.on && window.Tracking.on('point', (p) => {
    if (!state.active || !window.Reference.hasImage) {
      state.lastState = 'none';
      return;
    }
    const { u, v } = window.Reference.paperNormalizedToUV(p.x, p.y);
    if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) {
      state.lastState = 'none';
      return;
    }
    markCovered(u, v);
    const d = nearestTargetDistance(u, v);
    state.lastState = d < HIT_RADIUS_UV * 0.5 ? 'on' : d < HIT_RADIUS_UV * 1.8 ? 'near' : 'far';
  });

  function findNearestUncovered(fromU, fromV) {
    if (!state.isTarget) return null;
    const n = state.gridN;
    let best = null, bestDist = Infinity;
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) {
        const idx = gy * n + gx;
        if (!state.isTarget[idx] || state.covered[idx]) continue;
        const cu = (gx + 0.5) / n, cv = (gy + 0.5) / n;
        const d = Math.hypot(cu - fromU, cv - fromV);
        if (d < bestDist) { bestDist = d; best = { u: cu, v: cv }; }
      }
    }
    return best;
  }

  function render() {
    if (!state.active || !state.isTarget) return;
    if (window.Calibration && window.Calibration.active) return;
    if (state.guideMode === 'path') renderPathDots();
    if (state.guideMode === 'guided') renderGuidedHighlight();
  }

  function renderPathDots() {
    const n = state.gridN;
    ctx.save();
    ctx.fillStyle = 'rgba(214,255,63,0.55)';
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) {
        const idx = gy * n + gx;
        if (!state.isTarget[idx]) continue;
        const cu = (gx + 0.5) / n, cv = (gy + 0.5) / n;
        const paperPt = window.Reference.uvToPaperNormalized(cu, cv);
        const disp = window.Calibration.normalizedToCamera(paperPt.x, paperPt.y);
        ctx.globalAlpha = state.covered[idx] ? 0.15 : 0.6;
        ctx.beginPath();
        ctx.arc(disp.x, disp.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function renderGuidedHighlight() {
    const tip = window.Tracking && window.Tracking.point;
    const fromUV = tip ? window.Reference.paperNormalizedToUV(tip.x, tip.y) : { u: 0.5, v: 0.5 };
    const target = findNearestUncovered(fromUV.u, fromUV.v);
    if (!target) return;
    const paperPt = window.Reference.uvToPaperNormalized(target.u, target.v);
    const disp = window.Calibration.normalizedToCamera(paperPt.x, paperPt.y);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
    ctx.save();
    ctx.globalAlpha = 0.25 + pulse * 0.2;
    ctx.fillStyle = '#d6ff3f';
    ctx.beginPath();
    ctx.arc(disp.x, disp.y, 14 + pulse * 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(disp.x, disp.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  window.PencilCamera && window.PencilCamera.onFrame && window.PencilCamera.onFrame(render);

  window.Tracing = {
    start,
    stop,
    restart,
    setGuideMode,
    on,
    get active() { return state.active; },
    get progress() { return state.progress; },
    get completed() { return state.completed; },
    get feedbackState() { return state.active ? state.lastState : null; },
  };
})();
