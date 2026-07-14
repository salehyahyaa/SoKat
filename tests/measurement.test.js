import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaneMeasurement } from '../js/measurement.js';
import { ClosetModel } from '../js/closet-model.js';
import { AccuracyChecker, TARGET_IN } from '../js/accuracy.js';
import { PinholeCamera, paperOnWall } from './helpers.js';

test('PlaneMeasurement recovers in-plane distances through a real camera projection', () => {
  const cam = new PinholeCamera({ eye: [8, 50, 45], target: [0, 40, 0] });
  const paperPx = paperOnWall(0, 40).map((p) => cam.project(p));
  const plane = new PlaneMeasurement(paperPx);

  // Two arbitrary points on the wall plane, true distance known exactly.
  const a3 = [-14.25, 12.5, 0];
  const b3 = [16.75, 61.0, 0];
  const trueDist = Math.hypot(b3[0] - a3[0], b3[1] - a3[1]);
  const measured = plane.distance(cam.project(a3), cam.project(b3));
  assert.ok(Math.abs(measured - trueDist) < 1e-6, `${measured} vs ${trueDist}`);
});

test('ClosetModel averages paired readings and reports spread', () => {
  const m = new ClosetModel({
    widthTop: 36.0, widthBottom: 36.125,
    heightLeft: 72.0, heightRight: 71.9375,
    depth: 24.0,
  });
  assert.equal(m.width, 36.0625);
  assert.equal(m.height, 71.96875);
  assert.equal(m.maxSpread, 0.125);
  assert.equal(m.isConsistent, true);

  const bad = new ClosetModel({
    widthTop: 36, widthBottom: 37, heightLeft: 72, heightRight: 72, depth: 24,
  });
  assert.equal(bad.isConsistent, false);
});

test('toFraction16 formats carpenter fractions', () => {
  assert.equal(ClosetModel.toFraction16(36.1875), '36 3/16″');
  assert.equal(ClosetModel.toFraction16(36.5), '36 1/2″');
  assert.equal(ClosetModel.toFraction16(36.25), '36 1/4″');
  assert.equal(ClosetModel.toFraction16(36.75), '36 3/4″');
  assert.equal(ClosetModel.toFraction16(36.0), '36″');
  assert.equal(ClosetModel.toFraction16(35.999), '36″');   // rounds up across the whole
  assert.equal(ClosetModel.toFraction16(36.03), '36″');    // < 1/32 rounds down
  assert.equal(ClosetModel.toFraction16(36.04), '36 1/16″');
  assert.equal(ClosetModel.toFraction16(0.0625), '0 1/16″');
});

test('AccuracyChecker report classifies against the 1/16" target', () => {
  assert.equal(TARGET_IN, 0.0625);
  const pass = AccuracyChecker.report(11.05, 11.0);
  assert.ok(pass.pass);
  assert.ok(Math.abs(pass.errorSixteenths - 0.8) < 1e-9);
  const fail = AccuracyChecker.report(11.09, 11.0);
  assert.ok(!fail.pass);
});
