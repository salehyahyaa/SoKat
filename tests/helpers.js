/**
 * Test helpers: a full 3D pinhole camera to generate synthetic ground-truth
 * images, and a seeded PRNG for reproducible noise simulation.
 *
 * The camera projects known 3D world geometry (inches) to image pixels exactly
 * the way a real camera does — so the measurement pipeline can be tested
 * against closets whose dimensions are known to infinite precision.
 */

/** Pinhole camera with look-at orientation. World units: inches. */
export class PinholeCamera {
  /**
   * @param {object} o
   * @param {number[]} o.eye     camera position [x,y,z]
   * @param {number[]} o.target  look-at point
   * @param {number[]} [o.up]
   * @param {number} [o.f]       focal length in pixels (~2900 for iPhone main camera)
   * @param {number} [o.cx] @param {number} [o.cy] principal point
   */
  constructor({ eye, target, up = [0, 1, 0], f = 2900, cx = 2016, cy = 1512 }) {
    this.eye = eye;
    this.f = f;
    this.cx = cx;
    this.cy = cy;
    this.forward = norm(sub(target, eye));
    this.right = norm(cross(this.forward, up));
    this.trueUp = cross(this.right, this.forward);
  }

  /** Project world point [x,y,z] to image pixels {x,y} (y grows downward). */
  project(p) {
    const d = sub(p, this.eye);
    const xc = dot(d, this.right);
    const yc = dot(d, this.trueUp);
    const zc = dot(d, this.forward);
    if (zc <= 0) throw new Error('point behind camera');
    return { x: this.cx + (this.f * xc) / zc, y: this.cy - (this.f * yc) / zc };
  }
}

/**
 * A letter-size sheet on the back wall (plane z=0, y up), landscape.
 * Returns its corners in world coords, in the app's tap order: TL, TR, BR, BL.
 */
export function paperOnWall(centerX, centerY) {
  return [
    [centerX - 5.5, centerY + 4.25, 0],
    [centerX + 5.5, centerY + 4.25, 0],
    [centerX + 5.5, centerY - 4.25, 0],
    [centerX - 5.5, centerY - 4.25, 0],
  ];
}

/**
 * Back-wall corners of a closet of width W and height H (floor at y=0),
 * in the app's tap order: TL, TR, BR, BL.
 */
export function closetBackWall(W, H) {
  return [
    [-W / 2, H, 0],
    [W / 2, H, 0],
    [W / 2, 0, 0],
    [-W / 2, 0, 0],
  ];
}

/**
 * A letter-size sheet lying on the floor (plane y=0), long edge along z.
 * Corner order matches the app instruction: around the sheet, long edge first.
 */
export function paperOnFloor(centerX, centerZ) {
  return [
    [centerX - 4.25, 0, centerZ - 5.5],
    [centerX - 4.25, 0, centerZ + 5.5],
    [centerX + 4.25, 0, centerZ + 5.5],
    [centerX + 4.25, 0, centerZ - 5.5],
  ];
}

/** Deterministic PRNG (mulberry32) so noise tests are reproducible in CI. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian noise via Box–Muller on a seeded uniform PRNG. */
export function gaussian(rand) {
  let u = 0; let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Add isotropic gaussian pixel noise (σ px) to a point. */
export function jitter(pt, sigma, rand) {
  return { x: pt.x + gaussian(rand) * sigma, y: pt.y + gaussian(rand) * sigma };
}

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}
