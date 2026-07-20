/**
 * PrecisionTarget — detection and sub-pixel calibration of the printed
 * checkerboard target (target.html) for the 1/16″ Precision mode.
 *
 * The target is an 8×5 grid of 1.000″ squares with four solid black disc
 * fiducials outside its corners. Pipeline:
 *
 *   1. findDiscQuad(): threshold + connected components on a downscaled
 *      grayscale image → candidate dark blobs → the 4-blob convex quad whose
 *      implied homography best reproduces the checkerboard pattern.
 *   2. refineTarget(): from the disc quad, predict all 28 interior X-corners,
 *      refine each to ~0.1 px with iterative gradient corner refinement
 *      (cornerSubPix), then fit a least-squares homography over them all.
 *   3. Verification is built in: the homography is re-fit on half the corners
 *      and evaluated on the held-out half, so the reported calibration error
 *      (in inches) is measured, not assumed.
 *
 * Disc assignment order/reflection is irrelevant to measured distances: any
 * consistent mapping of the quad onto the disc rectangle (long edges matched)
 * differs from the true one by an in-plane isometry, which preserves lengths.
 *
 * Pure math on {data, width, height} grayscale rasters — no DOM. Unit-tested
 * against synthetically rendered target photos in tests/precision.test.js.
 */
import { Homography } from './homography.js';

// Geometry of the printed target, in inches. Board occupies [0,8]×[0,5];
// square (i,j) = [i,i+1]×[j,j+1] is black iff i+j is even. Kept in exact
// sync with target.html.
export const TARGET = {
  cols: 8,
  rows: 5,
  squareIn: 1.0,
  discRIn: 0.3,
  discs: [
    { x: -0.6, y: -0.6 },
    { x: 8.6, y: -0.6 },
    { x: 8.6, y: 5.6 },
    { x: -0.6, y: 5.6 },
  ],
};

// The 28 interior X-corners at integer inch coordinates.
export function interiorCorners() {
  const pts = [];
  for (let y = 1; y < TARGET.rows; y++) {
    for (let x = 1; x < TARGET.cols; x++) pts.push({ x, y });
  }
  return pts;
}

export function isBlackSquare(i, j) { return (i + j) % 2 === 0; }

// ------------------------------------------------------------ disc detection

// img: {data: Uint8|Float array of grayscale 0..255, width, height}.
// Returns {discsPx: [4 {x,y}] ordered to match TARGET.discs, score} or null.
export function findDiscQuad(img) {
  const { lo, hi } = valueRange(img);
  if (hi - lo < 20) return null; // flat image — no target here
  const thr = lo + (hi - lo) * 0.45;
  const blobs = darkBlobs(img, thr);

  // Disc-likeness: right size, roughly square bbox, high fill ratio.
  const minArea = 25;
  const maxArea = (img.width * img.height) / 40;
  const candidates = blobs.filter((b) => {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    const aspect = bw / bh;
    const fill = b.area / (bw * bh);
    return b.area >= minArea && b.area <= maxArea
      && aspect > 0.45 && aspect < 2.2 && fill > 0.55;
  // Rank by disc-likeness (a filled disc's bbox fill ratio is π/4 ≈ 0.785;
  // the checkerboard's black squares sit near 1.0), not by size — otherwise
  // the 20 black squares crowd the four discs out of the candidate list.
  }).sort((a, b) => discness(a) - discness(b)).slice(0, 20);
  if (candidates.length < 4) return null;

  let best = null;
  const centers = candidates.map((b) => ({ x: b.cx, y: b.cy, area: b.area }));
  for (const quad of combinations4(centers)) {
    // Discs print identically, so wildly different blob areas mean this
    // quad mixes discs with squares/shadows — cheap reject before scoring.
    const areas = quad.map((p) => p.area);
    if (Math.max(...areas) > 5 * Math.min(...areas)) continue;
    const cand = bestOrientation(img, quad, hi - lo);
    if (cand && (!best || cand.score > best.score)) best = cand;
  }
  if (!best || best.score < 0.35) return null;
  return best;
}

// Resolve 4 roughly-tapped disc centers into TARGET.discs order (used by the
// manual fallback when auto-detection fails). Any hull cycle whose implied
// homography reproduces the checkerboard is metrically equivalent to the
// true assignment (differs by an in-plane isometry), so scoring picks safely.
export function orderDiscQuad(img, pts) {
  const { lo, hi } = valueRange(img);
  const best = bestOrientation(img, pts, hi - lo);
  return best && best.score >= 0.25 ? best : null;
}

// Try the 4 cyclic assignments of a convex quad onto TARGET.discs and keep
// the one whose homography best reproduces the checkerboard.
function bestOrientation(img, quad, range) {
  const hull = convexHullOrder(quad);
  if (!hull) return null;
  let best = null;
  for (let offset = 0; offset < 4; offset++) {
    const pts = [0, 1, 2, 3].map((i) => hull[(i + offset) % 4]);
    let H;
    try {
      H = Homography.solve(TARGET.discs, pts); // target inches -> image px
    } catch { continue; }
    const score = checkerScore(img, H, range);
    if (score != null && (!best || score > best.score)) best = { discsPx: pts, score };
  }
  return best;
}

function discness(b) {
  const fill = b.area / ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
  return Math.abs(fill - Math.PI / 4);
}

function valueRange(img) {
  // Percentile range (p2/p98) so specular highlights and deep shadow
  // don't set the contrast scale.
  const { data } = img;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[Math.max(0, Math.min(255, data[i] | 0))]++;
  const total = data.length;
  let lo = 0; let hi = 255; let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  return { lo, hi };
}

// Connected components (4-connectivity) of pixels darker than thr.
function darkBlobs(img, thr) {
  const { data, width, height } = img;
  const labels = new Int32Array(width * height); // 0 = unvisited
  const blobs = [];
  const stack = new Int32Array(width * height);
  for (let start = 0; start < data.length; start++) {
    if (labels[start] !== 0 || data[start] >= thr) continue;
    const label = blobs.length + 1;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    let area = 0; let sx = 0; let sy = 0;
    let x0 = width; let x1 = -1; let y0 = height; let y1 = -1;
    while (top > 0) {
      const idx = stack[--top];
      const x = idx % width;
      const y = (idx / width) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && labels[idx - 1] === 0 && data[idx - 1] < thr) { labels[idx - 1] = label; stack[top++] = idx - 1; }
      if (x < width - 1 && labels[idx + 1] === 0 && data[idx + 1] < thr) { labels[idx + 1] = label; stack[top++] = idx + 1; }
      if (y > 0 && labels[idx - width] === 0 && data[idx - width] < thr) { labels[idx - width] = label; stack[top++] = idx - width; }
      if (y < height - 1 && labels[idx + width] === 0 && data[idx + width] < thr) { labels[idx + width] = label; stack[top++] = idx + width; }
    }
    blobs.push({ area, cx: sx / area, cy: sy / area, x0, x1, y0, y1 });
  }
  return blobs;
}

// How well the homography's predicted checkerboard matches the image:
// contrast between sampled black-square and white-square centers, normalized
// by the image's global contrast. Wrong quads/orientations land near 0.
function checkerScore(img, H, range) {
  const { data, width, height } = img;
  let black = 0; let nBlack = 0; let white = 0; let nWhite = 0;
  for (let j = 0; j < TARGET.rows; j++) {
    for (let i = 0; i < TARGET.cols; i++) {
      const p = H.map({ x: i + 0.5, y: j + 0.5 });
      const x = Math.round(p.x); const y = Math.round(p.y);
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return null;
      const v = data[y * width + x];
      if (isBlackSquare(i, j)) { black += v; nBlack++; } else { white += v; nWhite++; }
    }
  }
  return ((white / nWhite) - (black / nBlack)) / Math.max(1, range);
}

function* combinations4(arr) {
  const n = arr.length;
  for (let a = 0; a < n - 3; a++) {
    for (let b = a + 1; b < n - 2; b++) {
      for (let c = b + 1; c < n - 1; c++) {
        for (let d = c + 1; d < n; d++) yield [arr[a], arr[b], arr[c], arr[d]];
      }
    }
  }
}

// Order 4 points around their convex hull; null if any point is inside the
// hull of the others (not a proper quad).
function convexHullOrder(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // All 4 cross products around the cycle must share a sign (strict convexity).
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p = sorted[i]; const q = sorted[(i + 1) % 4]; const r = sorted[(i + 2) % 4];
    const cr = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
    if (cr === 0) return null;
    if (sign === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return null;
  }
  return sorted;
}

// --------------------------------------------------------- sub-pixel corners

/**
 * cornerSubPix — iterative gradient refinement of an X-corner (OpenCV's
 * classic algorithm): at the true saddle point q, every image gradient g_i in
 * the window satisfies g_i · (p_i − q) = 0, giving the least-squares update
 * q = (Σ w G_i)⁻¹ Σ w G_i p_i with G_i = g_i g_iᵀ and Gaussian weights w.
 *
 * crop: grayscale raster; pt: start position in crop coords; halfWin: window
 * half-size (px). Returns refined {x, y} in crop coords, or null if the
 * window has no gradient structure or the iteration diverges.
 */
export function cornerSubPix(crop, pt, halfWin, { maxIter = 25, eps = 0.005 } = {}) {
  const { data, width, height } = crop;
  let qx = pt.x; let qy = pt.y;
  const sigma = halfWin / 2;
  for (let iter = 0; iter < maxIter; iter++) {
    let a = 0; let b = 0; let c = 0; // Σ w G  (symmetric 2×2)
    let bx = 0; let by = 0;          // Σ w G p
    const cx0 = Math.round(qx); const cy0 = Math.round(qy);
    if (cx0 < halfWin + 1 || cy0 < halfWin + 1
      || cx0 >= width - halfWin - 1 || cy0 >= height - halfWin - 1) return null;
    for (let dy = -halfWin; dy <= halfWin; dy++) {
      for (let dx = -halfWin; dx <= halfWin; dx++) {
        const x = cx0 + dx; const y = cy0 + dy;
        const idx = y * width + x;
        const gx = (data[idx + 1] - data[idx - 1]) / 2;
        const gy = (data[idx + width] - data[idx - width]) / 2;
        const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        const gxx = w * gx * gx; const gyy = w * gy * gy; const gxy = w * gx * gy;
        a += gxx; b += gxy; c += gyy;
        bx += gxx * x + gxy * y;
        by += gxy * x + gyy * y;
      }
    }
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-9) return null;
    const nx = (c * bx - b * by) / det;
    const ny = (a * by - b * bx) / det;
    const move = Math.hypot(nx - qx, ny - qy);
    qx = nx; qy = ny;
    if (move < eps) break;
  }
  if (Math.hypot(qx - pt.x, qy - pt.y) > halfWin) return null; // diverged
  return { x: qx, y: qy };
}

// ------------------------------------------------------------- refinement

/**
 * refineTarget — from the 4 detected disc centers (full-res px), refine all
 * interior X-corners to sub-pixel and fit the calibration homography.
 *
 * sampler(cx, cy, half) → grayscale crop {data, width, height, x0, y0}
 * centered on (cx, cy) at FULL photo resolution (lets the browser pull small
 * ImageData windows instead of materializing 48 MB of pixels).
 *
 * Returns { plane, usedCorners, spacingPx, calibErrIn, rmsIn } or throws.
 */
export function refineTarget(sampler, discsPx) {
  const Hwi = Homography.solve(TARGET.discs, discsPx); // inches -> image px
  const p0 = Hwi.map({ x: 3.5, y: 2.5 });
  const p1 = Hwi.map({ x: 4.5, y: 2.5 });
  const p2 = Hwi.map({ x: 3.5, y: 3.5 });
  const spacingPx = Math.min(Math.hypot(p1.x - p0.x, p1.y - p0.y), Math.hypot(p2.x - p0.x, p2.y - p0.y));
  if (!(spacingPx > 8)) {
    throw new Error('The target is too small in the photo — move closer (each square should be at least ~10 px).');
  }
  const halfWin = Math.max(4, Math.min(28, Math.round(spacingPx * 0.35)));

  const pairs = []; // {img: {x,y} full-res px, world: {x,y} inches}
  for (const w of interiorCorners()) {
    const pred = Hwi.map(w);
    const crop = sampler(pred.x, pred.y, halfWin + 6);
    if (!crop) continue;
    const local = cornerSubPix(crop, { x: pred.x - crop.x0, y: pred.y - crop.y0 }, halfWin);
    if (!local) continue;
    const img = { x: local.x + crop.x0, y: local.y + crop.y0 };
    // A refinement that ran off toward a neighboring corner is worse than
    // none; the predicted position from 4 discs is good to a fraction of a
    // square, so cap the correction at half a square.
    if (Math.hypot(img.x - pred.x, img.y - pred.y) > spacingPx * 0.5) continue;
    pairs.push({ img, world: w });
  }
  if (pairs.length < 16) {
    throw new Error(`Only ${pairs.length} of 28 target crossings were readable — improve lighting or move closer.`);
  }

  // Measured verification: fit on one half of the corners, evaluate on the
  // held-out half (both ways). This is the honest calibration error.
  const evenHalf = pairs.filter((p) => (p.world.x + p.world.y) % 2 === 0);
  const oddHalf = pairs.filter((p) => (p.world.x + p.world.y) % 2 !== 0);
  const holdoutResid = [];
  for (const [fit, evalSet] of [[evenHalf, oddHalf], [oddHalf, evenHalf]]) {
    if (fit.length < 8 || evalSet.length < 4) continue;
    const Hf = Homography.solveLS(fit.map((p) => p.img), fit.map((p) => p.world));
    for (const p of evalSet) {
      const m = Hf.map(p.img);
      holdoutResid.push(Math.hypot(m.x - p.world.x, m.y - p.world.y));
    }
  }
  if (holdoutResid.length === 0) {
    throw new Error('Not enough readable crossings to verify the calibration — retake the photo.');
  }
  const calibErrIn = percentile(holdoutResid, 95);

  const H = Homography.solveLS(pairs.map((p) => p.img), pairs.map((p) => p.world));
  let ss = 0;
  for (const p of pairs) {
    const m = H.map(p.img);
    ss += (m.x - p.world.x) ** 2 + (m.y - p.world.y) ** 2;
  }
  return {
    plane: new PrecisionPlane(H, calibErrIn),
    usedCorners: pairs.length,
    spacingPx,
    calibErrIn,
    rmsIn: Math.sqrt(ss / pairs.length),
  };
}

/**
 * PrecisionPlane — measurement on the target's plane with an honest error
 * band. Calibration error grows linearly as points leave the target (lever
 * arm); tap error scales with the local inches-per-pixel.
 */
export class PrecisionPlane {
  constructor(homography, calibErrIn) {
    this.h = homography; // image px -> inches on the target plane
    this.calibErrIn = calibErrIn;
    this.center = { x: TARGET.cols / 2, y: TARGET.rows / 2 };
    this.halfDiag = Math.hypot(TARGET.cols / 2, TARGET.rows / 2);
  }

  toWorld(px) { return this.h.map(px); }

  distance(p1, p2) {
    const a = this.toWorld(p1);
    const b = this.toWorld(p2);
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  lever(worldPt) {
    const d = Math.hypot(worldPt.x - this.center.x, worldPt.y - this.center.y);
    return Math.max(1, d / this.halfDiag);
  }

  // Local scale (inches per image pixel) around an image point.
  inPerPx(px) {
    const o = this.toWorld(px);
    const dx = this.toWorld({ x: px.x + 1, y: px.y });
    const dy = this.toWorld({ x: px.x, y: px.y + 1 });
    return (Math.hypot(dx.x - o.x, dx.y - o.y) + Math.hypot(dy.x - o.x, dy.y - o.y)) / 2;
  }

  // ~p95 error band (inches) for the distance between two tapped points.
  // tapSigmaPx: expected tap noise (loupe-refined taps ≈ 0.5 px).
  band(p1, p2, tapSigmaPx = 0.5) {
    const w1 = this.toWorld(p1);
    const w2 = this.toWorld(p2);
    const calibTerm = this.calibErrIn * (this.lever(w1) + this.lever(w2));
    // Tap noise is local (no lever): two independent taps of σ px, ~p95.
    const tapTerm = 2.8 * tapSigmaPx * Math.max(this.inPerPx(p1), this.inPerPx(p2));
    return calibTerm + tapTerm;
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
