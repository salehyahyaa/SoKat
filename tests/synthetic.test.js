/**
 * Synthetic ground-truth suite.
 *
 * A virtual closet with EXACTLY known dimensions is projected through a
 * realistic pinhole camera (iPhone-like focal length) from many positions and
 * angles. The resulting pixel coordinates — perfect "taps" — run through the
 * real measurement pipeline. This proves the geometry engine itself is
 * correct to far better than 1/16" with zero measurement noise: any error in
 * the field comes from tapping/optics, not the math.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaneMeasurement } from '../js/measurement.js';
import { ClosetModel } from '../js/closet-model.js';
import { PinholeCamera, paperOnWall, closetBackWall, paperOnFloor } from './helpers.js';

const SIXTEENTH = 1 / 16;

const CLOSETS = [
  { W: 36, H: 72, D: 24 },
  { W: 48, H: 84, D: 28.5 },
  { W: 24.0625, H: 60.4375, D: 20.1875 }, // odd sixteenths — no round-number luck
  { W: 96, H: 96, D: 30 },
];

// Camera poses: straight-on, off-center, high, low, close, far, tilted look-at.
const WALL_POSES = (H) => [
  { eye: [0, H * 0.55, 50], target: [0, H * 0.55, 0] },
  { eye: [14, H * 0.6, 55], target: [0, H * 0.5, 0] },
  { eye: [-18, H * 0.4, 65], target: [4, H * 0.55, 0] },
  { eye: [8, H * 0.8, 40], target: [-2, H * 0.45, 0] },
  { eye: [-5, H * 0.3, 90], target: [0, H * 0.5, 0] },
];

test('full pipeline: width & height exact for every closet x camera pose', () => {
  let cases = 0;
  for (const { W, H } of CLOSETS) {
    for (const pose of WALL_POSES(H)) {
      const cam = new PinholeCamera(pose);
      const paperPx = paperOnWall(0, H * 0.55).map((p) => cam.project(p));
      const closetPx = closetBackWall(W, H).map((p) => cam.project(p));
      const plane = new PlaneMeasurement(paperPx);

      const model = new ClosetModel({
        widthTop: plane.distance(closetPx[0], closetPx[1]),
        widthBottom: plane.distance(closetPx[3], closetPx[2]),
        heightLeft: plane.distance(closetPx[0], closetPx[3]),
        heightRight: plane.distance(closetPx[1], closetPx[2]),
        depth: 0,
      });

      const wErr = Math.abs(model.width - W);
      const hErr = Math.abs(model.height - H);
      assert.ok(wErr < SIXTEENTH / 100, `width err ${wErr}" for W=${W} pose=${JSON.stringify(pose)}`);
      assert.ok(hErr < SIXTEENTH / 100, `height err ${hErr}" for H=${H}`);
      cases++;
    }
  }
  assert.equal(cases, CLOSETS.length * 5);
});

test('full pipeline: depth exact from the floor plane', () => {
  for (const { D } of CLOSETS) {
    // Camera held ~55" up, a couple feet outside the closet, looking down at the floor.
    const cam = new PinholeCamera({ eye: [6, 55, D + 30], target: [0, 0, D / 2] });
    const paperPx = paperOnFloor(6, D / 2).map((p) => cam.project(p));
    const plane = new PlaneMeasurement(paperPx);

    const backPx = cam.project([-4, 0, 0]);   // base of back wall
    const frontPx = cam.project([-4, 0, D]);  // front edge of the floor
    const depth = plane.distance(backPx, frontPx);
    assert.ok(Math.abs(depth - D) < SIXTEENTH / 100, `depth err ${Math.abs(depth - D)}" for D=${D}`);
  }
});

test('paper anywhere on the wall gives the same answer', () => {
  const { W, H } = CLOSETS[0];
  const cam = new PinholeCamera({ eye: [5, 45, 55], target: [0, 40, 0] });
  const closetPx = closetBackWall(W, H).map((p) => cam.project(p));
  for (const [px, py] of [[0, 40], [-10, 25], [12, 55], [-8, 60]]) {
    const plane = new PlaneMeasurement(paperOnWall(px, py).map((p) => cam.project(p)));
    const w = plane.distance(closetPx[0], closetPx[1]);
    assert.ok(Math.abs(w - W) < SIXTEENTH / 100, `paper at (${px},${py}): width err ${Math.abs(w - W)}`);
  }
});
