/* ==========================================================================
   drawing.js — Phase 6/7: Virtual Drawing + Brush Engine integration

   Two-layer rendering strategy for performance (Section 26 \u2014 CV/render
   must never block, and redrawing every stroke's full brush texture every
   frame doesn't scale as a drawing grows):

     inkCanvas (offscreen, device px, no transform)
       - permanent home for every FINALIZED stroke, baked once
       - only touched again on: recalibration (remap), resize (remap),
         undo/redo/clear (rebuild from the strokes array)

     draw-canvas (visible, CSS-space, dpr-transformed)
       - cleared and redrawn every frame:
           1. inkCanvas composited in wholesale (cheap: one drawImage)
           2. the CURRENT in-progress stroke rendered live on top
              (not yet baked, since it's still being extended)

   Strokes remain stored as normalized-coordinate point lists (Phase 6),
   so remapping on resize/recalibration is just "redraw everything through
   the new homography" rather than losing data.
   ========================================================================== */

(function () {
  'use strict';

  const canvas = document.getElementById('draw-canvas');
  const ctx = canvas.getContext('2d');

  const inkCanvas = document.createElement('canvas');
  const inkCtx = inkCanvas.getContext('2d');

  const state = {
    enabled: false,
    strokes: [],
    current: null,
    brush: { type: 'pencil', ...window.BrushEngine.PRESETS.pencil },
    strokeSeedCounter: 1,
  };

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (listeners[evt] || []).forEach((fn) => fn(payload)); }

  function enable() { state.enabled = true; }
  function disable() {
    state.enabled = false;
    if (state.current) finalizeStroke();
  }

  // ---- stroke lifecycle ----
  function startStroke(pt) {
    state.current = {
      id: 'stroke_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
      seed: state.strokeSeedCounter++,
      brush: { ...state.brush },
      points: [{ x: pt.x, y: pt.y }],
    };
  }

  function extendStroke(pt) {
    if (!state.current) return startStroke(pt);
    const pts = state.current.points;
    const last = pts[pts.length - 1];
    const d = Math.hypot(pt.x - last.x, pt.y - last.y);
    if (d < 0.0008) return;
    pts.push({ x: pt.x, y: pt.y });

    // Eraser bakes destructively and incrementally, in real time, straight
    // onto the ink layer \u2014 waiting until stroke-finalize would mean no
    // visual feedback while erasing, and erasing is inherently destructive
    // anyway (nothing to redraw non-destructively later).
    if (state.current.brush.type === 'eraser' && pts.length >= 2) {
      bakeSegmentToInk(state.current, pts.length - 2, pts.length - 1);
    }
  }

  function finalizeStroke() {
    if (!state.current) return;
    const stroke = state.current;
    state.current = null;
    if (stroke.points.length < 2) return;

    state.strokes.push(stroke);
    if (stroke.brush.type !== 'eraser') {
      bakeStrokeToInk(stroke); // eraser already baked incrementally above
    }
    emit('stroke-added', stroke);
  }

  function clearAll() {
    state.strokes = [];
    state.current = null;
    clearInk();
    emit('cleared');
  }

  // ---- projection helpers ----
  function projectNormalizedPoints(points, toDevicePixels) {
    const dpr = toDevicePixels ? window.PencilCamera.dpr : 1;
    return points.map((p) => {
      const c = window.Calibration.normalizedToCamera(p.x, p.y);
      return { x: c.x * dpr, y: c.y * dpr };
    });
  }

  function widthForStroke(stroke, atNormY, toDevicePixels) {
    const a = window.Calibration.normalizedToCamera(0, atNormY);
    const b = window.Calibration.normalizedToCamera(1, atNormY);
    const scale = Math.hypot(b.x - a.x, b.y - a.y) || 800;
    const dpr = toDevicePixels ? window.PencilCamera.dpr : 1;
    return Math.max(1, stroke.brush.size * scale * dpr);
  }

  // ---- ink layer (baked, permanent) ----
  function resizeInk() {
    inkCanvas.width = canvas.width;
    inkCanvas.height = canvas.height;
    rebakeAll();
  }

  function clearInk() {
    inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
  }

  function bakeStrokeToInk(stroke) {
    if (!window.Calibration || !window.Calibration.isCalibrated) return;
    const pts = projectNormalizedPoints(stroke.points, true);
    if (pts.length < 2) return;
    const widthPx = widthForStroke(stroke, stroke.points[0].y, true);
    inkCtx.save();
    window.BrushEngine.render(inkCtx, pts, widthPx, stroke.brush, stroke.seed);
    inkCtx.restore();
  }

  /** Used only by the eraser's incremental live-bake, one segment at a time. */
  function bakeSegmentToInk(stroke, i0, i1) {
    if (!window.Calibration || !window.Calibration.isCalibrated) return;
    const seg = projectNormalizedPoints([stroke.points[i0], stroke.points[i1]], true);
    const widthPx = widthForStroke(stroke, stroke.points[i0].y, true);
    inkCtx.save();
    window.BrushEngine.render(inkCtx, seg, widthPx, stroke.brush, stroke.seed);
    inkCtx.restore();
  }

  function rebakeAll() {
    clearInk();
    if (!window.Calibration || !window.Calibration.isCalibrated) return;
    for (const stroke of state.strokes) {
      if (stroke.brush.type === 'eraser') {
        // replay eraser strokes segment-by-segment so composite ordering
        // relative to strokes drawn before/after it is preserved
        for (let i = 1; i < stroke.points.length; i++) bakeSegmentToInk(stroke, i - 1, i);
      } else {
        bakeStrokeToInk(stroke);
      }
    }
  }

  window.PencilCamera && window.PencilCamera.on && window.PencilCamera.on('resize', () => {
    // canvas.width/height already updated by camera.js before this fires
    resizeInk();
  });

  // ---- wire to Tracking (Phase 5) ----
  window.Tracking && window.Tracking.on('point', (p) => {
    if (!state.enabled) return;
    if (!state.current) startStroke(p);
    else extendStroke(p);
  });
  window.Tracking && window.Tracking.on('lost', () => {
    if (state.enabled) finalizeStroke();
  });

  // ---- live rendering (every frame) ----
  function render() {
    if (!window.Calibration || !window.Calibration.isCalibrated) return;
    const dpr = window.PencilCamera.dpr;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    // 1. baked strokes, composited wholesale
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // ink layer is already in device px
    ctx.drawImage(inkCanvas, 0, 0);
    ctx.restore();

    // 2. live in-progress stroke (CSS-space, matches ctx's dpr transform)
    if (state.current && state.current.points.length >= 2 && state.current.brush.type !== 'eraser') {
      const pts = projectNormalizedPoints(state.current.points, false);
      const widthPx = widthForStroke(state.current, state.current.points[0].y, false);
      ctx.save();
      window.BrushEngine.render(ctx, pts, widthPx, state.current.brush, state.current.seed);
      ctx.restore();
    }
  }

  window.PencilCamera && window.PencilCamera.onFrame && window.PencilCamera.onFrame(render);

  window.Drawing = {
    enable,
    disable,
    clearAll,
    on,
    setBrush(partial) { state.brush = { ...state.brush, ...partial }; },
    setBrushType(type) {
      const preset = window.BrushEngine.PRESETS[type];
      if (!preset) return;
      state.brush = { type, ...preset };
    },
    rebakeAll,
    get brush() { return { ...state.brush }; },
    get strokes() { return state.strokes; },
    get isDrawing() { return !!state.current; },
  };

  // initial ink canvas sizing (camera may already be sized by the time this loads)
  if (window.PencilCamera && window.PencilCamera.canvases) {
    inkCanvas.width = canvas.width || 1;
    inkCanvas.height = canvas.height || 1;
  }
})();
