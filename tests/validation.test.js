import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePaperQuad, paperPoseChecks, validateEndpoints, validateResultDims,
  confidenceView, confidenceOverall, toFraction, feetInches, errorBandPct,
  focalFromVanishingPoints, isConvexQuad, PAPER,
} from '../js/validation.js';
import { PlaneMeasurement } from '../js/measurement.js';
import { PinholeCamera, paperOnWall } from './helpers.js';

const IMG_W = 4032;
const IMG_H = 3024;

// A well-shot back wall: paper taped at chest height, camera standing back.
function wallScene({ f = 2900, eye = [10, 55, 90] } = {}) {
  const cam = new PinholeCamera({ eye, target: [0, 45, 0], f, cx: IMG_W / 2, cy: IMG_H / 2 });
  const px = (p) => cam.project(p);
  return {
    cam,
    px,
    paper: paperOnWall(6, 50).map(px), // TL TR BR BL, long edge first
    f,
  };
}

// ------------------------------------------------------------- paper quad

test('good paper quad passes', () => {
  const s = wallScene({});
  const r = validatePaperQuad(s.paper, IMG_W, IMG_H);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.metrics.areaFrac > 0.002);
});

test('crossed paper corners are rejected', () => {
  const s = wallScene({});
  const bad = [s.paper[0], s.paper[2], s.paper[1], s.paper[3]];
  const r = validatePaperQuad(bad, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'crossed'));
});

test('duplicate paper corners are rejected', () => {
  const s = wallScene({});
  const bad = [...s.paper];
  bad[1] = { x: bad[0].x + 2, y: bad[0].y + 2 };
  const r = validatePaperQuad(bad, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'duplicate'));
});

test('paper too small in frame is rejected', () => {
  const tiny = [
    { x: 2000, y: 1500 }, { x: 2100, y: 1500 },
    { x: 2100, y: 1580 }, { x: 2000, y: 1580 },
  ];
  const r = validatePaperQuad(tiny, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'paper-small'));
});

// --------------------------------------------------------- pose checks

function checksFor(paperPts, { exifFocal = null } = {}) {
  const plane = new PlaneMeasurement(paperPts);
  return { plane, checks: paperPoseChecks(paperPts, IMG_W, IMG_H, { exifFocal, homographyColumns: plane.Hcols }) };
}

test('true letter sheet passes pose checks; focal recovered', () => {
  const s = wallScene({});
  const { checks } = checksFor(s.paper, { exifFocal: 2900 });
  assert.equal(checks.ok, true, JSON.stringify(checks.errors));
  assert.ok(checks.metrics.orthoResidual < 0.02, `ortho ${checks.metrics.orthoResidual}`);
  assert.ok(Math.abs(checks.metrics.normRatio - 1) < 0.02, `ratio ${checks.metrics.normRatio}`);
  const fVP = focalFromVanishingPoints(s.paper, IMG_W / 2, IMG_H / 2);
  if (fVP != null) assert.ok(Math.abs(fVP - 2900) / 2900 < 0.05, `fVP ${fVP}`);
});

test('starting on the SHORT edge is detected and rejected', () => {
  const s = wallScene({});
  // Rotate the tap order by one: user began along an 8.5-inch edge.
  const swapped = [s.paper[1], s.paper[2], s.paper[3], s.paper[0]];
  const { checks } = checksFor(swapped, { exifFocal: 2900 });
  assert.equal(checks.ok, false, JSON.stringify(checks.metrics));
  assert.ok(checks.errors.some((e) => e.code === 'edge-order'), JSON.stringify(checks.errors));
});

test('non-rectangular "sheet" taps are rejected', () => {
  const s = wallScene({});
  const bad = [...s.paper];
  bad[2] = { x: bad[2].x + 260, y: bad[2].y + 200 }; // one corner far off the sheet
  const { checks } = checksFor(bad, { exifFocal: 2900 });
  assert.equal(checks.ok, false, JSON.stringify(checks.metrics));
});

// -------------------------------------------------------------- endpoints

test('plane measurement + endpoint validation: exact width passes', () => {
  const s = wallScene({});
  const plane = new PlaneMeasurement(s.paper);
  const a = s.px([-20, 0, 0]); // 40-inch span on the wall
  const b = s.px([20, 0, 0]);
  const v = plane.distance(a, b);
  assert.ok(Math.abs(v - 40) < 1e-6, `v=${v}`);
  const r = validateEndpoints([a, b], 'width', v, IMG_W, IMG_H, s.paper);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(Number.isFinite(r.metrics.leverage));
});

test('a 180-inch height is blocked at the endpoint stage', () => {
  const s = wallScene({});
  const r = validateEndpoints([s.px([0, 0, 0]), s.px([0, 84, 0])], 'height', 180, IMG_W, IMG_H, s.paper);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'implausible'));
});

test('near-identical endpoints are rejected', () => {
  const s = wallScene({});
  const p = s.px([0, 40, 0]);
  const r = validateEndpoints([p, { x: p.x + 4, y: p.y + 4 }], 'width', 36, IMG_W, IMG_H, s.paper);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'endpoints-close'));
});

// ---------------------------------------------------------------- results

test('plausible dims pass; atypical warns; absurd ratio blocks', () => {
  assert.equal(validateResultDims({ width: 40, height: 84, depth: 28 }).ok, true);
  const wide = validateResultDims({ width: 110, height: 84, depth: 28 });
  assert.equal(wide.ok, true);
  assert.ok(wide.warnings.some((w) => w.code === 'atypical'));
  const absurd = validateResultDims({ width: 200, height: 8, depth: 100 });
  assert.equal(absurd.ok, false);
});

// -------------------------------------------------------------- confidence

test('clean view scores High; weak evidence degrades; overall = weakest view', () => {
  const good = confidenceView({ paperAreaFrac: 0.02, orthoResidual: 0.01, normRatio: 1, leverage: 3, megapixels: 12, hasExifFocal: true });
  assert.equal(good.level, 'high');
  const bad = confidenceView({ paperAreaFrac: 0.001, orthoResidual: 0.15, normRatio: 0.85, leverage: 12, megapixels: 1, hasExifFocal: false });
  assert.equal(bad.level, 'low');
  assert.ok(bad.reasons.length >= 3);
  const overall = confidenceOverall([good, bad]);
  assert.equal(overall.level, 'low');
});

// ------------------------------------------------------------- formatting

test('1/16 fraction display and feet-inches display', () => {
  assert.equal(toFraction(36.1875), '36 3/16″');
  assert.equal(toFraction(36.02), '36″');
  assert.equal(feetInches(84.25), '7′ 0 1/4″');
  assert.equal(feetInches(10.5), '10 1/2″');
  assert.equal(feetInches(83.9999999), '7′'); // rounding must carry into feet
  assert.equal(feetInches(84), '7′');
});

test('error band grows with leverage and residuals, capped', () => {
  const near = errorBandPct({ leverage: 2, orthoResidual: 0.01 });
  const far = errorBandPct({ leverage: 12, orthoResidual: 0.2, paperAreaFrac: 0.001 });
  assert.ok(near < far);
  assert.ok(far <= 15);
});

test('convexity primitive', () => {
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), true);
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }]), false);
});

test('paper constants are the letter sheet', () => {
  assert.equal(PAPER.LONG, 11);
  assert.equal(PAPER.SHORT, 8.5);
});
