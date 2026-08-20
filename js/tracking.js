/* ==========================================================================
   tracking.js — Phase 5: Tracking

   Bridges Phase 3 (raw pencil-tip detection in display px) and Phase 4
   (the homography) into one continuous, smoothed stream of normalized
   paper coordinates that Phase 6+ (the brush engine) can draw from.

   Pipeline per frame:
     raw tip (display px, from marker.js)
       -> normalized paper coords (via Calibration.cameraToNormalized)
       -> exponential smoothing (Section 7: low latency, low jitter)
       -> confidence-gated "pen up / pen down" state
       -> Tracking.point exposed to the rest of the app

   Also owns the overlay canvas once calibration is complete: draws the
   live tip cursor with the state colors from Section 19, and (in debug
   mode) the paper-space alignment grid.
   ========================================================================== */

(function () {
  'use strict';

  const overlay = document.getElementById('overlay-canvas');
  const ctx = overlay.getContext('2d');

  // Confidence thresholds
  const CONF_GOOD = 0.55;
  const CONF_WARN = 0.3;
  const LOST_TIMEOUT_MS = 250; // how long we tolerate a dropped detection
                                 // before declaring "not tracking" (keeps
                                 // single-frame misses from lifting the pen)

  const state = {
    enabled: false,
    normalized: null,     // {x, y} smoothed, in 0..1 paper space
    display: null,        // same point projected back to display px, for cursor rendering
    confidence: 0,
    tracking: false,       // "pen down" - true while we trust the position
    lastGoodTime: 0,
    lastTs: 0,
    smoothed: null,        // internal EMA state, normalized space
    held: false,           // finger is currently pressed on the screen: suppress
                            // all tracking/reacquisition until it's released
                            // (see holdLift() below)
  };

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (listeners[evt] || []).forEach((fn) => fn(payload)); }

  /**
   * Confidence-adaptive exponential smoothing. Low confidence or a large
   * jump (likely a mis-detection) gets smoothed harder; a steady, confident
   * signal is allowed to track almost immediately (low latency per Section 7).
   */
  function smooth(prev, next, confidence, dtMs) {
    if (!prev) return { ...next };
    const dist = Math.hypot(next.x - prev.x, next.y - prev.y);

    // base time-constant: faster response at high confidence
    const tau = confidence > CONF_GOOD ? 40 : confidence > CONF_WARN ? 90 : 160;
    let alpha = 1 - Math.exp(-dtMs / tau);

    // Large sudden jumps in normalized space (>0.15 of the paper) are more
    // likely noise/false-positive than real fast motion; damp them instead
    // of snapping, but don't fully ignore real fast strokes.
    if (dist > 0.15) alpha = Math.min(alpha, 0.35);

    alpha = Math.max(0.05, Math.min(1, alpha));
    return {
      x: prev.x + (next.x - prev.x) * alpha,
      y: prev.y + (next.y - prev.y) * alpha,
    };
  }

  function handleTip(tip, ts) {
    if (!state.enabled) return;
    if (!window.Calibration || !window.Calibration.isCalibrated) return;
    if (state.held) return; // finger is down on the screen \u2014 stay lifted

    const now = ts || performance.now();
    const dt = state.lastTs ? now - state.lastTs : 16;
    state.lastTs = now;

    if (!tip.detected || tip.confidence < 0.12) {
      // no usable detection this frame
      if (state.tracking && now - state.lastGoodTime > LOST_TIMEOUT_MS) {
        state.tracking = false;
        state.confidence = 0;
        emit('lost');
      }
      return;
    }

    const norm = window.Calibration.cameraToNormalized(tip.x, tip.y);
    if (!norm) return;

    // Points wildly outside the paper (way beyond 0..1) are almost always
    // marker false-positives near the frame edge - ignore rather than
    // let them yank the smoothed position off the page.
    const margin = 0.4;
    if (norm.x < -margin || norm.x > 1 + margin || norm.y < -margin || norm.y > 1 + margin) {
      return;
    }

    state.smoothed = smooth(state.smoothed, norm, tip.confidence, dt);
    state.normalized = { ...state.smoothed };
    state.confidence = tip.confidence;
    state.lastGoodTime = now;

    if (!state.tracking) emit('acquired');
    state.tracking = true;

    const back = window.Calibration.normalizedToCamera(state.smoothed.x, state.smoothed.y);
    state.display = back;

    emit('point', {
      x: state.normalized.x,
      y: state.normalized.y,
      confidence: state.confidence,
      display: state.display,
    });
  }

  function enable() {
    state.enabled = true;
    state.smoothed = null; // don't carry stale smoothing state across sessions
  }
  function disable() {
    state.enabled = false;
    state.tracking = false;
  }

  /** Manual pen-lift: the camera can't tell "touching paper" from "hovering
   *  above it" on its own, so a finger held on the screen is used as an
   *  explicit lift signal for as long as it's held. Reacquisition (and a
   *  fresh stroke) only happens once the finger is lifted off the *screen*
   *  \u2014 while held, handleTip() bails out early (see state.held above)
   *  so the marker can't sneak back in and resume the old stroke. */
  function holdLift(active) {
    state.held = !!active;
    if (state.held) {
      // wipe smoothing state so we don't ease/interpolate from the old
      // (pre-lift) position toward wherever the pencil is on release \u2014
      // that carry-over is what drew a spurious connecting line
      state.smoothed = null;
      if (state.tracking) {
        state.tracking = false;
        state.confidence = 0;
        emit('lost');
      }
    }
  }

  window.MarkerTracker && window.MarkerTracker.on && window.MarkerTracker.on('tip', (tip) => handleTip(tip, performance.now()));

  // ---- overlay rendering: live cursor + optional debug grid ----
  function render() {
    if (!state.enabled) return;
    if (window.Calibration && window.Calibration.active) return; // calibration owns overlay right now

    ctx.clearRect(0, 0, overlay.width / window.PencilCamera.dpr, overlay.height / window.PencilCamera.dpr);

    if (window.App && window.App.debug && window.Calibration && window.Calibration.isCalibrated) {
      drawDebugGrid();
    }

    if (state.tracking && state.display) {
      drawCursor(state.display, state.confidence);
    }
  }

  function drawDebugGrid() {
    ctx.save();
    ctx.strokeStyle = 'rgba(214,255,63,0.35)';
    ctx.lineWidth = 1;
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = window.Calibration.normalizedToCamera(t, 0);
      const b = window.Calibration.normalizedToCamera(t, 1);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const c = window.Calibration.normalizedToCamera(0, t);
      const d = window.Calibration.normalizedToCamera(1, t);
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawCursor(p, confidence) {
    let color;
    const tracingState = window.Tracing && window.Tracing.feedbackState;
    if (tracingState) {
      color = tracingState === 'on' ? '#3fe08a' : tracingState === 'near' ? '#f0b429' : '#ef5350';
    } else {
      color = confidence > CONF_GOOD ? '#3fe08a' : confidence > CONF_WARN ? '#f0b429' : '#ef5350';
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  window.PencilCamera && window.PencilCamera.onFrame && window.PencilCamera.onFrame(render);

  window.Tracking = {
    enable,
    disable,
    holdLift,
    on,
    get point() { return state.normalized; },
    get isTracking() { return state.tracking; },
    get confidence() { return state.confidence; },
  };
})();