import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWallQuad, validateEndpoints, validateResultDims, orthoResidual,
  focalFromVanishingPoints, confidenceView, confidenceOverall,
  toFraction, feetInches, errorBandPct, isConvexQuad,
} from '../js/validation.js';
import { rectangleMetrology } from '../js/metrology.js';
import { PinholeCamera } from './helpers.js';

const IMG_W = 4032;
const IMG_H = 3024;

// A well-shot back wall, corners in order bl, br, tr, tl.
function wallScene({ W = 40, H = 84, eye = [15, 58, 95], f = 1456 } = {}) {
  const cam = new PinholeCamera({ eye, target: [0, 40, 0], f, cx: IMG_W / 2, cy: IMG_H / 2 });
  const px = (p) => cam.project(p);
  return {
    px,
    quad: [px([-W / 2, 0, 0]), px([W / 2, 0, 0]), px([W / 2, H, 0]), px([-W / 2, H, 0])],
    truth: { W, H },
    f,
    eye,
  };
}

// ------------------------------------------------------------ wall outline

test('good wall outline passes', () => {
  const s = wallScene({});
  const r = validateWallQuad(s.quad, IMG_W, IMG_H);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.metrics.areaFrac > 0.015);
});

test('crossed corners are rejected', () => {
  const s = wallScene({});
  const bad = [s.quad[0], s.quad[2], s.quad[1], s.quad[3]];
  const r = validateWallQuad(bad, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'crossed'));
});

test('duplicate corners are rejected', () => {
  const s = wallScene({});
  const bad = [...s.quad];
  bad[1] = { x: bad[0].x + 3, y: bad[0].y + 3 };
  assert.equal(validateWallQuad(bad, IMG_W, IMG_H).ok, false);
});

test('top corner below its bottom corner is rejected', () => {
  const s = wallScene({});
  const bad = [...s.quad];
  bad[3] = { x: bad[0].x, y: bad[0].y + 100 };
  const r = validateWallQuad(bad, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'top-below' || e.code === 'crossed'));
});

test('tiny outline is rejected', () => {
  const q = [{ x: 2000, y: 1600 }, { x: 2150, y: 1600 }, { x: 2150, y: 1450 }, { x: 2000, y: 1450 }];
  const r = validateWallQuad(q, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'quad-small'));
});

// --------------------------------------------------- zero-input scale path

test('wall outline yields exact dims via camera-height scale', () => {
  const s = wallScene({ eye: [15, 58, 95] });
  const m = rectangleMetrology(s.quad, IMG_W, IMG_H, { focalPx: s.f });
  const scale = 58 / Math.abs(m.C[1]); // assumed phone height = true camera height
  const w = m.distance(s.quad[0], s.quad[1]) * scale;
  const h = m.distance(s.quad[0], s.quad[3]) * scale;
  assert.ok(Math.abs(w - s.truth.W) < 1e-6, `w=${w}`);
  assert.ok(Math.abs(h - s.truth.H) < 1e-6, `h=${h}`);
  // rectangularity residual is ~0 for a genuine wall rectangle
  assert.ok(orthoResidual(m.Hcols.h1, m.Hcols.h2, s.f, IMG_W / 2, IMG_H / 2) < 0.01);
});

test('misplaced corner raises the rectangularity residual', () => {
  const s = wallScene({});
  const bad = [...s.quad];
  bad[2] = { x: bad[2].x - 600, y: bad[2].y + 200 };
  const m = rectangleMetrology(bad, IMG_W, IMG_H, { focalPx: s.f });
  assert.ok(orthoResidual(m.Hcols.h1, m.Hcols.h2, s.f, IMG_W / 2, IMG_H / 2) > 0.05);
});

test('phone-height assumption off by 10% scales results by 10%', () => {
  const s = wallScene({ eye: [15, 58, 95] });
  const m = rectangleMetrology(s.quad, IMG_W, IMG_H, { focalPx: s.f });
  const scale = 58 * 1.1 / Math.abs(m.C[1]);
  const w = m.distance(s.quad[0], s.quad[1]) * scale;
  assert.ok(Math.abs(w / s.truth.W - 1.1) < 1e-6);
});

// -------------------------------------------------------------- endpoints

test('exact width endpoint measurement passes validation', () => {
  const s = wallScene({});
  const a = s.px([-20, 2, 0]);
  const b = s.px([20, 2, 0]);
  const r = validateEndpoints([a, b], 'width', 40, IMG_W, IMG_H, s.quad);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('a 180-inch height is blocked at the endpoint stage', () => {
  const s = wallScene({});
  const r = validateEndpoints([s.px([0, 0, 0]), s.px([0, 84, 0])], 'height', 180, IMG_W, IMG_H, s.quad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'implausible'));
});

test('near-identical endpoints are rejected', () => {
  const s = wallScene({});
  const p = s.px([0, 40, 0]);
  const r = validateEndpoints([p, { x: p.x + 4, y: p.y + 4 }], 'width', 36, IMG_W, IMG_H, s.quad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'endpoints-close'));
});

// ---------------------------------------------------------------- results

test('plausible dims pass; atypical warns; absurd ratio blocks', () => {
  assert.equal(validateResultDims({ width: 40, height: 84 }).ok, true);
  const wide = validateResultDims({ width: 110, height: 84 });
  assert.equal(wide.ok, true);
  assert.ok(wide.warnings.some((w) => w.code === 'atypical'));
  assert.equal(validateResultDims({ width: 200, height: 8 }).ok, false);
});

// -------------------------------------------------------------- confidence

test('clean scan High; weak evidence degrades; overall = weakest view', () => {
  const good = confidenceView({ paperAreaFrac: 0.1, orthoResidual: 0.01, normRatio: 1, leverage: 1, megapixels: 12, hasExifFocal: true });
  assert.equal(good.level, 'high');
  const bad = confidenceView({ paperAreaFrac: 0.001, orthoResidual: 0.15, normRatio: 0.85, leverage: 12, megapixels: 1, hasExifFocal: false });
  assert.equal(bad.level, 'low');
  assert.equal(confidenceOverall([good, bad]).level, 'low');
});

// ------------------------------------------------------------- formatting

test('1/16 fraction display and feet-inches display', () => {
  assert.equal(toFraction(36.1875), '36 3/16″');
  assert.equal(toFraction(36.02), '36″');
  assert.equal(feetInches(84.25), '7′ 0 1/4″');
  assert.equal(feetInches(10.5), '10 1/2″');
  assert.equal(feetInches(83.9999999), '7′');
  assert.equal(feetInches(84), '7′');
});

test('error band: auto-scale dominates until corrected', () => {
  const auto = errorBandPct({ orthoResidual: 0.01, autoScale: true });
  const corrected = errorBandPct({ orthoResidual: 0.01, autoScale: false });
  assert.ok(auto >= 8);
  assert.ok(corrected < 3);
});

test('convexity primitive', () => {
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), true);
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }]), false);
});

test('vanishing-point focal recovered from an angled wall outline', () => {
  const s = wallScene({ eye: [30, 70, 80], f: 1456 });
  const fVP = focalFromVanishingPoints(s.quad, IMG_W / 2, IMG_H / 2);
  assert.ok(fVP != null && Math.abs(fVP - 1456) / 1456 < 0.02, `fVP ${fVP}`);
});
