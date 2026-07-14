import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Homography } from '../js/homography.js';

const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

test('identity mapping', () => {
  const h = Homography.solve(sq, sq);
  for (const p of [{ x: 0.3, y: 0.7 }, { x: 0.9, y: 0.1 }]) {
    const m = h.map(p);
    assert.ok(Math.abs(m.x - p.x) < 1e-10);
    assert.ok(Math.abs(m.y - p.y) < 1e-10);
  }
});

test('recovers a known projective transform exactly', () => {
  // Ground-truth homography with real perspective terms.
  const H = [[1.2, 0.1, 30], [-0.05, 0.9, 12], [0.0004, -0.0002, 1]];
  const apply = (p) => {
    const w = H[2][0] * p.x + H[2][1] * p.y + H[2][2];
    return {
      x: (H[0][0] * p.x + H[0][1] * p.y + H[0][2]) / w,
      y: (H[1][0] * p.x + H[1][1] * p.y + H[1][2]) / w,
    };
  };
  const src = [{ x: 10, y: 20 }, { x: 400, y: 15 }, { x: 380, y: 300 }, { x: 5, y: 290 }];
  const dst = src.map(apply);
  const solved = Homography.solve(src, dst);
  // Check on points NOT used to solve.
  for (const p of [{ x: 123, y: 45 }, { x: 250, y: 200 }, { x: 50, y: 260 }]) {
    const expect = apply(p);
    const got = solved.map(p);
    assert.ok(Math.abs(got.x - expect.x) < 1e-6, `x: ${got.x} vs ${expect.x}`);
    assert.ok(Math.abs(got.y - expect.y) < 1e-6, `y: ${got.y} vs ${expect.y}`);
  }
});

test('numerically stable at photo-scale pixel coordinates (4000 px)', () => {
  const src = [
    { x: 1032.4, y: 988.1 }, { x: 2980.7, y: 1012.9 },
    { x: 2955.2, y: 2450.6 }, { x: 1060.9, y: 2431.3 },
  ];
  const dst = [{ x: 0, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 8.5 }, { x: 0, y: 8.5 }];
  const h = Homography.solve(src, dst);
  for (let i = 0; i < 4; i++) {
    const m = h.map(src[i]);
    assert.ok(Math.hypot(m.x - dst[i].x, m.y - dst[i].y) < 1e-8);
  }
});

test('rejects degenerate (collinear) configurations', () => {
  const collinear = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 0, y: 1 }];
  assert.throws(() => Homography.solve(collinear, sq));
});
