/* ==========================================================================
   marker.js — Phase 3: Pencil / Marker Tracking (main-thread orchestrator)

   Responsibilities:
     - own the Web Worker running HSV blob detection (tracker-worker.js)
     - feed it downscaled camera frames every RAF tick (via camera.js'
       shared render loop, so we're not running a second timer)
     - convert results from cv-frame pixel space -> display CSS pixel space
     - run the "tap on your marker" color-calibration mini-flow
     - expose a single live value: MarkerTracker.tip = {x, y, confidence}
       in display coordinates, which calibration.js (Phase 2/4) and the
       drawing pipeline (Phase 5/6) both consume identically
   ========================================================================== */

(function () {
  'use strict';

  const overlay = document.getElementById('overlay-canvas');
  const ctx = overlay.getContext('2d');

  const state = {
    worker: null,
    workerReady: false,
    colorCalibrated: false,
    lastFrameSent: -1,
    pending: false,
    tip: { x: 0, y: 0, confidence: 0, detected: false },
    // process CV at a lower rate than the 30fps render loop -- centroid
    // tracking doesn't need every frame, and this keeps the worker from
    // ever falling behind on slower phones (Section 26: never block UI)
    processEveryNFrames: 2,
    sampleColorMode: false,
  };

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (listeners[evt] || []).forEach((fn) => fn(payload)); }

  function initWorker() {
    if (!window.Worker) {
      console.warn('[MarkerTracker] Web Workers not supported; tracking disabled.');
      return;
    }
    state.worker = new Worker('./js/workers/tracker-worker.js');
    state.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'result') {
        state.pending = false;
        handleResult(msg);
      } else if (msg.type === 'sample-result') {
        handleColorSample(msg);
      }
    };
    state.workerReady = true;
  }

  function handleResult(msg) {
    if (!msg.detected) {
      state.tip = { ...state.tip, confidence: 0, detected: false };
      emit('tip', state.tip);
      return;
    }
    const frame = window.PencilCamera.getCvFrame();
    if (!frame) return;
    const dispW = window.PencilCamera.width;
    const dispH = window.PencilCamera.height;
    const x = (msg.x / frame.canvas.width) * dispW;
    const y = (msg.y / frame.canvas.height) * dispH;

    state.tip = { x, y, confidence: msg.confidence, detected: true };
    emit('tip', state.tip);
  }

  function handleColorSample(msg) {
    const target = { h: msg.h, s: msg.s, v: msg.v };
    state.worker.postMessage({ type: 'config', target });
    state.colorCalibrated = true;
    state.sampleColorMode = false;
    overlay.style.pointerEvents = 'none';
    emit('color-calibrated', target);
  }

  /** Enters a mode where the next tap on screen samples marker color. */
  function startColorCalibration() {
    state.sampleColorMode = true;
    overlay.style.pointerEvents = 'auto';
  }

  overlay.addEventListener('pointerdown', (e) => {
    if (!state.sampleColorMode || !state.worker) return;
    const rect = overlay.getBoundingClientRect();
    const dispX = e.clientX - rect.left;
    const dispY = e.clientY - rect.top;
    sampleAt(dispX, dispY);
  });

  function sampleAt(dispX, dispY) {
    const frame = window.PencilCamera.getCvFrame();
    if (!frame) return;
    const cvX = Math.round((dispX / window.PencilCamera.width) * frame.canvas.width);
    const cvY = Math.round((dispY / window.PencilCamera.height) * frame.canvas.height);
    const patch = 10; // sample a small patch around the tap, not one pixel
    const x0 = Math.max(0, cvX - patch / 2);
    const y0 = Math.max(0, cvY - patch / 2);
    const w = Math.min(patch, frame.canvas.width - x0);
    const h = Math.min(patch, frame.canvas.height - y0);
    const imgData = frame.ctx.getImageData(x0, y0, w, h);
    state.worker.postMessage(
      { type: 'sample', buffer: imgData.data.buffer, width: w, height: h },
      [imgData.data.buffer]
    );
  }

  function onFrameTick(ts, frameNumber) {
    if (!state.workerReady || !state.colorCalibrated || state.pending) return;
    if (frameNumber - state.lastFrameSent < state.processEveryNFrames) return;

    const frame = window.PencilCamera.getCvFrame();
    if (!frame) return;

    const imgData = frame.ctx.getImageData(0, 0, frame.canvas.width, frame.canvas.height);
    state.lastFrameSent = frameNumber;
    state.pending = true;
    state.worker.postMessage(
      {
        type: 'frame',
        buffer: imgData.data.buffer,
        width: frame.canvas.width,
        height: frame.canvas.height,
        frameId: frameNumber,
      },
      [imgData.data.buffer]
    );
  }

  // ---- lightweight debug visualization of the sample-tap crosshair ----
  function renderSampleHint() {
    if (!state.sampleColorMode) return;
    // handled via hint pill text in app.js; nothing to draw here besides
    // relying on overlay's existing crosshair drawing in calibration.js
  }

  window.PencilCamera && window.PencilCamera.onFrame && window.PencilCamera.onFrame(onFrameTick);

  window.MarkerTracker = {
    init: initWorker,
    startColorCalibration,
    on,
    get colorCalibrated() { return state.colorCalibrated; },
    get tip() { return state.tip; },
  };
})();
