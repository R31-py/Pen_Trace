/* ==========================================================================
   brushes.js — Phase 7: Brush Engine

   Pure rendering functions: given a 2D context already positioned in
   whatever coordinate space the caller wants (CSS px for the live
   in-progress stroke, device px for the baked ink layer \u2014 see
   drawing.js), draw one brush's interpretation of a point path.

   Each renderer receives:
     ctx        - canvas 2D context, already save()'d by the caller
     pts        - [{x,y}] already projected into ctx's coordinate space
     widthPx    - base stroke width in that same coordinate space
     brush      - {type, size, opacity, color, ...}
     seed       - stable per-stroke integer, for deterministic "random"
                  texture that doesn't shimmer on re-render

   None of these call ctx.save()/restore() themselves except where they
   need to nest state changes \u2014 the caller wraps each call.
   ========================================================================== */

(function () {
  'use strict';

  // Deterministic pseudo-random in [0,1), seeded by two integers, so the
  // same stroke always renders identical texture (no shimmer on redraw).
  function prand(seed, i) {
    const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 };
  }

  function strokePath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  // ---------------------------------------------------------------------
  // Pencil: slightly textured, soft edges, subtle opacity variation
  // ---------------------------------------------------------------------
  function renderPencil(ctx, pts, widthPx, brush, seed) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = brush.color;
    const texture = brush.texture == null ? 0.5 : brush.texture;

    // base stroke
    ctx.globalAlpha = brush.opacity * 0.75;
    ctx.lineWidth = widthPx;
    strokePath(ctx, pts);

    // grain: a few thin offset passes with per-segment alpha jitter,
    // intensity driven by the texture control
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const jitter = (prand(seed, i * 3 + pass) - 0.5) * widthPx * 0.7 * texture;
        const nx = pts[i].x + jitter;
        const ny = pts[i].y + jitter * 0.4;
        if (i === 0) ctx.moveTo(nx, ny); else ctx.lineTo(nx, ny);
      }
      ctx.lineWidth = widthPx * 0.5;
      ctx.globalAlpha = brush.opacity * texture * (0.3 + 0.2 * prand(seed, pass + 99));
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------
  // Mechanical pencil: crisp, thin, precise, no texture
  // ---------------------------------------------------------------------
  function renderMechanicalPencil(ctx, pts, widthPx, brush) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = brush.color;
    ctx.globalAlpha = brush.opacity;
    ctx.lineWidth = Math.max(1, widthPx * 0.55);
    strokePath(ctx, pts);
  }

  // ---------------------------------------------------------------------
  // Pen: smooth, solid, consistent opacity, sharp edges
  // ---------------------------------------------------------------------
  function renderPen(ctx, pts, widthPx, brush) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = brush.color;
    ctx.globalAlpha = brush.opacity;
    ctx.lineWidth = widthPx;
    strokePath(ctx, pts);
  }

  // ---------------------------------------------------------------------
  // Marker: thick, translucent, soft edges, broad coverage
  // ---------------------------------------------------------------------
  function renderMarker(ctx, pts, widthPx, brush) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = brush.color;
    const flow = brush.flow == null ? 0.5 : brush.flow;

    // soft halo pass (wider, faint) for the "soft edges" feel
    ctx.globalAlpha = brush.opacity * 0.25;
    ctx.lineWidth = widthPx * 1.5;
    strokePath(ctx, pts);

    // core translucent body \u2014 more flow = more ink laid down per pass
    ctx.globalAlpha = brush.opacity * (0.45 + 0.45 * flow);
    ctx.lineWidth = widthPx;
    strokePath(ctx, pts);
  }

  // ---------------------------------------------------------------------
  // Paint brush: variable width, textured edges, slight opacity variation
  // ---------------------------------------------------------------------
  function renderPaintBrush(ctx, pts, widthPx, brush, seed) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = brush.color;
    const texture = brush.texture == null ? 0.5 : brush.texture;

    for (let i = 1; i < pts.length; i++) {
      const wobble = 1 - texture * 0.5 + texture * Math.abs(Math.sin(i * 0.6 + seed));
      ctx.globalAlpha = brush.opacity * (0.75 + 0.2 * prand(seed, i));
      ctx.lineWidth = widthPx * wobble;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------
  // Wet brush: soft edges, translucent pigment that darkens on overlap
  // (multiply blend = real pigment-stacking behavior, close to free)
  // ---------------------------------------------------------------------
  function renderWetBrush(ctx, pts, widthPx, brush) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = brush.color;
    ctx.globalCompositeOperation = 'multiply';
    const flow = brush.flow == null ? 0.5 : brush.flow;

    // soft spread underlay
    ctx.globalAlpha = brush.opacity * 0.35;
    ctx.lineWidth = widthPx * (1.4 + flow * 0.5);
    strokePath(ctx, pts);

    // pigment core
    ctx.globalAlpha = brush.opacity * (0.4 + 0.4 * flow);
    ctx.lineWidth = widthPx;
    strokePath(ctx, pts);
  }

  // ---------------------------------------------------------------------
  // Watercolor: very soft, very low opacity, soft boundaries, layered
  // ---------------------------------------------------------------------
  function renderWatercolor(ctx, pts, widthPx, brush, seed) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = brush.color;
    ctx.globalCompositeOperation = 'multiply';

    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const j = (prand(seed, i + layer * 50) - 0.5) * widthPx * 0.6;
        const nx = pts[i].x + j;
        const ny = pts[i].y + j * 0.5;
        if (i === 0) ctx.moveTo(nx, ny); else ctx.lineTo(nx, ny);
      }
      ctx.globalAlpha = brush.opacity * 0.28;
      ctx.lineWidth = widthPx * (1.4 - layer * 0.25);
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------
  // Airbrush: soft circular gradient dabs, feathered, builds with passes
  // ---------------------------------------------------------------------
  function renderAirbrush(ctx, pts, widthPx, brush, seed) {
    ctx.globalCompositeOperation = 'source-over';
    const rgb = hexToRgb(brush.color);
    const flow = brush.flow == null ? 0.5 : brush.flow;
    const r = widthPx * 1.3;
    const dabSpacing = Math.max(1.5, r * (0.55 - flow * 0.35)); // more flow = denser dabs

    let lastDab = null;
    for (let i = 0; i < pts.length; i++) {
      if (lastDab) {
        const d = Math.hypot(pts[i].x - lastDab.x, pts[i].y - lastDab.y);
        if (d < dabSpacing) continue;
      }
      lastDab = pts[i];
      const grad = ctx.createRadialGradient(pts[i].x, pts[i].y, 0, pts[i].x, pts[i].y, r);
      const a = brush.opacity * (0.12 + 0.2 * flow);
      grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`);
      grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------------
  // Eraser: not really a "render" \u2014 caller uses destination-out via
  // this same stroking path. Exposed so drawing.js can share the geometry.
  // ---------------------------------------------------------------------
  function renderEraser(ctx, pts, widthPx) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.lineWidth = widthPx;
    strokePath(ctx, pts);
  }

  const RENDERERS = {
    pencil: renderPencil,
    mechanicalPencil: renderMechanicalPencil,
    pen: renderPen,
    marker: renderMarker,
    paintBrush: renderPaintBrush,
    wetBrush: renderWetBrush,
    watercolor: renderWatercolor,
    airbrush: renderAirbrush,
    eraser: renderEraser,
  };

  // Default parameters per brush type (flow/texture: 0..1, 0.5 = neutral).
  const PRESETS = {
    pencil:            { size: 0.006, opacity: 0.88, color: '#1c1c1c', flow: 0.5, texture: 0.5 },
    mechanicalPencil:  { size: 0.0035, opacity: 1.0,  color: '#111111', flow: 0.5, texture: 0.5 },
    pen:               { size: 0.005, opacity: 1.0,  color: '#0a0a0a', flow: 0.5, texture: 0.5 },
    marker:            { size: 0.016, opacity: 0.55, color: '#e63946', flow: 0.5, texture: 0.5 },
    paintBrush:        { size: 0.013, opacity: 0.85, color: '#2a6f97', flow: 0.5, texture: 0.5 },
    wetBrush:          { size: 0.018, opacity: 0.5,  color: '#1d3557', flow: 0.5, texture: 0.5 },
    watercolor:        { size: 0.022, opacity: 0.35, color: '#8ecae6', flow: 0.5, texture: 0.5 },
    airbrush:          { size: 0.022, opacity: 0.6,  color: '#f4a261', flow: 0.5, texture: 0.5 },
    eraser:            { size: 0.022, opacity: 1.0,  color: '#000000', flow: 0.5, texture: 0.5 },
  };

  /**
   * Renders one stroke onto ctx. `ctx` must already be save()'d by the
   * caller; this function does not restore it. `pts` must already be
   * projected into ctx's coordinate space, and have length >= 2.
   */
  function render(ctx, pts, widthPx, brush, seed) {
    const fn = RENDERERS[brush.type] || RENDERERS.pencil;
    ctx.globalCompositeOperation = 'source-over'; // reset default before each stroke
    fn(ctx, pts, widthPx, brush, seed || 1);
    ctx.globalCompositeOperation = 'source-over'; // don't leak blend mode to next draw
  }

  window.BrushEngine = {
    render,
    PRESETS,
    TYPES: Object.keys(RENDERERS),
  };
})();
