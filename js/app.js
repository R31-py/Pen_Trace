/* ==========================================================================
   app.js — Phase 1: app bootstrap + camera permission flow
   Later phases attach here: calibration (Phase 2), tracking (Phase 3-5),
   brush engine (Phase 6-8), etc. Keeping a small App namespace now so
   those phases have one place to register themselves.
   ========================================================================== */

(function () {
  'use strict';

  const centerPanel = document.getElementById('center-panel');
  const centerTitle = document.getElementById('center-title');
  const centerBody = document.getElementById('center-body');
  const enableBtn = document.getElementById('enable-camera-btn');
  const fpsBadge = document.getElementById('fps-badge');
  const hintPill = document.getElementById('hint-pill');
  const trackingDot = document.getElementById('tracking-dot');

  const App = {
    phase: 'boot', // boot -> permission -> live (later: calibrating -> tracking)
    debug: /debug=1/.test(location.search),
  };
  window.App = App;

  function setCenter({ title, body, showButton = true, buttonLabel = 'Enable camera' }) {
    centerPanel.classList.remove('hidden');
    centerTitle.textContent = title;
    centerBody.textContent = body;
    enableBtn.style.display = showButton ? 'inline-block' : 'none';
    enableBtn.textContent = buttonLabel;
  }

  function showHint(text) {
    hintPill.textContent = text;
    hintPill.classList.remove('hidden');
  }
  function hideHint() {
    hintPill.classList.add('hidden');
  }
  App.showHint = showHint;
  App.hideHint = hideHint;

  function setTrackingDot(status) {
    // status: 'none' | 'bad' | 'warn' | 'good'
    trackingDot.className = 'dot' + (status && status !== 'none' ? ' ' + status : '');
  }
  App.setTrackingDot = setTrackingDot;

  async function requestCamera() {
    enableBtn.disabled = true;
    enableBtn.textContent = 'Requesting…';
    try {
      const settings = await window.PencilCamera.start();
      centerPanel.classList.add('hidden');
      document.getElementById('toolbar').classList.remove('hidden');
      if (App.debug) fpsBadge.classList.remove('hidden');

      App.phase = 'live';
      window.PencilCamera.onFrame(() => {
        if (App.debug) fpsBadge.textContent = window.PencilCamera.fps + ' fps';
      });
      cameraVisibilityBtn.classList.remove('hidden');

      console.log('[Pencil Tracer] camera live:', settings);
      App.emit('camera-ready', settings);
      window.MarkerTracker.init();
      promptMarkerColor();
    } catch (err) {
      handleCameraError(err);
    } finally {
      enableBtn.disabled = false;
    }
  }

  function handleCameraError(err) {
    console.error('[Pencil Tracer] camera error', err);
    const name = err && err.name;

    if (!window.isSecureContext) {
      setCenter({
        title: 'Camera needs a secure connection',
        body: 'Open this app over HTTPS (or localhost) to allow camera access.',
        showButton: false,
      });
      return;
    }
    if (err && err.message === 'NOT_SUPPORTED') {
      setCenter({
        title: 'Camera not supported',
        body: 'This browser doesn\u2019t support camera access. Try the latest Chrome or Safari.',
        showButton: false,
      });
      return;
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      setCenter({
        title: 'Camera permission denied',
        body: 'Pencil Tracer needs your camera to track the pencil. Allow camera access in your browser settings, then try again.',
        buttonLabel: 'Try again',
      });
      return;
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      setCenter({
        title: 'No camera found',
        body: 'We couldn\u2019t find a usable camera on this device.',
        showButton: false,
      });
      return;
    }
    if (name === 'NotReadableError') {
      setCenter({
        title: 'Camera is busy',
        body: 'Another app may be using the camera. Close it and try again.',
        buttonLabel: 'Try again',
      });
      return;
    }
    setCenter({
      title: 'Couldn\u2019t start the camera',
      body: 'Something went wrong opening the camera. You can try again.',
      buttonLabel: 'Try again',
    });
  }

  // ---- tiny event bus so phases can subscribe without coupling to app.js ----
  const listeners = {};
  App.on = (evt, fn) => ((listeners[evt] = listeners[evt] || []).push(fn));
  App.emit = (evt, payload) => (listeners[evt] || []).forEach((fn) => fn(payload));

  enableBtn.addEventListener('click', requestCamera);

  // Prevent iOS Safari's double-tap-to-zoom / pinch-zoom from fighting
  // with our own gesture handling (needed once reference positioning
  // lands in Phase 9, harmless now).
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  // ---- marker color calibration flow (Phase 3) ----
  function promptMarkerColor() {
    setCenter({
      title: 'Attach a colored marker',
      body: 'Clip or tape a small, brightly colored marker (a bright pink or orange sticker works well) close to your pencil\u2019s tip. Then point the camera at it.',
      buttonLabel: 'I\u2019m ready \u2014 tap the marker',
    });
    enableBtn.addEventListener('click', beginMarkerColorSample, { once: true });
  }

  function beginMarkerColorSample() {
    centerPanel.classList.add('hidden');
    App.phase = 'sampling-color';
    showHint('Tap the colored marker in the camera view');
    window.MarkerTracker.startColorCalibration();
  }

  window.MarkerTracker.on('color-calibrated', () => {
    hideHint();
    window.Calibration.devTapEnabled = false; // real tracking takes over now
    promptCalibration();
  });

  window.MarkerTracker.on('tip', (tip) => {
    setTrackingDot(tip.detected ? (tip.confidence > 0.55 ? 'good' : 'warn') : 'none');
    if (window.Calibration && window.Calibration.active) {
      window.Calibration.updateTip(tip.x, tip.y, tip.detected ? tip.confidence : 0);
    }
    App.emit('tip', tip); // Phase 5+ consumes this for normalized tracking
  });

  // ---- calibration flow (Phase 2) ----
  function promptCalibration() {
    setCenter({
      title: 'Calibrate your paper',
      body: 'You\u2019ll see four dots appear on screen. Touch your pencil tip to each one in order \u2014 nothing needs to be drawn on the paper itself.',
      buttonLabel: 'Start calibration',
    });
    enableBtn.removeEventListener('click', requestCamera);
    enableBtn.addEventListener('click', beginCalibration, { once: true });
  }

  function beginCalibration() {
    centerPanel.classList.add('hidden');
    App.phase = 'calibrating';
    window.Calibration.start();
  }

  const recalibrateBtn = document.getElementById('recalibrate-btn');
  const cameraVisibilityBtn = document.getElementById('camera-visibility-btn');

  const CAMERA_VISIBILITY_STATES = ['faint', 'full', 'hidden'];
  let cameraVisibilityIndex = 0;
  cameraVisibilityBtn.addEventListener('click', () => {
    cameraVisibilityIndex = (cameraVisibilityIndex + 1) % CAMERA_VISIBILITY_STATES.length;
    const mode = CAMERA_VISIBILITY_STATES[cameraVisibilityIndex];
    const video = document.getElementById('camera-video');
    video.classList.remove('cam-full', 'cam-hidden');
    if (mode === 'full') video.classList.add('cam-full');
    if (mode === 'hidden') video.classList.add('cam-hidden');
    cameraVisibilityBtn.textContent = mode === 'faint' ? '\ud83d\udc41\ufe0f' : mode === 'full' ? '\ud83d\udcf7' : '\ud83d\udeab';
  });

  window.Calibration && window.Calibration.on('complete', ({ points, homography }) => {
    App.phase = 'calibrated';
    recalibrateBtn.classList.remove('hidden');
    console.log('[Pencil Tracer] calibration points (camera space):', points);
    console.log('[Pencil Tracer] homography:', homography);
    window.Tracking.enable();
    window.Drawing.enable();
    window.Drawing.rebakeAll(); // re-project any existing strokes through the new transform
    App.emit('calibration-complete', { points, homography }); // Phase 8 consumes this next
  });

  window.Tracking.on('lost', () => {
    showHint('Pencil not detected. Move it back into view.');
  });
  window.Tracking.on('acquired', () => {
    hideHint();
  });

  window.Calibration && window.Calibration.on('failed', () => {
    console.warn('[Pencil Tracer] calibration failed \u2014 degenerate point set, retrying');
  });

  // Recalibrate is available at all times once first calibration is done (Section 5)
  recalibrateBtn.addEventListener('click', () => {
    App.phase = 'calibrating';
    window.Calibration.start();
  });

  // ---- minimal test control for Phase 6 (superseded by full toolbar, Phase 27) ----
  document.getElementById('clear-btn').addEventListener('click', () => {
    window.Drawing.clearAll();
  });

  // ---- minimal brush-type switcher for Phase 7 (superseded by Phase 8's
  // full brush/size/opacity/color controls) ----
  const BRUSH_LABELS = {
    pencil: '\u270f\ufe0f Pencil',
    mechanicalPencil: '\u25cf Mech. Pencil',
    pen: '\ud83d\ude10 Pen',
    marker: '\ud83d\udd8d Marker',
    paintBrush: '\ud83d\udd8c Paint',
    wetBrush: '\ud83d\udca7 Wet Brush',
    watercolor: '\ud83c\udfa8 Watercolor',
    airbrush: '\u2601\ufe0f Airbrush',
    eraser: '\u25ab\ufe0f Eraser',
  };
  const brushRow = document.getElementById('brush-test-row');
  window.BrushEngine.TYPES.forEach((type) => {
    const btn = document.createElement('button');
    btn.className = 'brush-chip' + (type === 'pencil' ? ' active' : '');
    btn.textContent = BRUSH_LABELS[type] || type;
    btn.addEventListener('click', () => {
      window.Drawing.setBrushType(type);
      [...brushRow.children].forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      window.BrushControls.syncSlidersFromBrush();
    });
    brushRow.appendChild(btn);
  });

  // ---- reference image (Phase 9) ----
  const referenceBtn = document.getElementById('reference-btn');
  const referencePanel = document.getElementById('reference-panel');
  const fileInput = document.getElementById('reference-file-input');
  const lockBtn = document.getElementById('lock-reference-btn');
  const thresholdSlider = document.getElementById('ref-threshold');
  const thresholdToggle = document.getElementById('ref-threshold-toggle');

  window.Calibration && window.Calibration.on('complete', () => {
    referenceBtn.classList.remove('hidden');
  });

  referenceBtn.addEventListener('click', () => {
    referencePanel.classList.toggle('hidden');
  });

  document.getElementById('import-reference-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    if (!fileInput.files[0]) return;
    await window.Reference.loadFromFile(fileInput.files[0]);
    window.Reference.unlock(); // start unlocked so the user can position it
    lockBtn.textContent = '\ud83d\udd13';
    fileInput.value = '';
  });

  document.getElementById('fit-reference-btn').addEventListener('click', () => {
    window.Reference.fitToPaper();
  });

  lockBtn.addEventListener('click', () => {
    if (window.Reference.locked) {
      window.Reference.unlock();
      lockBtn.textContent = '\ud83d\udd13';
    } else {
      window.Reference.lock();
      lockBtn.textContent = '\ud83d\udd12';
    }
  });

  document.getElementById('ref-opacity').addEventListener('input', (e) => {
    window.Reference.setProcessing({ opacity: Number(e.target.value) / 100 });
  });
  document.getElementById('ref-brightness').addEventListener('input', (e) => {
    window.Reference.setProcessing({ brightness: Number(e.target.value) / 100 });
  });
  document.getElementById('ref-contrast').addEventListener('input', (e) => {
    window.Reference.setProcessing({ contrast: Number(e.target.value) / 100 });
  });
  document.getElementById('ref-blur').addEventListener('input', (e) => {
    window.Reference.setProcessing({ blur: Number(e.target.value) });
  });
  document.getElementById('ref-grayscale').addEventListener('change', (e) => {
    window.Reference.setProcessing({ grayscale: e.target.checked });
  });
  document.getElementById('ref-invert').addEventListener('change', (e) => {
    window.Reference.setProcessing({ invert: e.target.checked });
  });
  document.getElementById('ref-edge').addEventListener('change', (e) => {
    window.Reference.setProcessing({ edgeDetect: e.target.checked });
  });
  thresholdToggle.addEventListener('change', (e) => {
    thresholdSlider.disabled = !e.target.checked;
    window.Reference.setProcessing({ threshold: e.target.checked ? Number(thresholdSlider.value) : null });
  });
  thresholdSlider.addEventListener('input', (e) => {
    if (thresholdToggle.checked) window.Reference.setProcessing({ threshold: Number(e.target.value) });
  });

  // ---- tracing (Phase 10) ----
  const guideModeSelect = document.getElementById('guide-mode-select');
  const startTracingBtn = document.getElementById('start-tracing-btn');
  const progressPill = document.getElementById('tracing-progress-pill');
  const completePanel = document.getElementById('tracing-complete-panel');

  guideModeSelect.addEventListener('change', () => {
    window.Tracing.setGuideMode(guideModeSelect.value);
  });

  startTracingBtn.addEventListener('click', () => {
    if (!window.Reference.hasImage) {
      showHint('Import a reference image first');
      setTimeout(hideHint, 1800);
      return;
    }
    if (!window.Reference.locked) window.Reference.lock(); // tracing needs a fixed placement
    lockBtn.textContent = '\ud83d\udd12';
    const ok = window.Tracing.start();
    if (!ok) {
      showHint('Couldn\u2019t find enough detail in this image to trace');
      setTimeout(hideHint, 2200);
      return;
    }
    window.Tracing.setGuideMode(guideModeSelect.value);
    progressPill.classList.remove('hidden');
    referencePanel.classList.add('hidden');
  });

  window.Tracing.on('progress', (p) => {
    progressPill.textContent = `Tracing: ${Math.round(p * 100)}%`;
  });

  window.Tracing.on('complete', () => {
    completePanel.classList.remove('hidden');
  });

  document.getElementById('tracing-continue-btn').addEventListener('click', () => {
    completePanel.classList.add('hidden');
  });
  document.getElementById('tracing-restart-btn').addEventListener('click', () => {
    window.Tracing.restart();
    completePanel.classList.add('hidden');
  });

  // ---- touch-to-lift: tapping the drawing area ends the current stroke ----
  // (the camera can't distinguish "touching paper" from "hovering above
  // it" on its own \u2014 see forceLift()'s comment in tracking.js)
  const workspaceEl = document.querySelector('.workspace');
  workspaceEl.addEventListener('pointerdown', (e) => {
    // don't treat reference-image positioning gestures (drag/pinch/rotate,
    // only active while unlocked) as a lift tap
    if (e.target && e.target.id === 'reference-canvas') return;
    // stop this from being interpreted as the start of a long-press (which
    // triggers the browser's native "copy/save video frame" menu on the
    // camera <video> and eats the tap before it reaches us)
    e.preventDefault();
    window.Tracking.forceLift();
  });
  // belt-and-suspenders: some mobile browsers can still raise the video's
  // native context menu even with preventDefault above, so block it outright
  workspaceEl.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- service worker registration (fleshed out in Phase 13) ----
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => {
        console.warn('[Pencil Tracer] service worker registration failed', e);
      });
    });
  }

  // Initial state
  setCenter({
    title: 'Mount your phone above the paper',
    body: 'Pencil Tracer watches a physical pencil tip through your camera and turns its movement into a virtual drawing. Your paper stays blank \u2014 nothing needs to be drawn on it.',
  });
})();