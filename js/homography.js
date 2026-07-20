/**
 * Homography — maps points between two planes (image plane <-> real-world plane).
 *
 * Solved with the Direct Linear Transform (DLT): 4 point correspondences give
 * an 8x8 linear system (fixing h33 = 1), solved by Gaussian elimination with
 * partial pivoting. Pure math, no DOM — unit-tested in CI.
 */
export class Homography {
  constructor(matrix) {
    this.m = matrix;
  }

  // Solve the homography mapping src[i] -> dst[i] (4 point pairs each).
  static solve(src, dst) {
    if (src.length !== 4 || dst.length !== 4) {
      throw new Error('Homography.solve requires exactly 4 point pairs');
    }
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i];
      const { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    const h = gaussianSolve(A, b);
    return new Homography([
      [h[0], h[1], h[2]],
      [h[3], h[4], h[5]],
      [h[6], h[7], 1],
    ]);
  }

  // Least-squares homography over N >= 4 correspondences (normalized DLT,
  // normal equations). With exact data it reproduces solve(); with noisy
  // data it spreads the error over all points instead of trusting any 4.
  static solveLS(src, dst) {
    if (src.length !== dst.length || src.length < 4) {
      throw new Error('Homography.solveLS requires >= 4 point pairs');
    }
    if (src.length === 4) return Homography.solve(src, dst);
    const Ts = normalizer(src);
    const Td = normalizer(dst);
    const s = src.map(Ts.apply);
    const d = dst.map(Td.apply);

    // Rows of the overdetermined system (h33 fixed to 1 in normalized space).
    const M = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const v = new Array(8).fill(0);
    const accumulate = (row, rhs) => {
      for (let i = 0; i < 8; i++) {
        v[i] += row[i] * rhs;
        for (let j = 0; j < 8; j++) M[i][j] += row[i] * row[j];
      }
    };
    for (let i = 0; i < s.length; i++) {
      const { x, y } = s[i];
      const { x: u, y: w } = d[i];
      accumulate([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
      accumulate([0, 0, 0, x, y, 1, -w * x, -w * y], w);
    }
    const h = gaussianSolve(M, v);
    const Hn = [
      [h[0], h[1], h[2]],
      [h[3], h[4], h[5]],
      [h[6], h[7], 1],
    ];
    // Denormalize: H = Td^-1 * Hn * Ts.
    const H = mat3mul(mat3mul(Td.inv, Hn), Ts.mat);
    const k = H[2][2];
    if (Math.abs(k) < 1e-12) throw new Error('Degenerate least-squares homography');
    return new Homography(H.map((r) => r.map((x) => x / k)));
  }

  // Map a point {x, y} through the homography (perspective divide).
  map(p) {
    const m = this.m;
    const w = m[2][0] * p.x + m[2][1] * p.y + m[2][2];
    if (Math.abs(w) < 1e-12) {
      throw new Error('Point maps to infinity (degenerate homography or point at horizon)');
    }
    return {
      x: (m[0][0] * p.x + m[0][1] * p.y + m[0][2]) / w,
      y: (m[1][0] * p.x + m[1][1] * p.y + m[1][2]) / w,
    };
  }
}

// Hartley normalization: translate the centroid to the origin and scale the
// mean distance to sqrt(2). Returns the transform, its inverse, and an apply().
function normalizer(pts) {
  let mx = 0; let my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let dist = 0;
  for (const p of pts) dist += Math.hypot(p.x - mx, p.y - my);
  dist /= pts.length;
  const s = dist > 1e-12 ? Math.SQRT2 / dist : 1;
  return {
    mat: [[s, 0, -s * mx], [0, s, -s * my], [0, 0, 1]],
    inv: [[1 / s, 0, mx], [0, 1 / s, my], [0, 0, 1]],
    apply: (p) => ({ x: s * (p.x - mx), y: s * (p.y - my) }),
  };
}

function mat3mul(A, B) {
  const C = Array.from({ length: 3 }, () => new Array(3).fill(0));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j];
    }
  }
  return C;
}

// Solve A x = b by Gaussian elimination with partial pivoting (mutates A and b).
function gaussianSolve(A, b) {
  const n = A.length;
  for (let col = 0; col < n; col++) {
    // Partial pivot: find the row with the largest absolute value in this column.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) {
      throw new Error('Degenerate point configuration (are 3 of the 4 points collinear?)');
    }
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];

    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= A[r][c] * x[c];
    x[r] = sum / A[r][r];
  }
  return x;
}
