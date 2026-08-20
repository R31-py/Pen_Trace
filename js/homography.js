/* ==========================================================================
   homography.js — Phase 4: Perspective Transformation math

   Solves the 3x3 homography matrix mapping 4 source points to 4
   destination points using the Direct Linear Transform (DLT) method,
   fixing h33 = 1 (valid whenever no correspondence sends a finite point
   to infinity, which is always true for our 4-corner paper calibration).

   No external dependency (no OpenCV.js) \u2014 this is ~40 lines of linear
   algebra and keeps the offline PWA bundle small.

   Matrix convention: 3x3, row-major, flat array of 9 numbers.
     [ h0 h1 h2 ]   [x]   [x']
     [ h3 h4 h5 ] * [y] ~ [y']   (up to scale; divide by w' below)
     [ h6 h7 1  ]   [1]   [w']
   ========================================================================== */

(function () {
  'use strict';

  /** Solve an 8x8 linear system Ax=b via Gaussian elimination with partial pivoting. */
  function solveLinearSystem(A, b) {
    const n = 8;
    // augment
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
      // partial pivot
      let pivotRow = col;
      let maxVal = Math.abs(M[col][col]);
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > maxVal) {
          maxVal = Math.abs(M[r][col]);
          pivotRow = r;
        }
      }
      if (maxVal < 1e-10) return null; // degenerate (collinear / duplicate points)
      [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

      const pivot = M[col][col];
      for (let c = col; c <= n; c++) M[col][c] /= pivot;

      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col];
        if (factor === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    return M.map((row) => row[n]);
  }

  /**
   * @param {{x,y}[]} src four source points
   * @param {{x,y}[]} dst four destination points, same order
   * @returns {number[9]|null} flat 3x3 homography, or null if degenerate
   */
  function computeHomography(src, dst) {
    if (src.length !== 4 || dst.length !== 4) return null;

    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i];
      const { x: xp, y: yp } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x * xp, -y * xp]);
      b.push(xp);
      A.push([0, 0, 0, x, y, 1, -x * yp, -y * yp]);
      b.push(yp);
    }

    const h = solveLinearSystem(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  /** Applies H to point (x,y), returns {x, y} after perspective divide. */
  function applyHomography(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
    return {
      x: (H[0] * x + H[1] * y + H[2]) / w,
      y: (H[3] * x + H[4] * y + H[5]) / w,
    };
  }

  /** Full 3x3 matrix inverse (needed since H isn't the simple fixed-h33 form once inverted). */
  function invert3x3(H) {
    const [a, b, c, d, e, f, g, h, i] = H;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const D = -(b * i - c * h);
    const E = a * i - c * g;
    const F = -(a * h - b * g);
    const G = b * f - c * e;
    const Hh = -(a * f - c * d);
    const I = a * e - b * d;

    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;

    const invDet = 1 / det;
    return [
      A * invDet, D * invDet, G * invDet,
      B * invDet, E * invDet, Hh * invDet,
      C * invDet, F * invDet, I * invDet,
    ];
  }

  window.Homography = { computeHomography, applyHomography, invert3x3 };
})();
