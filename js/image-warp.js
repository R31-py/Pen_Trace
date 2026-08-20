/* ==========================================================================
   image-warp.js — Phase 9 helper: perspective-correct image warping

   Canvas 2D's drawImage only supports affine transforms, but our paper
   mapping (the homography from Phase 4) is a full perspective transform.
   The standard workaround: subdivide the source image into a fine grid,
   treat each cell as two triangles, and affine-warp each triangle
   individually via ctx.transform(). Fine enough subdivision looks
   perspective-correct to the eye.

   Generic utility (image, a UV->destination mapping function) so it can
   warp the reference image now (Phase 9) and other bitmap content later
   without duplicating the math.
   ========================================================================== */

(function () {
  'use strict';

  /** Affine-warp the triangle (s0,s1,s2) of `img` onto (d0,d1,d2) of ctx. */
  function drawTriangle(ctx, img, s0, s1, s2, d0, d1, d2) {
    const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(denom) < 1e-6) return;

    const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
    const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
    const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
    const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
    const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denom;
    const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denom;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(d0.x, d0.y);
    ctx.lineTo(d1.x, d1.y);
    ctx.lineTo(d2.x, d2.y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  /**
   * Warps `img` onto ctx using a grid of `gridN x gridN` cells.
   * @param {CanvasRenderingContext2D} ctx  destination context
   * @param {CanvasImageSource} img         source image/canvas
   * @param {(u:number, v:number) => {x,y}} mapUV
   *   maps a source UV in [0,1]x[0,1] to a destination point in ctx's own
   *   coordinate space. This is where the caller plugs in "placement
   *   transform + homography" without image-warp.js knowing anything
   *   about paper coordinates.
   * @param {number} gridN  subdivisions per axis (higher = smoother, slower)
   */
  function warpImage(ctx, img, mapUV, gridN) {
    const w = img.width, h = img.height;
    const n = gridN || 14;

    const dst = [];
    for (let gy = 0; gy <= n; gy++) {
      const row = [];
      for (let gx = 0; gx <= n; gx++) row.push(mapUV(gx / n, gy / n));
      dst.push(row);
    }

    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) {
        const su0 = (gx / n) * w, sv0 = (gy / n) * h;
        const su1 = ((gx + 1) / n) * w, sv1 = ((gy + 1) / n) * h;

        const s00 = { x: su0, y: sv0 };
        const s10 = { x: su1, y: sv0 };
        const s01 = { x: su0, y: sv1 };
        const s11 = { x: su1, y: sv1 };

        const d00 = dst[gy][gx];
        const d10 = dst[gy][gx + 1];
        const d01 = dst[gy + 1][gx];
        const d11 = dst[gy + 1][gx + 1];

        drawTriangle(ctx, img, s00, s10, s01, d00, d10, d01);
        drawTriangle(ctx, img, s10, s11, s01, d10, d11, d01);
      }
    }
  }

  window.ImageWarp = { warpImage };
})();
