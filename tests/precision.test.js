/**
 * Precision mode: full-pipeline accuracy proof on synthetically rendered
 * photos of the printed target.
 *
 * A pinhole camera photographs the checkerboard target taped to a wall; the
 * scene is rasterized (supersampled, so edges are antialiased like a real
 * sensor). The REAL pipeline then runs on the pixels: disc detection on a
 * downscaled copy → sub-pixel corner refinement at full res → least-squares
 * homography → measurement. Ground truth is exact, so the 1/16″ claim is
 * tested end to end, including loupe-level tap noise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Homography } from '../js/homography.js';
import {
  TARGET, findDiscQuad, refineTarget, cornerSubPix, interiorCorners, isBlackSquare,
} from '../js/target.js';
import { PinholeCamera, seededRandom, jitter, percentile } from './helpers.js';

const SIXTEENTH = 1 / 16;
const IMG_W = 1600;
const IMG_H = 1200;

// Board plane (z=0), board coords (inches, y down on the paper) -> 3D world.
const boardToWorld = (b) => [b.x - TARGET.cols / 2, TARGET.rows / 2 - b.y, 0];

function makeCamera({ eye = [4, -3, 48], target = [0, 0, 0], f = 2300 } = {}) {
  return new PinholeCamera({ eye, target, f, cx: IMG_W / 2, cy: IMG_H / 2 });
}

// Exact image-px -> board-inches homography from the camera (pinhole imaging
// of a plane IS a homography, so 4 correspondences pin it exactly).
function exactImageToBoard(cam) {
  const world = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }];
  const img = world.map((b) => cam.project(boardToWorld(b)));
  return Homography.solve(img, world);
}

// Scene color at a board-plane point (inches): the paper with its
// checkerboard and discs, a gray wall, and a dark distractor rectangle
// (a "doorway") that detection must reject.
function sceneColor(b) {
  for (const d of TARGET.discs) {
    if (Math.hypot(b.x - d.x, b.y - d.y) <= TARGET.discRIn) return 25;
  }
  if (b.x >= 0 && b.x <= TARGET.cols && b.y >= 0 && b.y <= TARGET.rows) {
    return isBlackSquare(Math.floor(Math.min(b.x, TARGET.cols - 1e-9)), Math.floor(Math.min(b.y, TARGET.rows - 1e-9))) ? 25 : 235;
  }
  if (b.x >= -1.5 && b.x <= 9.5 && b.y >= -1.75 && b.y <= 6.75) return 235; // paper margin
  if (b.x >= 13 && b.x <= 17 && b.y >= -1 && b.y <= 5) return 45; // distractor
  return 150; // wall
}

// Rasterize the full photo (3x3 supersampling).
function renderPhoto(cam) {
  const Hib = exactImageToBoard(cam);
  const data = new Float32Array(IMG_W * IMG_H);
  const S = 3;
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      let acc = 0;
      // Pixel index (x, y) is a point sample at continuous (x, y): average
      // over the half-open pixel footprint centered there.
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const b = Hib.map({ x: x + (sx + 0.5) / S - 0.5, y: y + (sy + 0.5) / S - 0.5 });
          acc += sceneColor(b);
        }
      }
      data[y * IMG_W + x] = acc / (S * S);
    }
  }
  return { data, width: IMG_W, height: IMG_H };
}

// Area-average downscale by an integer factor (what the app does for
// detection).
function downscale(img, k) {
  const w = Math.floor(img.width / k);
  const h = Math.floor(img.height / k);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) acc += img.data[(y * k + dy) * img.width + (x * k + dx)];
      }
      data[y * w + x] = acc / (k * k);
    }
  }
  return { data, width: w, height: h };
}

// Full-res crop sampler over the rendered photo (the app's canvas-backed
// sampler mirrors this shape).
function makeSampler(img) {
  return (cx, cy, half) => {
    const x0 = Math.max(0, Math.round(cx - half));
    const y0 = Math.max(0, Math.round(cy - half));
    const x1 = Math.min(img.width, Math.round(cx + half));
    const y1 = Math.min(img.height, Math.round(cy + half));
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    const w = x1 - x0;
    const h = y1 - y0;
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) data[y * w + x] = img.data[(y0 + y) * img.width + (x0 + x)];
    }
    return { data, width: w, height: h, x0, y0 };
  };
}

// Run detection + refinement on a rendered photo, returning the calibrated
// plane plus the camera for projecting test points.
function calibrate(camOpts) {
  const cam = makeCamera(camOpts);
  const photo = renderPhoto(cam);
  const K = 2;
  const found = findDiscQuad(downscale(photo, K));
  assert.ok(found, 'disc quad not found');
  // Downscaled pixel p averages full-res samples pK..pK+K-1, centered at
  // pK + (K-1)/2.
  const discsFull = found.discsPx.map((p) => ({ x: p.x * K + (K - 1) / 2, y: p.y * K + (K - 1) / 2 }));
  const result = refineTarget(makeSampler(photo), discsFull);
  return { cam, ...result };
}

test('solveLS matches solve() on exact 4 points and beats it on noisy 28', () => {
  const src = [{ x: 10, y: 20 }, { x: 400, y: 30 }, { x: 380, y: 300 }, { x: 20, y: 280 }];
  const dst = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }];
  const a = Homography.solve(src, dst);
  const b = Homography.solveLS(src, dst);
  for (const p of [{ x: 100, y: 100 }, { x: 300, y: 250 }]) {
    const ma = a.map(p);
    const mb = b.map(p);
    assert.ok(Math.hypot(ma.x - mb.x, ma.y - mb.y) < 1e-9);
  }

  const cam = makeCamera();
  const Hib = exactImageToBoard(cam);
  const Hbi = (() => {
    const world = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }];
    return Homography.solve(world, world.map((w) => cam.project(boardToWorld(w))));
  })();
  const corners = interiorCorners();
  const probe = Hbi.map({ x: -8, y: 2.5 });
  // 4 extreme interior corners (indices of (1,1),(7,1),(1,4),(7,4)).
  const pick = [0, 6, 21, 27];
  let sumLS = 0; let sum4 = 0;
  const TRIALS = 25;
  const rand = seededRandom(7);
  for (let t = 0; t < TRIALS; t++) {
    const imgNoisy = corners.map((w) => jitter(Hbi.map(w), 0.3, rand));
    const ls = Homography.solveLS(imgNoisy, corners);
    const four = Homography.solve(pick.map((i) => imgNoisy[i]), pick.map((i) => corners[i]));
    sumLS += Math.hypot(ls.map(probe).x - -8, ls.map(probe).y - 2.5);
    sum4 += Math.hypot(four.map(probe).x - -8, four.map(probe).y - 2.5);
  }
  assert.ok(sumLS < sum4, `LS mean ${sumLS / TRIALS} should beat 4-pt mean ${sum4 / TRIALS}`);
  assert.ok(sumLS / TRIALS < 0.05, `LS extrapolation error ${sumLS / TRIALS}"`);
  void Hib;
});

test('cornerSubPix recovers a synthetic saddle to ~0.1 px', () => {
  // Render a small tilted checkerboard crossing with a known sub-pixel center.
  const w = 64;
  const truth = { x: 31.63, y: 32.27 };
  const th = 0.3;
  const data = new Float32Array(w * w);
  const S = 4;
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S - 0.5 - truth.x;
          const py = y + (sy + 0.5) / S - 0.5 - truth.y;
          const u = px * Math.cos(th) + py * Math.sin(th);
          const v = -px * Math.sin(th) + py * Math.cos(th);
          acc += (u * v >= 0) ? 235 : 25;
        }
      }
      data[y * w + x] = acc / (S * S);
    }
  }
  const r = cornerSubPix({ data, width: w, height: w }, { x: 30.2, y: 33.4 }, 10);
  assert.ok(r, 'refinement failed');
  // 0.1 px at typical target scale (~0.02"/px) is 0.002" — 3% of the budget.
  const err = Math.hypot(r.x - truth.x, r.y - truth.y);
  assert.ok(err < 0.1, `saddle error ${err.toFixed(4)} px`);
});

test('detection + refinement: calibration verified well under 1/16" at the board', () => {
  const { usedCorners, calibErrIn, rmsIn } = calibrate({});
  assert.ok(usedCorners >= 24, `only ${usedCorners}/28 corners`);
  assert.ok(calibErrIn < SIXTEENTH / 4, `holdout calibration error ${calibErrIn.toFixed(4)}"`);
  assert.ok(rmsIn < SIXTEENTH / 4, `fit RMS ${rmsIn.toFixed(4)}"`);
});

test('END TO END: 26" span measured to 1/16" p95 with loupe taps, honest band', () => {
  const { cam, plane } = calibrate({});
  const A = { x: -9, y: 2.5 };
  const B = { x: 17, y: 2.5 };
  const trueIn = Math.hypot(B.x - A.x, B.y - A.y);
  const pa = cam.project(boardToWorld(A));
  const pb = cam.project(boardToWorld(B));

  const rand = seededRandom(20260720);
  const errs = [];
  for (let i = 0; i < 300; i++) {
    errs.push(Math.abs(plane.distance(jitter(pa, 0.5, rand), jitter(pb, 0.5, rand)) - trueIn));
  }
  const p95 = percentile(errs, 95);
  assert.ok(p95 < SIXTEENTH, `p95 ${p95.toFixed(4)}" exceeds 1/16"`);
  const band = plane.band(pa, pb, 0.5);
  assert.ok(band >= p95 * 0.85, `band ${band.toFixed(4)}" understates measured p95 ${p95.toFixed(4)}"`);
  assert.ok(band < 2 * SIXTEENTH, `band ${band.toFixed(4)}" too pessimistic to ever verify`);
});

test('a second camera pose (steeper angle) also holds 1/16"', () => {
  const { cam, plane } = calibrate({ eye: [-8, 5, 42], target: [1, 0, 0], f: 2300 });
  const A = { x: -6, y: 0 };
  const B = { x: 14, y: 5 };
  const trueIn = Math.hypot(B.x - A.x, B.y - A.y);
  const pa = cam.project(boardToWorld(A));
  const pb = cam.project(boardToWorld(B));
  const rand = seededRandom(99);
  const errs = [];
  for (let i = 0; i < 300; i++) {
    errs.push(Math.abs(plane.distance(jitter(pa, 0.5, rand), jitter(pb, 0.5, rand)) - trueIn));
  }
  const p95 = percentile(errs, 95);
  assert.ok(p95 < SIXTEENTH, `p95 ${p95.toFixed(4)}" exceeds 1/16"`);
});

test('the band flags far-away spans instead of pretending 1/16"', () => {
  const { cam, plane } = calibrate({});
  // Endpoints ~3 board-diagonals out: still measurable, but the band must
  // grow past 1/16" so the UI reports "not verified" rather than lying.
  const A = { x: -14, y: 2.5 };
  const B = { x: 22, y: 2.5 };
  const pa = cam.project(boardToWorld(A));
  const pb = cam.project(boardToWorld(B));
  const nearBand = plane.band(cam.project(boardToWorld({ x: 0, y: 2.5 })), cam.project(boardToWorld({ x: 8, y: 2.5 })), 0.5);
  const farBand = plane.band(pa, pb, 0.5);
  assert.ok(farBand > nearBand, 'band should grow with distance from the target');
});
