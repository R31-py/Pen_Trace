/* ==========================================================================
   calibration.js — Phase 2: Virtual Calibration UI  (+ Phase 4: recording &
   homography, added at the bottom once Phase 3 tip-tracking exists to feed it)

   IMPORTANT per spec Section 3/30: there are NO physical marks on the paper.
   This module only ever draws a virtual square on the phone screen, over
   the live camera feed, on the overlay canvas. The user aligns a physical
   pencil tip with each on-screen dot in turn.

   This module does NOT detect the pencil itself (that's marker.js, Phase 3).
   It exposes `Calibration.updateTip(x, y, confidence)` — Phase 3's tracker
   calls this every frame with the tip position in overlay-canvas CSS pixels.
   Until Phase 3 lands, a dev fallback lets you tap the screen to simulate
   the tip so the calibration flow is testable in isolation.
   ========================================================================== */

(function () {
  'use strict';

  const CORNER_ORDER = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
  const CORNER_LABEL = {
    topLeft: 'top-left',
    topRight: 'top-right',
    bottomRight: 'bottom-right',
    bottomLeft: 'bottom-left',
  };

  const DWELL_MS = 550;        // how long the tip must stay near the target
  const HIT_RADIUS_PX = 34;    // "sufficiently close" per spec Section 4

  const overlay = document.getElementById('overlay-canvas');
  const ctx = overlay.getContext('2d');

  const state = {
    active: false,
    stepIndex: 0,
    targets: {},          // corner -> {x, y} in CSS px, set from layout
    recorded: {},         // corner -> {x, y} camera-space point once confirmed
    dwellStart: null,
    tip: null,             // {x, y, confidence} last known, in CSS px
    devTapEnabled: true,   // fallback input until Phase 3 wires the real tracker
    homography: null,
    inverseHomography: null,
  };

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (listeners[evt] || []).forEach((fn) => fn(payload)); }

  function layoutTargets() {
    const w = window.PencilCamera.width;
    const h = window.PencilCamera.height;
    // Square inset from screen edges so it comfortably fits the visible
    // paper area regardless of aspect ratio.
    const marginX = w * 0.14;
    const marginY = h * 0.22; // extra room for top/bottom bars
    state.targets = {
      topLeft: { x: marginX, y: marginY },
      topRight: { x: w - marginX, y: marginY },
      bottomRight: { x: w - marginX, y: h - marginY },
      bottomLeft: { x: marginX, y: h - marginY },
    };
  }

  function start() {
    layoutTargets();
    state.active = true;
    state.stepIndex = 0;
    state.recorded = {};
    state.dwellStart = null;
    window.PencilCamera.on('resize', layoutTargets);
    announceStep();
    if (state.devTapEnabled) overlay.style.pointerEvents = 'auto';
    emit('start');
  }

  function stop() {
    state.active = false;
    overlay.style.pointerEvents = 'none';
    window.App.hideHint();
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function announceStep() {
    const corner = CORNER_ORDER[state.stepIndex];
    window.App.showHint(`Move the pencil tip to the dot \u2014 ${CORNER_LABEL[corner]}`);
  }

  /** Phase 3 (and, for now, the dev tap fallback) call this every frame. */
  function updateTip(x, y, confidence) {
    if (!state.active) return;
    state.tip = { x, y, confidence: confidence == null ? 1 : confidence };
    evaluateDwell();
  }

  function evaluateDwell() {
    const corner = CORNER_ORDER[state.stepIndex];
    if (!corner || !state.tip) return;
    const target = state.targets[corner];
    const dx = state.tip.x - target.x;
    const dy = state.tip.y - target.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const inRange = dist <= HIT_RADIUS_PX && state.tip.confidence > 0.3;

    if (inRange) {
      if (state.dwellStart == null) state.dwellStart = performance.now();
      const held = performance.now() - state.dwellStart;
      if (held >= DWELL_MS) {
        confirmCorner(corner);
      }
    } else {
      state.dwellStart = null;
    }
  }

  function confirmCorner(corner) {
    // Record in *camera* space (overlay CSS px is fine here since Phase 5
    // normalizes everything through the same coordinate system the tracker
    // reports in \u2014 they're locked together by definition).
    state.recorded[corner] = { x: state.tip.x, y: state.tip.y };
    state.dwellStart = null;
    emit('corner-recorded', { corner, point: state.recorded[corner], index: state.stepIndex });

    state.stepIndex++;
    if (state.stepIndex >= CORNER_ORDER.length) {
      finish();
    } else {
      announceStep();
    }
  }

  const NORMALIZED_CORNERS = {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 1, y: 0 },
    bottomRight: { x: 1, y: 1 },
    bottomLeft: { x: 0, y: 1 },
  };

  function finish() {
    state.active = false;
    overlay.style.pointerEvents = 'none';

    const src = CORNER_ORDER.map((c) => state.recorded[c]);
    const dst = CORNER_ORDER.map((c) => NORMALIZED_CORNERS[c]);
    const H = window.Homography.computeHomography(src, dst);

    if (!H) {
      // Degenerate configuration \u2014 points were collinear or coincident
      // (e.g. tracking jumped between corners). Don't silently proceed
      // with a broken transform; ask the user to redo it.
      window.App.showHint('Calibration failed \u2014 points too close together. Try again.');
      setTimeout(() => window.App.hideHint(), 2200);
      emit('failed');
      // restart automatically so the user isn't stuck
      state.stepIndex = 0;
      state.recorded = {};
      state.dwellStart = null;
      state.active = true;
      overlay.style.pointerEvents = state.devTapEnabled ? 'auto' : 'none';
      announceStep();
      return;
    }

    state.homography = H;
    state.inverseHomography = window.Homography.invert3x3(H);

    window.App.showHint('Paper calibrated.');
    setTimeout(() => window.App.hideHint(), 1400);
    emit('complete', {
      points: { ...state.recorded },
      homography: H,
      inverseHomography: state.inverseHomography,
    });
  }

  /** Camera/display px (x,y) -> normalized paper coords (0..1, 0..1). */
  function cameraToNormalized(x, y) {
    if (!state.homography) return null;
    return window.Homography.applyHomography(state.homography, x, y);
  }

  /** Normalized paper coords (0..1) -> camera/display px, for drawing
   *  paper-space content (reference image, calibration re-check, etc.)
   *  back onto the live camera view. */
  function normalizedToCamera(x, y) {
    if (!state.inverseHomography) return null;
    return window.Homography.applyHomography(state.inverseHomography, x, y);
  }

  // ---- dev fallback: tap to simulate tip until real tracking exists ----
  overlay.addEventListener('pointerdown', (e) => {
    if (!state.active || !state.devTapEnabled) return;
    const rect = overlay.getBoundingClientRect();
    updateTip(e.clientX - rect.left, e.clientY - rect.top, 1);
  });

  // ---- rendering ----
  // NOTE: this module only owns the overlay canvas while calibration is
  // actively in progress. Once calibrated, tracking.js (Phase 5) takes
  // over drawing the live tip cursor / debug grid on this same canvas,
  // so we simply do nothing here when inactive.
  function render() {
    if (!state.active) return;
    renderCalibrationTargets();
  }

  function renderCalibrationTargets() {
    ctx.clearRect(0, 0, overlay.width / window.PencilCamera.dpr, overlay.height / window.PencilCamera.dpr);

    // connecting square outline
    const pts = CORNER_ORDER.map((c) => state.targets[c]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(243,241,234,0.35)';
    ctx.setLineDash([6, 8]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    CORNER_ORDER.forEach((corner, i) => {
      const p = state.targets[corner];
      const done = !!state.recorded[corner];
      const isCurrent = i === state.stepIndex && !done;

      if (done) {
        drawDot(p, 9, '#3fe08a', 0.9);
        drawCheck(p);
        return;
      }
      if (isCurrent) {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
        drawDot(p, 16 + pulse * 5, '#d6ff3f', 0.18 + pulse * 0.12);
        drawDot(p, 10, '#d6ff3f', 1);
        // progress ring for dwell
        if (state.dwellStart != null) {
          const t = Math.min(1, (performance.now() - state.dwellStart) / DWELL_MS);
          drawArc(p, 20, t);
        }
      } else {
        drawDot(p, 7, 'rgba(243,241,234,0.4)', 1);
      }
    });

    // live tip cursor
    if (state.tip) {
      drawCrosshair(state.tip);
    }
  }

  function drawDot(p, r, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function drawCheck(p) {
    ctx.save();
    ctx.strokeStyle = '#0b0d0c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x - 4, p.y);
    ctx.lineTo(p.x - 1, p.y + 3.5);
    ctx.lineTo(p.x + 5, p.y - 4);
    ctx.stroke();
    ctx.restore();
  }

  function drawArc(p, r, t) {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawCrosshair(tip) {
    ctx.save();
    ctx.globalAlpha = Math.max(0.25, tip.confidence);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tip.x - 10, tip.y);
    ctx.lineTo(tip.x + 10, tip.y);
    ctx.moveTo(tip.x, tip.y - 10);
    ctx.lineTo(tip.x, tip.y + 10);
    ctx.stroke();
    ctx.restore();
  }

  window.PencilCamera && window.PencilCamera.onFrame && window.PencilCamera.onFrame(render);

  window.Calibration = {
    start,
    stop,
    updateTip,
    on,
    cameraToNormalized,
    normalizedToCamera,
    get active() { return state.active; },
    get recordedPoints() { return { ...state.recorded }; },
    get homography() { return state.homography; },
    get isCalibrated() { return !!state.homography; },
    set devTapEnabled(v) { state.devTapEnabled = v; },
  };
})();
