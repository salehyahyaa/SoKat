import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SingleViewMetrology, rectangleMetrology } from '../js/metrology.js';
import { PinholeCamera, paperOnFloor, seededRandom, jitter, percentile } from './helpers.js';

// World frame: y up, floor at y=0. The closet's back wall is at z=0, opening
// toward +z; camera stands in front of the closet at eye height.
// Plane coords for the metrology: (x, z) on the floor.

const IMG_W = 4032;
const IMG_H = 3024;

function scene({ W = 40, H = 84, D = 28, eye = [15, 62, 95], target = [0, 30, 0], f = 2900 }) {
  const cam = new PinholeCamera({ eye, target, f, cx: IMG_W / 2, cy: IMG_H / 2 });
  const paper3d = paperOnFloor(3, D / 2 + 6); // flat on the floor, mid-closet
  const px = (p) => cam.project(p);
  return {
    cam,
    paper: paper3d.map(px),
    backLeft: px([-W / 2, 0, 0]),
    backRight: px([W / 2, 0, 0]),
    frontLeft: px([-W / 2, 0, D]),
    frontRight: px([W / 2, 0, D]),
    topLeft: px([-W / 2, H, 0]),
    topRight: px([W / 2, H, 0]),
    truth: { W, H, D },
  };
}

test('single photo: width & depth exact on the floor plane', () => {
  const s = scene({});
  const m = new SingleViewMetrology(s.paper, IMG_W, IMG_H);
  assert.ok(Math.abs(m.distance(s.backLeft, s.backRight) - s.truth.W) < 1e-6);
  assert.ok(Math.abs(m.distance(s.frontLeft, s.frontRight) - s.truth.W) < 1e-6);
  assert.ok(Math.abs(m.distance(s.backLeft, s.frontLeft) - s.truth.D) < 1e-6);
  assert.ok(Math.abs(m.distance(s.backRight, s.frontRight) - s.truth.D) < 1e-6);
});

test('single photo: recovered focal length matches the camera', () => {
  const s = scene({});
  const m = new SingleViewMetrology(s.paper, IMG_W, IMG_H);
  assert.ok(Math.abs(m.f - 2900) / 2900 < 1e-6, `f=${m.f}`);
});

test('single photo: height recovered from camera pose, exact on clean taps', () => {
  const s = scene({});
  const m = new SingleViewMetrology(s.paper, IMG_W, IMG_H);
  const hL = m.wallHeight(s.backLeft, s.backRight, s.topLeft);
  const hR = m.wallHeight(s.backLeft, s.backRight, s.topRight);
  assert.ok(Math.abs(hL - s.truth.H) < 1e-6, `heightLeft=${hL}`);
  assert.ok(Math.abs(hR - s.truth.H) < 1e-6, `heightRight=${hR}`);
});

test('single photo: exact across camera positions and closet sizes', () => {
  const cases = [
    { W: 24, H: 96, D: 24, eye: [-10, 58, 70], target: [0, 40, 0] },
    { W: 72, H: 84, D: 30, eye: [20, 66, 120], target: [-5, 25, 0] },
    { W: 36, H: 90, D: 20, eye: [0, 55, 60], target: [3, 45, 5], f: 3200 },
  ];
  for (const c of cases) {
    const s = scene(c);
    const m = new SingleViewMetrology(s.paper, IMG_W, IMG_H);
    assert.ok(Math.abs(m.distance(s.backLeft, s.backRight) - c.W) < 1e-6);
    assert.ok(Math.abs(m.distance(s.backLeft, s.frontLeft) - c.D) < 1e-6);
    const h = m.wallHeight(s.backLeft, s.backRight, s.topLeft);
    assert.ok(Math.abs(h - c.H) < 1e-6, `H=${h} vs ${c.H} for ${JSON.stringify(c)}`);
  }
});

test('exif focal is used when provided, recovered otherwise', () => {
  const s = scene({});
  const withExif = new SingleViewMetrology(s.paper, IMG_W, IMG_H, { focalPx: 2900 });
  assert.equal(withExif.focalSource, 'exif');
  assert.equal(withExif.f, 2900);
  const without = new SingleViewMetrology(s.paper, IMG_W, IMG_H);
  assert.equal(without.focalSource, 'homography');
});

// Tap-noise envelope for the single-photo mode — this is the documented,
// honest accuracy of Quick Scan (σ=0.75 px loupe-assisted taps, paired
// readings averaged like the app reports). Width/depth ride only on the
// floor homography; height additionally rides on the camera pose, which is
// why the EXIF focal matters and why Quick Scan is labeled ±1/2″ / ±1½″
// rather than 1/16″ (Precision Scan keeps the 1/16″ pipeline).
test('quick-scan noise envelope: W/D ≤ ~1/2", H ≤ ~2" with EXIF focal', () => {
  const rand = seededRandom(20260715);
  const SIGMA = 0.75;
  const wErr = []; const dErr = []; const hErr = []; const hErrNoExif = [];
  for (let i = 0; i < 400; i++) {
    const s = scene({});
    const j = (p) => jitter(p, SIGMA, rand);
    const paper = s.paper.map(j);
    const m = new SingleViewMetrology(paper, IMG_W, IMG_H, { focalPx: 2900 });
    const mNoExif = new SingleViewMetrology(paper, IMG_W, IMG_H);
    const bl = j(s.backLeft); const br = j(s.backRight);
    const fl = j(s.frontLeft); const fr = j(s.frontRight);
    const tl = j(s.topLeft); const tr = j(s.topRight);
    wErr.push(Math.abs((m.distance(bl, br) + m.distance(fl, fr)) / 2 - s.truth.W));
    dErr.push(Math.abs((m.distance(bl, fl) + m.distance(br, fr)) / 2 - s.truth.D));
    hErr.push(Math.abs((m.wallHeight(bl, br, tl) + m.wallHeight(bl, br, tr)) / 2 - s.truth.H));
    hErrNoExif.push(Math.abs((mNoExif.wallHeight(bl, br, tl) + mNoExif.wallHeight(bl, br, tr)) / 2 - s.truth.H));
  }
  assert.ok(percentile(wErr, 95) < 0.75, `width p95 ${percentile(wErr, 95).toFixed(3)}"`);
  assert.ok(percentile(dErr, 95) < 0.5, `depth p95 ${percentile(dErr, 95).toFixed(3)}"`);
  assert.ok(percentile(hErr, 95) < 2.5, `height p95 (exif) ${percentile(hErr, 95).toFixed(3)}"`);
  // Fallback path is usable but visibly worse — the UI labels it approximate.
  assert.ok(percentile(hErrNoExif, 95) < 15, `height p95 (recovered f) ${percentile(hErrNoExif, 95).toFixed(3)}"`);
});

// -------------------------------------------------- no-reference rectangle

test('rectangle metrology: ratios exact, one known length scales everything', () => {
  const s = scene({});
  const cycle = [s.backLeft, s.backRight, s.frontRight, s.frontLeft];
  for (const focalPx of [2900, null]) { // EXIF path and recovered path
    const m = rectangleMetrology(cycle, IMG_W, IMG_H, { focalPx });
    const wU = m.distance(s.backLeft, s.backRight);
    const dU = m.distance(s.backLeft, s.frontLeft);
    const hU = m.wallHeight(s.backLeft, s.backRight, s.topLeft);
    // ratios must match ground truth exactly
    assert.ok(Math.abs(wU / dU - s.truth.W / s.truth.D) < 1e-6, `W/D ${wU / dU}`);
    assert.ok(Math.abs(hU / dU - s.truth.H / s.truth.D) < 1e-6, `H/D ${hU / dU}`);
    // one known length (the height) makes all dims absolute
    const scale = s.truth.H / hU;
    assert.ok(Math.abs(wU * scale - s.truth.W) < 1e-6, `W ${wU * scale}`);
    assert.ok(Math.abs(dU * scale - s.truth.D) < 1e-6, `D ${dU * scale}`);
  }
});

test('rectangle metrology: recovered focal matches the camera', () => {
  const s = scene({});
  const m = rectangleMetrology([s.backLeft, s.backRight, s.frontRight, s.frontLeft], IMG_W, IMG_H);
  assert.ok(Math.abs(m.f - 2900) / 2900 < 1e-6, `f=${m.f}`);
});
