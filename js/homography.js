/**
 * Homography — maps points between two planes (image plane <-> real-world plane).
 *
 * Solved with the Direct Linear Transform (DLT): 4 point correspondences give
 * an 8x8 linear system (fixing h33 = 1), solved by Gaussian elimination with
 * partial pivoting. Pure math, no DOM — unit-tested in CI.
 */
export class Homography {
  /** @param {number[][]} matrix 3x3 homography matrix */
  constructor(matrix) {
    this.m = matrix;
  }

  /**
   * Solve the homography that maps src[i] -> dst[i] for 4 point pairs.
   * @param {{x:number,y:number}[]} src 4 points in the source plane
   * @param {{x:number,y:number}[]} dst 4 corresponding points in the destination plane
   * @returns {Homography}
   */
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

  /**
   * Map a point through the homography (with perspective divide).
   * @param {{x:number,y:number}} p
   * @returns {{x:number,y:number}}
   */
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

/**
 * Solve A x = b by Gaussian elimination with partial pivoting.
 * @param {number[][]} A n x n matrix (mutated)
 * @param {number[]} b length-n vector (mutated)
 * @returns {number[]} x
 */
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
