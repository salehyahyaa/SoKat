import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGeometry, crossChecks, validateReference, validateResult,
  confidence, toFraction, segmentsIntersect, isConvexQuad,
  focalFromVanishingPoints, errorBandPct,
} from '../js/validation.js';
import { rectangleMetrology } from '../js/metrology.js';
import { ClosetModel } from '../js/closet-model.js';
import { PinholeCamera } from './helpers.js';

const IMG_W = 4032;
const IMG_H = 3024;

// A well-shot rectangular closet: W x H x D inches, floor y=0, wall z=0.
function goodScene({ W = 40, H = 84, D = 28, eye = [15, 62, 95], f = 2900 } = {}) {
  const cam = new PinholeCamera({ eye, target: [0, 40, 0], f, cx: IMG_W / 2, cy: IMG_H / 2 });
  const px = (p) => cam.project(p);
  return {
    pts: [
      px([-W / 2, 0, 0]), px([W / 2, 0, 0]),   // back-bottom L/R
      px([-W / 2, 0, D]), px([W / 2, 0, D]),   // front-bottom L/R
      px([-W / 2, H, 0]), px([W / 2, H, 0]),   // back-top L/R
    ],
    truth: { W, H, D },
    f,
  };
}

// --------------------------------------------------------------- geometry

test('good closet geometry passes validation', () => {
  const s = goodScene({ eye: [15, 62, 95], f: 1456 }); // 0.5x-equivalent framing fits all corners
  const r = validateGeometry(s.pts, IMG_W, IMG_H);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('crossed floor edges are rejected with a specific message', () => {
  const s = goodScene({ f: 1456 });
  const bad = [...s.pts];
  [bad[2], bad[3]] = [bad[3], bad[2]]; // swap front-left / front-right
  const r = validateGeometry(bad, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'floor-shape' || e.code === 'perspective'), JSON.stringify(r.errors));
});

test('nearly identical points are rejected as duplicates', () => {
  const s = goodScene({ f: 1456 });
  const bad = [...s.pts];
  bad[1] = { x: bad[0].x + 3, y: bad[0].y + 3 };
  const r = validateGeometry(bad, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'duplicate'));
});

test('top edge below the floor is rejected', () => {
  const s = goodScene({ f: 1456 });
  const bad = [...s.pts];
  bad[4] = { x: bad[0].x, y: bad[0].y + 200 }; // "top" below the floor
  const r = validateGeometry(bad, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'top-below'));
});

test('points on the image border are rejected', () => {
  const s = goodScene({ f: 1456 });
  const bad = [...s.pts];
  bad[4] = { x: 2, y: 2 };
  const r = validateGeometry(bad, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'border'));
});

test('wildly leaning wall edge is rejected', () => {
  const s = goodScene({ f: 1456 });
  const bad = [...s.pts];
  bad[4] = { x: bad[0].x - 1500, y: bad[0].y - 400 }; // top-left far to the side
  const r = validateGeometry(bad, IMG_W, IMG_H);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'vertical-tilt' || e.code === 'vertical-mutual'));
});

test('segment intersection and convexity primitives', () => {
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }), true);
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }), false);
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), true);
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }]), false);
});

// ------------------------------------------------------------ cross-checks

function checksFor(pts, { exifFocal = null } = {}) {
  const [bl, br, fl, fr] = pts;
  const metro = rectangleMetrology([bl, br, fr, fl], IMG_W, IMG_H, { focalPx: exifFocal });
  return crossChecks({
    metro, pts, imgW: IMG_W, imgH: IMG_H,
    exifFocal, homographyColumns: metro.Hcols,
  });
}

test('good geometry passes all cross-checks', () => {
  const s = goodScene({ f: 1456 });
  const r = checksFor(s.pts, { exifFocal: 1456 });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.metrics.heightDisagreePct < 1);
  assert.ok(r.metrics.orthoResidual < 0.02, `ortho ${r.metrics.orthoResidual}`);
  assert.ok(r.metrics.vertAngleLeftDeg < 2);
});

test('vanishing-point focal matches the camera on a true rectangle', () => {
  const s = goodScene({ f: 1456 });
  const fVP = focalFromVanishingPoints(s.pts.slice(0, 4), IMG_W / 2, IMG_H / 2);
  assert.ok(Math.abs(fVP - 1456) / 1456 < 0.01, `fVP=${fVP}`);
});

test('non-rectangular floor (couch-like) fails the rectangularity check', () => {
  const s = goodScene({ f: 1456 });
  const bad = [...s.pts];
  // Drag the front-right corner far inward — a footprint no rectangle explains.
  bad[3] = { x: bad[3].x - 900, y: bad[3].y - 350 };
  const r = checksFor(bad, { exifFocal: 1456 });
  assert.equal(r.ok, false, JSON.stringify(r.metrics));
  assert.ok(r.errors.some((e) => ['not-rectangle', 'vertical-inconsistent', 'height-disagree', 'height-unsolvable'].includes(e.code)),
    JSON.stringify(r.errors));
});

test('misplaced top corner triggers left/right height disagreement', () => {
  const s = goodScene({ f: 1456 });
  const bad = [...s.pts];
  bad[5] = { x: bad[5].x, y: bad[5].y + 500 }; // right top far too low
  const r = checksFor(bad, { exifFocal: 1456 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'height-disagree'), JSON.stringify(r.errors));
  assert.ok(r.metrics.heightDisagreePct > 25);
});

// -------------------------------------------------------------- reference

test('reference values are range-checked per dimension', () => {
  assert.equal(validateReference('height', 96).ok, true);
  assert.equal(validateReference('height', 200).ok, false);
  assert.equal(validateReference('height', 200, { custom: true }).ok, true);
  assert.equal(validateReference('height', 500, { custom: true }).ok, false);
  assert.equal(validateReference('width', -5).ok, false);
  assert.equal(validateReference('depth', NaN).ok, false);
});

// ---------------------------------------------------------------- results

test('a 180-inch height is blocked, never displayed', () => {
  const r = validateResult({ width: 40, height: 180, depth: 28 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'implausible'));
});

test('wildly out-of-proportion dimensions are blocked', () => {
  const r = validateResult({ width: 240, height: 8, depth: 100 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'implausible-ratio'));
});

test('plausible closet passes; atypical size warns but passes', () => {
  assert.equal(validateResult({ width: 40, height: 84, depth: 28 }).ok, true);
  const wide = validateResult({ width: 110, height: 84, depth: 28 });
  assert.equal(wide.ok, true);
  assert.ok(wide.warnings.some((w) => w.code === 'atypical'));
});

test('implausible camera height produces a warning', () => {
  const r = validateResult({ width: 40, height: 84, depth: 28 }, { camHeightIn: 8 });
  assert.ok(r.warnings.some((w) => w.code === 'cam-height'));
});

// -------------------------------------------------------- scaling sanity

test('one reference dimension scales the others exactly (ratios preserved)', () => {
  const s = goodScene({ f: 1456 });
  const [bl, br, fl, fr, tl, tr] = s.pts;
  const metro = rectangleMetrology([bl, br, fr, fl], IMG_W, IMG_H, { focalPx: 1456 });
  const raw = {
    width: metro.distance(bl, br),
    depth: metro.distance(bl, fl),
    height: (metro.wallHeight(bl, br, tl) + metro.wallHeight(bl, br, tr)) / 2,
  };
  const scale = s.truth.H / raw.height; // user enters the height
  assert.ok(Math.abs(raw.width * scale - s.truth.W) < 1e-6);
  assert.ok(Math.abs(raw.depth * scale - s.truth.D) < 1e-6);
});

// -------------------------------------------------------------- confidence

test('clean scan scores High confidence', () => {
  const c = confidence({
    hasExifFocal: true, focalDisagreePct: 1, orthoResidual: 0.01,
    heightDisagreePct: 1, vertAngleMaxDeg: 1, camPitchDeg: 20, megapixels: 12,
  });
  assert.equal(c.level, 'high');
});

test('no EXIF + disagreements degrade to Medium/Low with reasons', () => {
  const c = confidence({
    hasExifFocal: false, orthoResidual: 0.1, heightDisagreePct: 10,
    vertAngleMaxDeg: 8, camPitchDeg: 20, megapixels: 12,
  });
  assert.ok(c.level !== 'high');
  assert.ok(c.reasons.length >= 2);
});

test('badly conflicting evidence scores Low', () => {
  const c = confidence({
    hasExifFocal: false, orthoResidual: 0.2, heightDisagreePct: 20,
    vertAngleMaxDeg: 15, camPitchDeg: 4, megapixels: 1,
  });
  assert.equal(c.level, 'low');
});

// ------------------------------------------------------------- formatting

test('display formatting: quarter-inch default, distinct from 1/16 model formatting', () => {
  assert.equal(toFraction(36.13), '36 1/4″'); // nearest 1/4
  assert.equal(toFraction(36.05), '36″');
  assert.equal(toFraction(36.13, 16), '36 1/8″'); // nearest 1/16 -> 2/16 reduces
  assert.equal(ClosetModel.toFraction16(36.1875), '36 3/16″');
});

test('error band grows with evidence of trouble and is capped', () => {
  const good = errorBandPct({ heightDisagreePct: 1, orthoResidual: 0.01 }, true);
  const bad = errorBandPct({ heightDisagreePct: 20, orthoResidual: 0.25, focalDisagreePct: 40 }, false);
  assert.ok(good < bad);
  assert.ok(bad <= 30);
});
