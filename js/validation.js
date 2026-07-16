/**
 * Scan validation — every rule that stands between a tap session and a
 * displayed measurement. Pure math, no DOM; unit-tested in CI.
 *
 * Three layers:
 *   validateGeometry  — are the 6 tapped points a plausible box at all?
 *   crossChecks       — do independent estimates agree (heights L/R, floor
 *                       rectangularity, vertical edges, focal sources)?
 *   validateResult    — are the scaled dimensions physically plausible for
 *                       a closet-like space?
 * plus confidence() which folds the evidence into High/Medium/Low, and
 * honest display formatting helpers.
 *
 * Point order everywhere: [backBottomLeft, backBottomRight, frontBottomLeft,
 * frontBottomRight, backTopLeft, backTopRight] in image pixels (y down).
 */

// ---------------------------------------------------------------- bounds

export const REFERENCE_RANGES = {
  width: { min: 12, max: 120, label: 'width' },
  height: { min: 30, max: 144, label: 'height' },
  depth: { min: 8, max: 72, label: 'depth' },
};
export const CUSTOM_RANGE = { min: 1, max: 300 };

// Hard physical bounds for a closet-like space; results outside are blocked.
export const RESULT_BOUNDS = {
  width: { min: 6, max: 240 },
  height: { min: 6, max: 150 },
  depth: { min: 6, max: 120 },
};
// Typical closet band; outside it we warn and lower confidence, not block.
export const TYPICAL_BOUNDS = {
  width: { min: 18, max: 96 },
  height: { min: 60, max: 108 },
  depth: { min: 12, max: 48 },
};

export const THRESHOLDS = {
  borderHardPx: 8,
  borderHardFrac: 0.005,
  borderWarnFrac: 0.02,
  minPointSepFrac: 0.02, // of image diagonal
  minFloorAreaFrac: 0.015, // of image area
  minTopClearanceFrac: 0.03, // of image height
  maxVerticalTiltDeg: 35,
  maxVerticalMutualDeg: 25,
  minFrontBackEdgeRatio: 0.7,
  focalRangeDiagMin: 0.2,
  focalRangeDiagMax: 3.0,
  heightDisagreeWarnPct: 12,
  heightDisagreeBlockPct: 25,
  orthoWarn: 0.12,
  orthoBlock: 0.30,
  vertAngleWarnDeg: 10,
  vertAngleBlockDeg: 20,
  focalDisagreeWarnPct: 30,
  maxDimRatio: 20,
  camHeightMinIn: 18,
  camHeightMaxIn: 90,
};

// ------------------------------------------------------------- geometry

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Proper intersection of open segments (excluding shared endpoints).
export function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(sub(p2, p1), sub(p3, p1));
  const d2 = cross(sub(p2, p1), sub(p4, p1));
  const d3 = cross(sub(p4, p3), sub(p1, p3));
  const d4 = cross(sub(p4, p3), sub(p2, p3));
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// Quad given as a cycle; simple + convex when all corner turns share a sign.
export function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(sub(q[(i + 1) % 4], q[i]), sub(q[(i + 2) % 4], q[(i + 1) % 4]));
    if (Math.abs(c) < 1e-9) return false;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i]; const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

function angleFromVerticalDeg(a, b) {
  // image y grows downward; a->b treated as bottom->top edge
  const dx = b.x - a.x; const dy = b.y - a.y;
  return Math.abs(Math.atan2(Math.abs(dx), Math.abs(dy)) * 180 / Math.PI);
}

function angleBetweenDeg(u, v) {
  const du = Math.hypot(u.x, u.y); const dv = Math.hypot(v.x, v.y);
  if (du < 1e-9 || dv < 1e-9) return 0;
  const c = Math.min(1, Math.max(-1, (u.x * v.x + u.y * v.y) / (du * dv)));
  return Math.acos(c) * 180 / Math.PI;
}

// Every failed rule becomes {code, message}; messages tell the user exactly
// what to fix instead of producing absurd numbers.
export function validateGeometry(pts, imgW, imgH) {
  const errors = [];
  const warnings = [];
  if (!pts || pts.length !== 6) {
    return { ok: false, errors: [{ code: 'count', message: 'All 6 corners are required' }], warnings };
  }
  const [bl, br, fl, fr, tl, tr] = pts;
  const names = ['back-bottom-left', 'back-bottom-right', 'front-bottom-left',
    'front-bottom-right', 'back-top-left', 'back-top-right'];
  const diag = Math.hypot(imgW, imgH);

  // Image-border proximity.
  const hard = Math.max(THRESHOLDS.borderHardPx, THRESHOLDS.borderHardFrac * Math.min(imgW, imgH));
  const warn = THRESHOLDS.borderWarnFrac * Math.min(imgW, imgH);
  pts.forEach((p, i) => {
    const m = Math.min(p.x, p.y, imgW - p.x, imgH - p.y);
    if (m < hard) errors.push({ code: 'border', message: `The ${names[i]} point sits on the photo edge — that corner isn't fully in frame. Retake from further back.` });
    else if (m < warn) warnings.push({ code: 'border', message: `The ${names[i]} point is very close to the photo edge` });
  });

  // Duplicated / nearly identical points.
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      if (dist(pts[i], pts[j]) < THRESHOLDS.minPointSepFrac * diag) {
        errors.push({ code: 'duplicate', message: `The ${names[i]} and ${names[j]} points are almost on top of each other — re-place one of them.` });
      }
    }
  }

  // Floor quadrilateral: cycle bl -> br -> fr -> fl.
  const floor = [bl, br, fr, fl];
  if (!isConvexQuad(floor)) {
    errors.push({ code: 'floor-shape', message: 'The 4 floor points cross over each other — they must outline the floor going back-left, back-right, front-left, front-right.' });
  } else if (quadArea(floor) < THRESHOLDS.minFloorAreaFrac * imgW * imgH) {
    errors.push({ code: 'floor-small', message: 'The floor area is too small in the photo — step closer or zoom so the space fills more of the frame.' });
  }

  // Front edge should not be dramatically shorter than the back edge
  // (the nearer edge appears longer under real perspective).
  if (dist(fl, fr) < THRESHOLDS.minFrontBackEdgeRatio * dist(bl, br)) {
    errors.push({ code: 'perspective', message: 'The front floor edge looks shorter than the back edge — the front/back floor points are likely swapped or misplaced.' });
  }

  // Top points must sit clearly above their floor points.
  const clearance = THRESHOLDS.minTopClearanceFrac * imgH;
  if (!(tl.y < bl.y - clearance)) errors.push({ code: 'top-below', message: 'The back-top-left point must be clearly above the back-bottom-left point.' });
  if (!(tr.y < br.y - clearance)) errors.push({ code: 'top-below', message: 'The back-top-right point must be clearly above the back-bottom-right point.' });

  // Back-wall vertical edges: near-vertical, mutually consistent, not crossing.
  const tiltL = angleFromVerticalDeg(bl, tl);
  const tiltR = angleFromVerticalDeg(br, tr);
  if (tiltL > THRESHOLDS.maxVerticalTiltDeg) errors.push({ code: 'vertical-tilt', message: `The left wall edge leans ${tiltL.toFixed(0)}° — back-top-left should be roughly above back-bottom-left.` });
  if (tiltR > THRESHOLDS.maxVerticalTiltDeg) errors.push({ code: 'vertical-tilt', message: `The right wall edge leans ${tiltR.toFixed(0)}° — back-top-right should be roughly above back-bottom-right.` });
  if (angleBetweenDeg(sub(tl, bl), sub(tr, br)) > THRESHOLDS.maxVerticalMutualDeg) {
    errors.push({ code: 'vertical-mutual', message: 'The two wall edges lean in very different directions — adjust the top points.' });
  }
  if (segmentsIntersect(bl, tl, br, tr)) {
    errors.push({ code: 'vertical-cross', message: 'The left and right wall edges cross each other — the left/right points are swapped.' });
  }
  // Top edge crossing the floor outline.
  for (const [a, b] of [[bl, br], [fl, fr], [bl, fl], [br, fr]]) {
    if (segmentsIntersect(tl, tr, a, b)) {
      errors.push({ code: 'top-cross', message: 'The ceiling edge crosses the floor outline — re-place the top points.' });
      break;
    }
  }

  return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings) };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => {
    const k = e.code + '|' + e.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------- pose cross-checks

// Project a 3D plane-frame point through the metrology's recovered pose.
export function projectPoint(metro, X, Y, Z) {
  const [r1, r2, r3] = metro.R;
  const C = metro.C;
  const t = [
    -(C[0] * r1[0] + C[1] * r2[0] + C[2] * r3[0]),
    -(C[0] * r1[1] + C[1] * r2[1] + C[2] * r3[1]),
    -(C[0] * r1[2] + C[1] * r2[2] + C[2] * r3[2]),
  ];
  const xc = X * r1[0] + Y * r2[0] + Z * r3[0] + t[0];
  const yc = X * r1[1] + Y * r2[1] + Z * r3[1] + t[1];
  const zc = X * r1[2] + Y * r2[2] + Z * r3[2] + t[2];
  return { x: metro.cx + metro.f * xc / zc, y: metro.cy + metro.f * yc / zc, zc };
}

// Line intersection (infinite lines through a1-a2 and b1-b2); null if ~parallel.
export function lineIntersection(a1, a2, b1, b2) {
  const d1 = sub(a2, a1); const d2 = sub(b2, b1);
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-9) return null;
  const s = cross(sub(b1, a1), d2) / den;
  return { x: a1.x + s * d1.x, y: a1.y + s * d1.y };
}

// Focal from the floor rectangle's two vanishing points (orthogonal
// directions): f^2 = -(v1-c).(v2-c). Null when either VP is at infinity.
export function focalFromVanishingPoints(pts, cx, cy) {
  const [bl, br, fl, fr] = pts;
  const v1 = lineIntersection(bl, br, fl, fr); // width direction
  const v2 = lineIntersection(bl, fl, br, fr); // depth direction
  if (!v1 || !v2) return null;
  const f2 = -((v1.x - cx) * (v2.x - cx) + (v1.y - cy) * (v2.y - cy));
  return f2 > 0 ? Math.sqrt(f2) : null;
}

// Orthogonality residual of the floor homography under a given focal:
// |cos angle(r1, r2)|. ~0 for a true rectangle; grows when the four floor
// taps do not actually outline a rectangle (e.g. a couch seat).
export function orthoResidual(h1, h2, f, cx, cy) {
  const k = (h) => [(h[0] - h[2] * cx) / f, (h[1] - h[2] * cy) / f, h[2]];
  const a = k(h1); const b = k(h2);
  const na = Math.hypot(a[0], a[1], a[2]);
  const nb = Math.hypot(b[0], b[1], b[2]);
  if (na < 1e-12 || nb < 1e-12) return 1;
  return Math.abs((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb));
}

// Independent-estimate agreement checks; needs the metrology + raw taps.
// Returns metrics plus error/warning lists (same shape as validateGeometry).
export function crossChecks({ metro, pts, imgW, imgH, exifFocal = null, homographyColumns = null }) {
  const [bl, br, fl, fr, tl, tr] = pts;
  const errors = [];
  const warnings = [];
  const diag = Math.hypot(imgW, imgH);
  const metrics = {};

  // Heights measured independently on the left and right wall edges.
  let hL; let hR;
  try {
    hL = metro.wallHeight(bl, br, tl);
    hR = metro.wallHeight(bl, br, tr);
  } catch (err) {
    errors.push({ code: 'height-unsolvable', message: `The top corners can't be placed in 3D from this geometry (${err.message}). Adjust the points or retake the photo.` });
    return { ok: false, errors: dedupe(errors), warnings: dedupe(warnings), metrics };
  }
  metrics.heightLeft = hL;
  metrics.heightRight = hR;
  metrics.heightDisagreePct = Math.abs(hL - hR) / ((hL + hR) / 2) * 100;
  if (metrics.heightDisagreePct > THRESHOLDS.heightDisagreeBlockPct) {
    errors.push({ code: 'height-disagree', message: `The left and right height estimates disagree by ${metrics.heightDisagreePct.toFixed(0)}% — adjust the top corner points or retake the photo.` });
  } else if (metrics.heightDisagreePct > THRESHOLDS.heightDisagreeWarnPct) {
    warnings.push({ code: 'height-disagree', message: `Left/right height estimates differ by ${metrics.heightDisagreePct.toFixed(0)}%` });
  }

  // Floor rectangularity: with a trusted focal, a real rectangle's rotation
  // columns are orthogonal. This is the check that rejects non-box targets.
  if (homographyColumns) {
    const f = exifFocal || metro.f;
    metrics.orthoResidual = orthoResidual(homographyColumns.h1, homographyColumns.h2, f, imgW / 2, imgH / 2);
    if (metrics.orthoResidual > THRESHOLDS.orthoBlock) {
      errors.push({ code: 'not-rectangle', message: 'The 4 floor points don\'t form a rectangle in perspective — this doesn\'t look like a box-shaped space. Check the corner placement, or note that irregular objects aren\'t supported.' });
    } else if (metrics.orthoResidual > THRESHOLDS.orthoWarn) {
      warnings.push({ code: 'not-rectangle', message: 'The floor outline is only approximately rectangular' });
    }
  }

  // Tapped vertical edges vs the pose's predicted vertical direction.
  for (const [floorPt, topPt, side] of [[bl, tl, 'left'], [br, tr, 'right']]) {
    const w = metro.toWorld(floorPt);
    const p0 = projectPoint(metro, w.x, w.y, 0);
    const p1 = projectPoint(metro, w.x, w.y, 0.5);
    const predicted = sub(p1, p0);
    const tapped = sub(topPt, floorPt);
    // The plane frame's +z sign is arbitrary (only |height| is used), so
    // compare directions sign-agnostically.
    const raw = angleBetweenDeg(predicted, tapped);
    const err = Math.min(raw, 180 - raw);
    metrics[side === 'left' ? 'vertAngleLeftDeg' : 'vertAngleRightDeg'] = err;
    if (err > THRESHOLDS.vertAngleBlockDeg) {
      errors.push({ code: 'vertical-inconsistent', message: `The ${side} wall edge disagrees with the floor perspective by ${err.toFixed(0)}° — the top point probably isn't directly above the bottom one.` });
    } else if (err > THRESHOLDS.vertAngleWarnDeg) {
      warnings.push({ code: 'vertical-inconsistent', message: `The ${side} wall edge is ${err.toFixed(0)}° off the expected vertical` });
    }
  }

  // Focal agreement: EXIF vs vanishing-point estimate.
  const fVP = focalFromVanishingPoints([bl, br, fl, fr], imgW / 2, imgH / 2);
  metrics.focalVP = fVP;
  metrics.focalEXIF = exifFocal;
  metrics.focalUsed = metro.f;
  if (fVP != null && (fVP < THRESHOLDS.focalRangeDiagMin * diag || fVP > THRESHOLDS.focalRangeDiagMax * diag)) {
    if (!exifFocal) {
      errors.push({ code: 'focal-implausible', message: 'The perspective of the floor outline is implausible (no camera data to cross-check) — retake the photo from a natural standing angle.' });
    } else {
      warnings.push({ code: 'focal-implausible', message: 'Vanishing-point focal estimate out of range' });
    }
  }
  if (fVP != null && exifFocal) {
    metrics.focalDisagreePct = Math.abs(fVP - exifFocal) / exifFocal * 100;
    if (metrics.focalDisagreePct > THRESHOLDS.focalDisagreeWarnPct) {
      warnings.push({ code: 'focal-disagree', message: `Perspective-derived focal differs ${metrics.focalDisagreePct.toFixed(0)}% from the camera's — floor outline may not be rectangular` });
    }
  }

  // Camera pitch: near-zero pitch means the floor is seen almost edge-on
  // and depth is ill-conditioned.
  const vd = [metro.R[0][2], metro.R[1][2], metro.R[2][2]]; // view dir, plane frame
  metrics.camPitchDeg = Math.abs(Math.asin(Math.max(-1, Math.min(1, vd[2]))) * 180 / Math.PI);
  if (metrics.camPitchDeg < 5) {
    warnings.push({ code: 'shallow-pitch', message: 'The camera looks almost straight ahead — angle the phone slightly downward for a better floor view' });
  }

  return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings), metrics };
}

// ------------------------------------------------------------ reference

export function validateReference(dim, valueIn, { custom = false } = {}) {
  if (!Number.isFinite(valueIn) || valueIn <= 0) {
    return { ok: false, message: 'Enter the measurement in inches (a positive number).' };
  }
  const range = custom ? CUSTOM_RANGE : REFERENCE_RANGES[dim];
  if (!range) return { ok: false, message: 'Unknown dimension.' };
  if (valueIn < range.min || valueIn > range.max) {
    return {
      ok: false,
      message: custom
        ? `Even as a custom value, ${valueIn}″ is outside ${range.min}–${range.max}″.`
        : `${valueIn}″ is outside the typical closet ${dim} range (${range.min}–${range.max}″). Use "custom value" if it's really ${valueIn}″.`,
    };
  }
  return { ok: true };
}

// -------------------------------------------------------------- results

export function validateResult(dims, { camHeightIn = null } = {}) {
  const errors = [];
  const warnings = [];
  for (const [dim, v] of Object.entries(dims)) {
    const hardB = RESULT_BOUNDS[dim];
    if (!Number.isFinite(v) || v < hardB.min || v > hardB.max) {
      errors.push({
        code: 'implausible',
        message: `The calculated ${dim} (${Number.isFinite(v) ? v.toFixed(1) : '—'}″) is outside anything plausible for a closet-like space (${hardB.min}–${hardB.max}″). The corner placement or the reference measurement is wrong — adjust and try again.`,
      });
      continue;
    }
    const band = TYPICAL_BOUNDS[dim];
    if (v < band.min || v > band.max) {
      warnings.push({ code: 'atypical', message: `${dim} of ${v.toFixed(0)}″ is outside the typical closet range (${band.min}–${band.max}″)` });
    }
  }
  const vals = Object.values(dims).filter(Number.isFinite);
  if (vals.length === 3) {
    const ratio = Math.max(...vals) / Math.max(1e-9, Math.min(...vals));
    if (ratio > THRESHOLDS.maxDimRatio) {
      errors.push({ code: 'implausible-ratio', message: `The dimensions are wildly out of proportion (${ratio.toFixed(0)}:1) — the corner points don't describe a real box.` });
    }
  }
  if (camHeightIn != null && Number.isFinite(camHeightIn)
      && (camHeightIn < THRESHOLDS.camHeightMinIn || camHeightIn > THRESHOLDS.camHeightMaxIn)) {
    warnings.push({ code: 'cam-height', message: `The implied camera height is ${camHeightIn.toFixed(0)}″ — the photo may not have been taken from a normal standing position, or the reference is off` });
  }
  return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings) };
}

// ------------------------------------------------------------ confidence

// Folds the evidence into a score. High >= 75, Medium >= 50, else Low.
export function confidence({
  hasExifFocal = false,
  focalDisagreePct = null,
  orthoResidual: ortho = null,
  heightDisagreePct = 0,
  vertAngleMaxDeg = 0,
  camPitchDeg = 20,
  megapixels = 12,
  borderWarnings = 0,
  resultWarnings = 0,
} = {}) {
  let score = 100;
  const reasons = [];
  if (!hasExifFocal) { score -= 25; reasons.push('no camera focal data in the photo'); }
  if (focalDisagreePct != null) {
    const d = Math.min(25, focalDisagreePct * 0.8);
    if (d > 4) reasons.push(`perspective/camera focal disagree ${focalDisagreePct.toFixed(0)}%`);
    score -= d;
  }
  if (ortho != null) {
    const d = Math.min(25, ortho * 120);
    if (d > 5) reasons.push('floor outline only approximately rectangular');
    score -= d;
  }
  {
    const d = Math.min(25, heightDisagreePct * 1.5);
    if (d > 5) reasons.push(`left/right heights differ ${heightDisagreePct.toFixed(0)}%`);
    score -= d;
  }
  {
    const d = Math.min(15, Math.max(0, vertAngleMaxDeg - 3) * 1.2);
    if (d > 4) reasons.push('wall edges off the expected vertical');
    score -= d;
  }
  if (camPitchDeg < 8) { score -= 15; reasons.push('very shallow camera angle'); }
  if (megapixels < 2) { score -= 10; reasons.push('low photo resolution'); }
  score -= Math.min(10, borderWarnings * 5);
  if (borderWarnings > 0) reasons.push('corners very close to the photo edge');
  score -= Math.min(10, resultWarnings * 5);
  if (resultWarnings > 0) reasons.push('dimensions outside the typical closet range');

  score = Math.max(0, Math.round(score));
  const level = score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low';
  return { score, level, reasons };
}

// -------------------------------------------------------------- display

// Honest display rounding: quarter-inch by default. Finer formatting is a
// display choice, not a proof of accuracy — see docs/VALIDATION.md.
export function toFraction(inches, den = 4) {
  const units = Math.round(inches * den);
  const whole = Math.floor(units / den);
  let num = units - whole * den;
  let d = den;
  while (num > 0 && num % 2 === 0) { num /= 2; d /= 2; }
  return num === 0 ? `${whole}″` : `${whole} ${num}/${d}″`;
}

// Expected relative error band (%) given the evidence — shown next to
// results so display precision is never confused with accuracy.
export function errorBandPct(metrics, hasExifFocal) {
  let pct = 3; // best case: tap noise on a good photo
  if (!hasExifFocal) pct += 4;
  if (metrics?.heightDisagreePct != null) pct += metrics.heightDisagreePct / 2;
  if (metrics?.orthoResidual != null) pct += metrics.orthoResidual * 40;
  if (metrics?.focalDisagreePct != null) pct += metrics.focalDisagreePct / 8;
  return Math.min(30, Math.round(pct));
}
