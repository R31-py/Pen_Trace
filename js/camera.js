/* ==========================================================================
   camera.js — Phase 1: Camera
   Responsibilities:
     - request rear camera with sane fallbacks
     - keep the video preview filling the screen, stable across rotation
     - keep every canvas layer pixel-matched to the video's displayed size
     - own a single requestAnimationFrame loop that later phases (CV
       tracking, brush rendering, overlay drawing) hook into, so we only
       ever have one render clock for the whole app
   Exposes: window.PencilCamera
   ========================================================================== */

(function () {
  'use strict';

  const video = document.getElementById('camera-video');
  const canvases = {
    draw: document.getElementById('draw-canvas'),
    reference: document.getElementById('reference-canvas'),
    overlay: document.getElementById('overlay-canvas'),
  };

  const state = {
    stream: null,
    facingMode: 'environment',
    running: false,
    // displayed size (CSS px) vs backing store size (device px)
    width: 0,
    height: 0,
    dpr: Math.min(window.devicePixelRatio || 1, 2), // cap DPR: perf > crispness
    // low-res frame used for CV (Phase 3+), decoupled from the HD preview
    cvWidth: 320,
    cvHeight: 240,
    frameCallbacks: [], // fn(timestampMs, frameNumber)
    frameNumber: 0,
    lastFrameTime: 0,
    fps: 0,
    _fpsSamples: [],
  };

  function pickConstraints(facingMode) {
    return {
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    };
  }

  async function requestStream(facingMode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('NOT_SUPPORTED');
    }
    try {
      return await navigator.mediaDevices.getUserMedia(pickConstraints(facingMode));
    } catch (err) {
      // Fallback: some devices reject 'ideal' facingMode combined with
      // resolution constraints. Retry with a looser request before giving up.
      if (facingMode === 'environment') {
        try {
          return await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: 'environment' },
          });
        } catch (err2) {
          throw err2;
        }
      }
      throw err;
    }
  }

  async function start() {
    const stream = await requestStream(state.facingMode);
    state.stream = stream;
    video.srcObject = stream;

    await new Promise((resolve) => {
      if (video.readyState >= 2) return resolve();
      video.onloadedmetadata = () => resolve();
    });

    await video.play();

    resizeToViewport();
    window.addEventListener('resize', resizeToViewport);
    window.addEventListener('orientationchange', () => {
      // orientation change fires before layout settles on some browsers
      setTimeout(resizeToViewport, 60);
      setTimeout(resizeToViewport, 300);
    });

    state.running = true;
    requestAnimationFrame(loop);

    return getActiveTrackSettings();
  }

  function stop() {
    state.running = false;
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
  }

  async function switchCamera() {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    stop();
    return start();
  }

  function getActiveTrackSettings() {
    if (!state.stream) return null;
    const track = state.stream.getVideoTracks()[0];
    return track ? track.getSettings() : null;
  }

  function resizeToViewport() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    state.width = w;
    state.height = h;

    Object.values(canvases).forEach((canvas) => {
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      canvas.width = Math.round(w * state.dpr);
      canvas.height = Math.round(h * state.dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    });

    emit('resize', { width: w, height: h });
  }

  // ---- lightweight pub/sub so later phases don't need to touch this file ----
  const listeners = {};
  function on(event, fn) {
    (listeners[event] = listeners[event] || []).push(fn);
  }
  function emit(event, payload) {
    (listeners[event] || []).forEach((fn) => fn(payload));
  }

  function onFrame(fn) {
    state.frameCallbacks.push(fn);
  }

  function loop(ts) {
    if (!state.running) return;

    state.frameNumber++;
    if (state.lastFrameTime) {
      const dt = ts - state.lastFrameTime;
      state._fpsSamples.push(1000 / dt);
      if (state._fpsSamples.length > 30) state._fpsSamples.shift();
      state.fps = Math.round(
        state._fpsSamples.reduce((a, b) => a + b, 0) / state._fpsSamples.length
      );
    }
    state.lastFrameTime = ts;

    for (const cb of state.frameCallbacks) {
      try {
        cb(ts, state.frameNumber);
      } catch (e) {
        console.error('[PencilCamera] frame callback error', e);
      }
    }

    requestAnimationFrame(loop);
  }

  /**
   * Draws the current video frame into an offscreen low-res canvas for CV
   * consumption (Phase 3+). Crops using the same object-fit:cover math as
   * the on-screen <video> element, so a point at (x,y) in this cv frame
   * maps to (x/cvWidth*displayWidth, y/cvHeight*displayHeight) on screen
   * with NO further offset correction needed.
   */
  let cvCanvas = null;
  function getCvFrame() {
    if (!cvCanvas) {
      cvCanvas = document.createElement('canvas');
      cvCanvas.width = state.cvWidth;
      cvCanvas.height = state.cvHeight;
    }
    const ctx = cvCanvas.getContext('2d', { willReadFrequently: true });
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !state.width || !state.height) return null;

    // object-fit: cover crop rectangle within the source video
    const videoAspect = vw / vh;
    const dispAspect = state.width / state.height;
    let sx, sy, sw, sh;
    if (videoAspect > dispAspect) {
      // video is wider than display: crop left/right
      sh = vh;
      sw = vh * dispAspect;
      sx = (vw - sw) / 2;
      sy = 0;
    } else {
      // video is taller than display: crop top/bottom
      sw = vw;
      sh = vw / dispAspect;
      sx = 0;
      sy = (vh - sh) / 2;
    }

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, state.cvWidth, state.cvHeight);
    return { canvas: cvCanvas, ctx, cropX: sx, cropY: sy, cropW: sw, cropH: sh };
  }

  window.PencilCamera = {
    start,
    stop,
    switchCamera,
    onFrame,
    on,
    getCvFrame,
    getActiveTrackSettings,
    canvases,
    video,
    get width() { return state.width; },
    get height() { return state.height; },
    get dpr() { return state.dpr; },
    get fps() { return state.fps; },
    get frameNumber() { return state.frameNumber; },
  };
})();
