/**
 * SingleViewMetrology — full 3D measurement from ONE photo.
 *
 * The paper sheet lies flat on the closet floor, so the floor plane is
 * calibrated directly (width & depth are plane distances, same math as
 * PlaneMeasurement). Height is off-plane; it is recovered by decomposing the
 * paper's plane→image homography into the camera's pose:
 *
 *   H = K [r1 r2 t]  (Zhang's method, principal point at image center)
 *
 * The two rotation-column constraints (orthogonality, equal norm) solve the
 * focal length; from K, R, t the camera center and per-pixel view rays follow.
 * A tapped ceiling-corner pixel is then cast as a ray and intersected with the
 * vertical back-wall plane (known from the two tapped back-floor corners) —
 * the intersection's elevation above the floor is the closet height, in the
 * same inches the paper defined.
 *
 * Pure math, no DOM — unit-tested against a synthetic pinhole camera.
 */
import { Homography } from './homography.js';
import { PlaneMeasurement, REF_LONG_IN, REF_SHORT_IN } from './measurement.js';

export class SingleViewMetrology {
  // refCornersPx: 4 tapped sheet corners (image px), ordered around the sheet
  // starting along a long edge. imageW/imageH: photo size in px, for the
  // principal-point assumption. focalPx: known focal length in pixels (e.g.
  // from the photo's EXIF) — far more stable than recovering it from the
  // paper quad; recovery is the fallback when EXIF is unavailable.
  constructor(refCornersPx, imageW, imageH, {
    focalPx = null, longIn = REF_LONG_IN, shortIn = REF_SHORT_IN,
  } = {}) {
    this.plane = new PlaneMeasurement(refCornersPx, longIn, shortIn);
    this.cx = imageW / 2;
    this.cy = imageH / 2;

    const world = [
      { x: 0, y: 0 },
      { x: longIn, y: 0 },
      { x: longIn, y: shortIn },
      { x: 0, y: shortIn },
    ];
    const Hpi = Homography.solve(world, refCornersPx).m; // plane -> image
    const h1 = [Hpi[0][0], Hpi[1][0], Hpi[2][0]];
    const h2 = [Hpi[0][1], Hpi[1][1], Hpi[2][1]];
    const h3 = [Hpi[0][2], Hpi[1][2], Hpi[2][2]];

    this.f = focalPx || this.solveFocal(h1, h2);
    this.focalSource = focalPx ? 'exif' : 'homography';
    const pose = this.decompose(h1, h2, h3);
    this.R = pose.R; // [r1, r2, r3] — the columns of the rotation matrix
    this.C = pose.C; // camera center in plane frame (|z| = height above floor)
  }

  // Recover the focal length from the homography's rotation constraints.
  // Both constraints are used when well-conditioned and averaged.
  solveFocal(h1, h2) {
    const d1 = [h1[0] - h1[2] * this.cx, h1[1] - h1[2] * this.cy, h1[2]];
    const d2 = [h2[0] - h2[2] * this.cx, h2[1] - h2[2] * this.cy, h2[2]];
    const candidates = [];

    // r1 . r2 = 0
    const denOrtho = d1[2] * d2[2];
    if (Math.abs(denOrtho) > 1e-12) {
      const f2 = -(d1[0] * d2[0] + d1[1] * d2[1]) / denOrtho;
      if (f2 > 0 && Number.isFinite(f2)) candidates.push(f2);
    }
    // |r1| = |r2|
    const denNorm = d2[2] * d2[2] - d1[2] * d1[2];
    if (Math.abs(denNorm) > 1e-12) {
      const f2 = (d1[0] * d1[0] + d1[1] * d1[1] - d2[0] * d2[0] - d2[1] * d2[1]) / denNorm;
      if (f2 > 0 && Number.isFinite(f2)) candidates.push(f2);
    }
    if (candidates.length === 0) {
      throw new Error(
        'Could not recover 3D perspective — retake the photo from a natural '
        + 'standing angle (not straight down at the paper)',
      );
    }
    // Geometric mean is stable when both estimates are available.
    const f2 = candidates.length === 2
      ? Math.sqrt(candidates[0] * candidates[1])
      : candidates[0];
    return Math.sqrt(f2);
  }

  // K^-1 applied to a homogeneous image-plane column.
  kinv([a, b, c]) {
    return [(a - c * this.cx) / this.f, (b - c * this.cy) / this.f, c];
  }

  decompose(h1, h2, h3) {
    const build = (sign) => {
      const v1 = this.kinv(h1).map((x) => x * sign);
      const v2 = this.kinv(h2).map((x) => x * sign);
      const v3 = this.kinv(h3).map((x) => x * sign);
      const n1 = norm(v1);
      const n2 = norm(v2);
      const lambda = (n1 + n2) / 2;
      const r1 = scale(v1, 1 / n1);
      // Gram–Schmidt: enforce exact orthogonality against tap noise.
      let r2 = sub(v2, scale(r1, dot(v2, r1)));
      r2 = scale(r2, 1 / norm(r2));
      const r3 = cross(r1, r2);
      const t = scale(v3, 1 / lambda);
      // Camera center C = -R^T t (columns of R are r1,r2,r3).
      const C = [-(r1[0] * t[0] + r1[1] * t[1] + r1[2] * t[2]),
                 -(r2[0] * t[0] + r2[1] * t[1] + r2[2] * t[2]),
                 -(r3[0] * t[0] + r3[1] * t[1] + r3[2] * t[2])];
      return { R: [r1, r2, r3], C, t };
    };
    // H is defined up to sign; the physical solution has the plane in FRONT
    // of the camera (positive depth of the plane origin, t_z > 0).
    const a = build(1);
    return a.t[2] > 0 ? a : build(-1);
  }

  // World-frame direction of the view ray through an image pixel.
  ray(px) {
    const d = [(px.x - this.cx) / this.f, (px.y - this.cy) / this.f, 1];
    const [r1, r2, r3] = this.R;
    // R^T d (columns of R are r1,r2,r3 => R^T rows are r1,r2,r3).
    return [dot(r1, d), dot(r2, d), dot(r3, d)];
  }

  // Height of the closet: cast the tapped ceiling-corner pixel onto the
  // vertical wall plane through the two tapped back-floor corners.
  wallHeight(backLeftPx, backRightPx, topPx) {
    const A = this.plane.toWorld(backLeftPx);
    const B = this.plane.toWorld(backRightPx);
    const nx = B.y - A.y;
    const ny = -(B.x - A.x);
    const nl = Math.hypot(nx, ny);
    if (nl < 1e-9) throw new Error('Back-wall corners coincide — re-tap them');
    const n = [nx / nl, ny / nl, 0];

    const d = this.ray(topPx);
    const denom = dot(n, d);
    if (Math.abs(denom) < 1e-12) {
      throw new Error('Ceiling corner looks along the wall — re-tap it');
    }
    const s = (dot(n, [A.x - this.C[0], A.y - this.C[1], -this.C[2]])) / denom;
    const height = Math.abs(this.C[2] + s * d[2]);
    if (!Number.isFinite(height) || s <= 0) {
      throw new Error('Could not place the ceiling corner in 3D — re-tap it');
    }
    return height;
  }

  // Convenience passthroughs for on-floor measurements.
  distance(p1, p2) { return this.plane.distance(p1, p2); }
  toWorld(px) { return this.plane.toWorld(px); }
}

/**
 * rectangleMetrology — the no-reference variant. The floor footprint the
 * user taps is assumed to be a physical rectangle (unknown size). With the
 * camera's focal length (EXIF, or recovered from the rectangle's vanishing-
 * point orthogonality), the rectangle's aspect ratio falls out of the
 * homography decomposition — so every measurement is correct UP TO ONE
 * SCALE FACTOR. The caller sets absolute scale from a single user-known
 * length (e.g. ceiling height).
 *
 * cornersPx: floor rectangle in cycle order [backL, backR, frontR, frontL].
 * Returns a SingleViewMetrology whose unit is "one depth" (D = 1).
 */
export function rectangleMetrology(cornersPx, imageW, imageH, { focalPx = null } = {}) {
  const cx = imageW / 2;
  const cy = imageH / 2;
  const world = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const Hpi = Homography.solve(world, cornersPx).m;
  const h1 = [Hpi[0][0], Hpi[1][0], Hpi[2][0]];
  const h2 = [Hpi[0][1], Hpi[1][1], Hpi[2][1]];

  let f = focalPx;
  if (!f) {
    // Only the orthogonality constraint holds for a non-square rectangle.
    const d1 = [h1[0] - h1[2] * cx, h1[1] - h1[2] * cy, h1[2]];
    const d2 = [h2[0] - h2[2] * cx, h2[1] - h2[2] * cy, h2[2]];
    const den = d1[2] * d2[2];
    const f2 = Math.abs(den) > 1e-12 ? -(d1[0] * d2[0] + d1[1] * d2[1]) / den : NaN;
    if (!(f2 > 0) || !Number.isFinite(f2)) {
      throw new Error(
        'Could not read the camera\'s focal length from this photo — retake '
        + 'the photo from a natural standing angle',
      );
    }
    f = Math.sqrt(f2);
  }

  // Aspect ratio W/D from the column norms of K^-1 H.
  const ki = (h) => [(h[0] - h[2] * cx) / f, (h[1] - h[2] * cy) / f, h[2]];
  const a1 = ki(h1);
  const a2 = ki(h2);
  const aspect = norm(a1) / norm(a2);
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new Error('Corner taps look degenerate — re-tap the 4 floor corners');
  }
  return new SingleViewMetrology(cornersPx, imageW, imageH, {
    focalPx: f, longIn: aspect, shortIn: 1,
  });
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { return Math.sqrt(dot(a, a)); }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
