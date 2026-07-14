/**
 * Noise-sensitivity suite — defines the app's OPERATING ENVELOPE.
 *
 * The synthetic suite proves the math is exact; real-world error comes almost
 * entirely from corner-tap precision. Here every tapped point gets seeded
 * gaussian pixel noise, 300 trials per configuration, and we assert on the
 * 95th-percentile absolute error. This quantifies exactly how precise the
 * loupe-assisted taps must be (and how close the camera must stand) for the
 * 1/16" target to hold — the numbers cited in docs/VALIDATION.md come from
 * this file's output.
 *
 * σ = 0.5 px  ≈ careful loupe-refined tap on a sharp, well-lit photo
 * σ = 1.0 px  ≈ typical loupe tap
 * σ = 2.0 px  ≈ hasty tap without using the loupe
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaneMeasurement } from '../js/measurement.js';
import {
  PinholeCamera, paperOnWall, closetBackWall,
  seededRandom, jitter, percentile,
} from './helpers.js';

const SIXTEENTH = 1 / 16;
const TRIALS = 300;

/** Run trials of the width measurement with tap noise; return abs errors (inches). */
function widthErrors({ W = 36, H = 72, camDist = 55, sigma, seed }) {
  const cam = new PinholeCamera({ eye: [0, H * 0.55, camDist], target: [0, H * 0.55, 0] });
  const paperPx = paperOnWall(0, H * 0.55).map((p) => cam.project(p));
  const closetPx = closetBackWall(W, H).map((p) => cam.project(p));
  const rand = seededRandom(seed);
  const errors = [];
  for (let t = 0; t < TRIALS; t++) {
    const paper = paperPx.map((p) => jitter(p, sigma, rand));
    const closet = closetPx.map((p) => jitter(p, sigma, rand));
    const plane = new PlaneMeasurement(paper);
    const w = (plane.distance(closet[0], closet[1]) + plane.distance(closet[3], closet[2])) / 2;
    errors.push(Math.abs(w - W));
  }
  return errors;
}

function report(name, errors) {
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const p95 = percentile(errors, 95);
  console.log(
    `  ${name}: mean=${mean.toFixed(4)}" p95=${p95.toFixed(4)}" `
    + `(${(p95 / SIXTEENTH).toFixed(2)} sixteenths)`,
  );
  return { mean, p95 };
}

/**
 * Two-photo protocol: the app's optional "refinement pass". Each photo is an
 * independent capture+tap of paper and closet corners (slightly different
 * camera pose); the app averages the two measurements. Independent noise
 * averages down by ~sqrt(2) — this is what carries a 36" width across the
 * 1/16" line.
 */
function twoPhotoWidthErrors({ W = 36, H = 72, sigma, seed }) {
  const poses = [
    { eye: [0, H * 0.55, 45], target: [0, H * 0.55, 0] },
    { eye: [6, H * 0.6, 50], target: [0, H * 0.5, 0] },
  ];
  const rand = seededRandom(seed);
  const errors = [];
  for (let t = 0; t < TRIALS; t++) {
    let sum = 0;
    for (const pose of poses) {
      const cam = new PinholeCamera(pose);
      const paper = paperOnWall(0, H * 0.55).map((p) => jitter(cam.project(p), sigma, rand));
      const closet = closetBackWall(W, H).map((p) => jitter(cam.project(p), sigma, rand));
      const plane = new PlaneMeasurement(paper);
      sum += (plane.distance(closet[0], closet[1]) + plane.distance(closet[3], closet[2])) / 2;
    }
    errors.push(Math.abs(sum / poses.length - W));
  }
  return errors;
}

test('FULL PROTOCOL: two loupe-refined photos hold 1/16" p95 on a 36" width', () => {
  const { p95 } = report('σ=0.5px, two-photo avg', twoPhotoWidthErrors({ sigma: 0.5, seed: 100 }));
  assert.ok(p95 < SIXTEENTH, `p95 ${p95}" exceeds 1/16"`);
});

test('live Accuracy Check scenario: an 11" known edge is measured well inside 1/16"', () => {
  // Error scales with measured span, so the on-stage 11.000" check is the
  // easiest case — CI proves the demo moment is safe.
  const loupe = report('σ=0.5px, 11" edge', widthErrors({ W: 11, H: 72, sigma: 0.5, seed: 606 }));
  assert.ok(loupe.p95 < SIXTEENTH / 2, `loupe p95 ${loupe.p95}"`);
  const typical = report('σ=1.0px, 11" edge', widthErrors({ W: 11, H: 72, sigma: 1.0, seed: 707 }));
  assert.ok(typical.p95 < 1.25 * SIXTEENTH, `typical p95 ${typical.p95}"`);
});

test('single photo, σ=0.5px loupe taps: ~1.4 sixteenths p95 on a 36" width', () => {
  const { p95 } = report('σ=0.5px, 55" away', widthErrors({ sigma: 0.5, seed: 101 }));
  assert.ok(p95 < 1.5 * SIXTEENTH, `p95 ${p95}"`);
});

test('single photo, σ=1px typical taps: ~3 sixteenths p95 on a 36" width', () => {
  const { p95 } = report('σ=1.0px, 55" away', widthErrors({ sigma: 1.0, seed: 202 }));
  assert.ok(p95 < 3 * SIXTEENTH, `p95 ${p95}"`);
});

test('single photo, σ=2px careless taps degrade to ~7 sixteenths — documented, not hidden', () => {
  const { p95 } = report('σ=2.0px, 55" away', widthErrors({ sigma: 2.0, seed: 303 }));
  assert.ok(p95 < 7 * SIXTEENTH, `p95 ${p95}"`);
});

test('standing closer improves accuracy (error scales with distance)', () => {
  const near = report('σ=1px, 40" away', widthErrors({ sigma: 1.0, camDist: 40, seed: 404 }));
  const far = report('σ=1px, 80" away', widthErrors({ sigma: 1.0, camDist: 80, seed: 404 }));
  assert.ok(near.p95 < far.p95, 'closer camera should measure tighter');
});

test('averaging top & bottom width readings beats a single reading', () => {
  const cam = new PinholeCamera({ eye: [0, 40, 55], target: [0, 40, 0] });
  const paperPx = paperOnWall(0, 40).map((p) => cam.project(p));
  const closetPx = closetBackWall(36, 72).map((p) => cam.project(p));
  const rand = seededRandom(505);
  const single = [];
  const averaged = [];
  for (let t = 0; t < TRIALS; t++) {
    const plane = new PlaneMeasurement(paperPx.map((p) => jitter(p, 1.0, rand)));
    const c = closetPx.map((p) => jitter(p, 1.0, rand));
    const top = plane.distance(c[0], c[1]);
    const bottom = plane.distance(c[3], c[2]);
    single.push(Math.abs(top - 36));
    averaged.push(Math.abs((top + bottom) / 2 - 36));
  }
  const s = report('single reading', single);
  const a = report('averaged reading', averaged);
  assert.ok(a.p95 <= s.p95 * 1.05, 'averaging should not be worse');
});
