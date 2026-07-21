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

// -------------------------------------------- wall-quad auto-scale (zero input)
// The 4 tapped corners of the BACK WALL give the pose up to scale; assuming
// a vertical wall on a horizontal floor, the camera's height above the
// floor in wall units is |C[1]| (the v-axis component of the camera center,
// v spanning floor->ceiling). One phone-height assumption sets the scale.
test('wall quad: camera height above floor recovered exactly', () => {
  const W = 40; const H = 84;
  for (const eye of [[15, 58, 95], [-10, 62, 70], [25, 47, 110]]) {
    const cam = new PinholeCamera({ eye, target: [0, 40, 0], f: 2900, cx: IMG_W / 2, cy: IMG_H / 2 });
    const px = (p) => cam.project(p);
    const cycle = [px([-W / 2, 0, 0]), px([W / 2, 0, 0]), px([W / 2, H, 0]), px([-W / 2, H, 0])];
    const m = rectangleMetrology(cycle, IMG_W, IMG_H, { focalPx: 2900 });
    // aspect must match W/H, and |C[1]| * H must equal the true camera height
    const wallWidthUnits = m.distance(cycle[0], cycle[1]);
    assert.ok(Math.abs(wallWidthUnits - W / H) < 1e-6, `aspect ${wallWidthUnits}`);
    const camHeightIn = Math.abs(m.C[1]) * H;
    assert.ok(Math.abs(camHeightIn - eye[1]) < 1e-6, `camH ${camHeightIn} vs ${eye[1]}`);
    // so the zero-input scale (assumed phone height / |C[1]|) recovers H
    const scale = eye[1] / Math.abs(m.C[1]);
    assert.ok(Math.abs(scale - H) < 1e-6, `H est ${scale}`);
    assert.ok(Math.abs(wallWidthUnits * scale - W) < 1e-6, `W est ${wallWidthUnits * scale}`);
  }
});

test('wall quad: recovered focal path also yields exact scale', () => {
  const W = 40; const H = 84;
  const cam = new PinholeCamera({ eye: [25, 58, 80], target: [-5, 30, 0], f: 1456, cx: IMG_W / 2, cy: IMG_H / 2 });
  const px = (p) => cam.project(p);
  const cycle = [px([-W / 2, 0, 0]), px([W / 2, 0, 0]), px([W / 2, H, 0]), px([-W / 2, H, 0])];
  const m = rectangleMetrology(cycle, IMG_W, IMG_H, {}); // no EXIF: VP focal
  assert.ok(Math.abs(m.f - 1456) / 1456 < 0.01, `f ${m.f}`);
  const scale = 58 / Math.abs(m.C[1]);
  assert.ok(Math.abs(scale - H) < 1e-4, `H est ${scale}`);
});

// A dead-frontal wall shot has no vanishing-point perspective, so the focal
// can't be recovered — with no EXIF this used to hard-fail ("could not read
// the camera's focal length"), stranding real users. The assumed-focal
// fallback must engage instead, and with the true focal matching the
// assumption the wall dimensions come out exact.
test('frontal wall + no EXIF: assumed focal unblocks the scan', () => {
  const W = 60; const H = 96;
  const f = (Math.max(IMG_W, IMG_H) * 26) / 36; // matches the app's assumption
  const cam = new PinholeCamera({ eye: [0, 48, 90], target: [0, 48, 0], f, cx: IMG_W / 2, cy: IMG_H / 2 });
  const quad = [[-W / 2, 0, 0], [W / 2, 0, 0], [W / 2, H, 0], [-W / 2, H, 0]].map((p) => cam.project(p));
  assert.throws(() => rectangleMetrology(quad, IMG_W, IMG_H, {}), /focal length/);
  const m = rectangleMetrology(quad, IMG_W, IMG_H, { assumedFocalPx: f });
  assert.equal(m.focalSource, 'assumed');
  const ratio = m.distance(quad[0], quad[1]) / m.distance(quad[1], quad[2]);
  assert.ok(Math.abs(ratio - W / H) < 1e-6, `aspect ${ratio} vs ${W / H}`);
});
