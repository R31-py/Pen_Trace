/* ==========================================================================
   brush-controls.js — Phase 8: Brush Controls (size, opacity, color, flow,
   texture) per Sections 10, 11, 12.

   Talks to window.Drawing.setBrush(...) (Phase 6/7) to update the live
   brush in real time as sliders move. This is a functional MVP control
   surface \u2014 Section 27's fuller toolbar visual polish and Section 13's
   saved presets come later; the important thing here is that every
   control in Sections 10-12 actually changes what gets drawn, live.
   ========================================================================== */

(function () {
  'use strict';

  const QUICK_COLORS = [
    { name: 'black', hex: '#1a1a1a' },
    { name: 'white', hex: '#f5f5f0' },
    { name: 'red', hex: '#e63946' },
    { name: 'orange', hex: '#f4a261' },
    { name: 'yellow', hex: '#f7d842' },
    { name: 'green', hex: '#2a9d8f' },
    { name: 'blue', hex: '#1d3557' },
    { name: 'purple', hex: '#7b2cbf' },
    { name: 'pink', hex: '#ff6b9d' },
    { name: 'brown', hex: '#6f4518' },
    { name: 'gray', hex: '#6b7570' },
  ];

  // Slider ranges chosen so the useful part of each curve isn't crammed
  // into a few pixels of travel (Section 10: "very fine lines to large
  // brush strokes").
  const SIZE_MIN = 0.0015;
  const SIZE_MAX = 0.055;

  const sizeSlider = document.getElementById('size-slider');
  const opacitySlider = document.getElementById('opacity-slider');
  const flowSlider = document.getElementById('flow-slider');
  const textureSlider = document.getElementById('texture-slider');
  const sizePreviewDot = document.getElementById('size-preview-dot');
  const colorRow = document.getElementById('color-row');
  const advancedToggle = document.getElementById('advanced-toggle');
  const advancedRow = document.getElementById('advanced-row');
  const pickerPanel = document.getElementById('color-picker-panel');
  const svCanvas = document.getElementById('sv-canvas');
  const hueCanvas = document.getElementById('hue-canvas');
  const svCtx = svCanvas.getContext('2d');
  const hueCtx = hueCanvas.getContext('2d');

  const state = {
    hue: 0,          // 0-360
    sat: 0,           // 0-100
    val: 10,          // 0-100 (near black to match default pencil color)
    lastCustomHex: '#1c1c1c',
    activeSwatchHex: '#1c1c1c',
  };

  // ---- size <-> slider mapping (log-ish curve for a natural feel) ----
  function sliderToSize(v) {
    const t = v / 100;
    return SIZE_MIN * Math.pow(SIZE_MAX / SIZE_MIN, t);
  }
  function updateSizePreview() {
    const t = sizeSlider.value / 100;
    const px = 4 + t * 26; // purely visual, 4-30px on screen
    sizePreviewDot.style.width = px + 'px';
    sizePreviewDot.style.height = px + 'px';
  }

  sizeSlider.addEventListener('input', () => {
    window.Drawing.setBrush({ size: sliderToSize(Number(sizeSlider.value)) });
    updateSizePreview();
  });
  opacitySlider.addEventListener('input', () => {
    window.Drawing.setBrush({ opacity: Number(opacitySlider.value) / 100 });
  });
  flowSlider.addEventListener('input', () => {
    window.Drawing.setBrush({ flow: Number(flowSlider.value) / 100 });
  });
  textureSlider.addEventListener('input', () => {
    window.Drawing.setBrush({ texture: Number(textureSlider.value) / 100 });
  });
  advancedToggle.addEventListener('click', () => {
    advancedRow.classList.toggle('hidden');
  });

  /** Keeps sliders in sync when the active brush TYPE changes (Phase 7's
   *  chip switcher loads a new preset with its own size/opacity/flow). */
  function syncSlidersFromBrush() {
    const b = window.Drawing.brush;
    const t = Math.log(b.size / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN);
    sizeSlider.value = Math.round(Math.max(0, Math.min(1, t)) * 100);
    opacitySlider.value = Math.round(b.opacity * 100);
    flowSlider.value = Math.round((b.flow == null ? 0.5 : b.flow) * 100);
    textureSlider.value = Math.round((b.texture == null ? 0.5 : b.texture) * 100);
    updateSizePreview();
    setActiveSwatch(b.color);
  }
  window.BrushControls = { syncSlidersFromBrush }; // app.js calls this after brush-type switches

  // ---- quick colors ----
  function buildColorRow() {
    QUICK_COLORS.forEach(({ name, hex }) => {
      const sw = document.createElement('button');
      sw.className = 'swatch';
      sw.style.background = hex;
      sw.title = name;
      sw.dataset.hex = hex;
      sw.addEventListener('click', () => selectColor(hex));
      colorRow.appendChild(sw);
    });

    const custom = document.createElement('button');
    custom.className = 'swatch custom-swatch';
    custom.textContent = '+';
    custom.title = 'Custom color';
    custom.addEventListener('click', () => {
      pickerPanel.classList.toggle('hidden');
      if (!pickerPanel.classList.contains('hidden')) drawPicker();
    });
    colorRow.appendChild(custom);
  }

  function setActiveSwatch(hex) {
    state.activeSwatchHex = hex;
    [...colorRow.querySelectorAll('.swatch')].forEach((el) => {
      el.classList.toggle('active', el.dataset.hex === hex);
    });
  }

  function selectColor(hex) {
    window.Drawing.setBrush({ color: hex });
    setActiveSwatch(hex);
    pickerPanel.classList.add('hidden');
  }

  // ---- custom HSV picker ----
  function hsvToHex(h, s, v) {
    s /= 100; v /= 100;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function drawPicker() {
    // hue strip
    const hueGrad = hueCtx.createLinearGradient(0, 0, hueCanvas.width, 0);
    for (let i = 0; i <= 360; i += 30) hueGrad.addColorStop(i / 360, hsvToHex(i, 100, 100));
    hueCtx.fillStyle = hueGrad;
    hueCtx.fillRect(0, 0, hueCanvas.width, hueCanvas.height);
    const hx = (state.hue / 360) * hueCanvas.width;
    hueCtx.strokeStyle = '#fff';
    hueCtx.lineWidth = 2;
    hueCtx.strokeRect(hx - 2, 0, 4, hueCanvas.height);

    // saturation/value square
    const baseHex = hsvToHex(state.hue, 100, 100);
    svCtx.fillStyle = baseHex;
    svCtx.fillRect(0, 0, svCanvas.width, svCanvas.height);
    const whiteGrad = svCtx.createLinearGradient(0, 0, svCanvas.width, 0);
    whiteGrad.addColorStop(0, 'rgba(255,255,255,1)');
    whiteGrad.addColorStop(1, 'rgba(255,255,255,0)');
    svCtx.fillStyle = whiteGrad;
    svCtx.fillRect(0, 0, svCanvas.width, svCanvas.height);
    const blackGrad = svCtx.createLinearGradient(0, 0, 0, svCanvas.height);
    blackGrad.addColorStop(0, 'rgba(0,0,0,0)');
    blackGrad.addColorStop(1, 'rgba(0,0,0,1)');
    svCtx.fillStyle = blackGrad;
    svCtx.fillRect(0, 0, svCanvas.width, svCanvas.height);

    const px = (state.sat / 100) * svCanvas.width;
    const py = (1 - state.val / 100) * svCanvas.height;
    svCtx.strokeStyle = '#fff';
    svCtx.lineWidth = 2;
    svCtx.beginPath();
    svCtx.arc(px, py, 7, 0, Math.PI * 2);
    svCtx.stroke();
  }

  function applyCustomColor() {
    const hex = hsvToHex(state.hue, state.sat, state.val);
    state.lastCustomHex = hex;
    window.Drawing.setBrush({ color: hex });
    setActiveSwatch(hex);
  }

  function canvasPointerHandler(canvas, onMove) {
    let dragging = false;
    const rect = () => canvas.getBoundingClientRect();
    function pos(e) {
      const r = rect();
      const scaleX = canvas.width / r.width;
      const scaleY = canvas.height / r.height;
      return {
        x: Math.max(0, Math.min(canvas.width, (e.clientX - r.left) * scaleX)),
        y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top) * scaleY)),
      };
    }
    canvas.addEventListener('pointerdown', (e) => { dragging = true; onMove(pos(e)); });
    canvas.addEventListener('pointermove', (e) => { if (dragging) onMove(pos(e)); });
    window.addEventListener('pointerup', () => { dragging = false; });
  }

  canvasPointerHandler(hueCanvas, (p) => {
    state.hue = (p.x / hueCanvas.width) * 360;
    drawPicker();
    applyCustomColor();
  });
  canvasPointerHandler(svCanvas, (p) => {
    state.sat = (p.x / svCanvas.width) * 100;
    state.val = (1 - p.y / svCanvas.height) * 100;
    drawPicker();
    applyCustomColor();
  });

  buildColorRow();
  updateSizePreview();
  setActiveSwatch(state.activeSwatchHex);
})();
