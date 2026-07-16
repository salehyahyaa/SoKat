/**
 * Scan validation for the wall-outline measurement flow — every rule that
 * stands between a tap session and a displayed measurement. Pure math, no
 * DOM; unit-tested in CI.
 *
 * Layers:
 *   validateWallQuad  — are the 4 tapped wall corners a plausible outline?
 *   orthoResidual     — does the quad behave like a real rectangle under
 *                       the camera focal (rejects misplaced corners)?
 *   validateEndpoints — are the two measurement endpoints usable, and is
 *                       the measured value physically plausible?
 *   validateResultDims— final bounds + proportion sanity across dimensions.
 * plus confidence scoring and honest display formatting.
 */

// Hard physical bounds (block) and typical closet band (warn) per dimension.
export const PLAUSIBLE = {
  width: { min: 6, max: 240, typicalMin: 18, typicalMax: 96 },
  height: { min: 6, max: 150, typicalMin: 60, typicalMax: 108 },
  depth: { min: 6, max: 120, typicalMin: 12, typicalMax: 48 },
};

export const THRESHOLDS = {
  borderHardPx: 6,
  minPointSepFrac: 0.01, // of image diagonal
  minEndpointSepFrac: 0.05, // of image diagonal
  orthoWarn: 0.08,
  orthoBlock: 0.25,
  focalRangeDiagMin: 0.15,
  focalRangeDiagMax: 4.0,
  maxLeverage: 14, // endpoint distance / paper size, in paper diagonals
  maxDimRatio: 20,
};

// ------------------------------------------------------------- primitives

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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

function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => {
    const k = e.code + '|' + e.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// -------------------------------------------------------- wall outline

// The 4 tapped corners of the back wall, order: bottom-left, bottom-right,
// top-right, top-left. Every failed rule is a specific, actionable message.
export function validateWallQuad(pts, imgW, imgH) {
  const errors = [];
  const warnings = [];
  if (!pts || pts.length !== 4) {
    return { ok: false, errors: [{ code: 'count', message: 'All 4 wall corners are required.' }], warnings, metrics: {} };
  }
  const [bl, br, tr, tl] = pts;
  const names = ['bottom-left', 'bottom-right', 'top-right', 'top-left'];
  const diag = Math.hypot(imgW, imgH);

  pts.forEach((p, i) => {
    const m = Math.min(p.x, p.y, imgW - p.x, imgH - p.y);
    if (m < THRESHOLDS.borderHardPx) {
      errors.push({ code: 'border', message: `The ${names[i]} corner touches the photo edge — step back so the whole wall is in frame.` });
    }
  });
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (dist(pts[i], pts[j]) < THRESHOLDS.minPointSepFrac * diag) {
        errors.push({ code: 'duplicate', message: `The ${names[i]} and ${names[j]} corners are almost on top of each other — re-place one.` });
      }
    }
  }
  if (!isConvexQuad(pts)) {
    errors.push({ code: 'crossed', message: 'The corners cross over — go around the wall: bottom-left, bottom-right, top-right, top-left.' });
  }
  if (errors.length === 0 && quadArea(pts) < 0.015 * imgW * imgH) {
    errors.push({ code: 'quad-small', message: 'The wall outline is too small in the photo — step closer.' });
  }
  const clearance = 0.03 * imgH;
  if (!(tl.y < bl.y - clearance)) errors.push({ code: 'top-below', message: 'The top-left corner must be clearly above the bottom-left corner.' });
  if (!(tr.y < br.y - clearance)) errors.push({ code: 'top-below', message: 'The top-right corner must be clearly above the bottom-right corner.' });
  const tilt = (a, b) => Math.abs(Math.atan2(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 180 / Math.PI);
  if (tilt(bl, tl) > 35) errors.push({ code: 'side-tilt', message: 'The left side leans too far — top-left should be roughly above bottom-left.' });
  if (tilt(br, tr) > 35) errors.push({ code: 'side-tilt', message: 'The right side leans too far — top-right should be roughly above bottom-right.' });

  return { ok: errors.length === 0, errors: dedupe(errors), warnings, metrics: { areaFrac: quadArea(pts) / (imgW * imgH) } };
}

// Line intersection of infinite lines; null when ~parallel.
export function lineIntersection(a1, a2, b1, b2) {
  const d1 = sub(a2, a1); const d2 = sub(b2, b1);
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-9) return null;
  const s = cross(sub(b1, a1), d2) / den;
  return { x: a1.x + s * d1.x, y: a1.y + s * d1.y };
}

// Focal from the quad's two vanishing points (orthogonal edge directions).
export function focalFromVanishingPoints(pts, cx, cy) {
  const v1 = lineIntersection(pts[0], pts[1], pts[3], pts[2]);
  const v2 = lineIntersection(pts[0], pts[3], pts[1], pts[2]);
  if (!v1 || !v2) return null;
  const f2 = -((v1.x - cx) * (v2.x - cx) + (v1.y - cy) * (v2.y - cy));
  return f2 > 0 ? Math.sqrt(f2) : null;
}

// |cos| between the K⁻¹ homography columns — ~0 when the tapped quad really
// is a rectangle under focal f; grows when it isn't (bad corner placement).
export function orthoResidual(h1, h2, f, cx, cy) {
  const k = (h) => [(h[0] - h[2] * cx) / f, (h[1] - h[2] * cy) / f, h[2]];
  const a = k(h1); const b = k(h2);
  const na = Math.hypot(...a); const nb = Math.hypot(...b);
  if (na < 1e-12 || nb < 1e-12) return 1;
  return Math.abs((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb));
}

// -------------------------------------------------------------- endpoints

// Endpoint pair for one dimension; valueIn is the plane-measured distance.
export function validateEndpoints(pts, dim, valueIn, imgW, imgH, paperPts) {
  const errors = [];
  const warnings = [];
  const metrics = {};
  const diag = Math.hypot(imgW, imgH);
  if (!pts || pts.length !== 2) {
    return { ok: false, errors: [{ code: 'count', message: 'Both endpoints are required.' }], warnings, metrics };
  }
  if (dist(pts[0], pts[1]) < THRESHOLDS.minEndpointSepFrac * diag) {
    errors.push({ code: 'endpoints-close', message: 'The two endpoints are almost the same spot — tap the two ends of the distance you\'re measuring.' });
  }
  pts.forEach((p, i) => {
    const m = Math.min(p.x, p.y, imgW - p.x, imgH - p.y);
    if (m < THRESHOLDS.borderHardPx) {
      errors.push({ code: 'border', message: `Endpoint ${i + 1} touches the photo edge — that corner isn't in frame. Retake from further back.` });
    }
  });

  // Leverage: how far the measurement extrapolates beyond the calibrated
  // sheet — the main error amplifier of this method.
  if (paperPts?.length === 4) {
    const cxp = paperPts.reduce((a, p) => a + p.x, 0) / 4;
    const cyp = paperPts.reduce((a, p) => a + p.y, 0) / 4;
    const paperDiag = Math.max(...paperPts.map((p) => dist(p, { x: cxp, y: cyp }))) * 2;
    const far = Math.max(...pts.map((p) => dist(p, { x: cxp, y: cyp })));
    metrics.leverage = paperDiag > 0 ? far / paperDiag : Infinity;
    if (metrics.leverage > THRESHOLDS.maxLeverage) {
      warnings.push({ code: 'leverage', message: 'The endpoints are very far from the sheet — accuracy drops with distance from the reference' });
    }
  }

  const b = PLAUSIBLE[dim];
  if (!Number.isFinite(valueIn) || valueIn < b.min || valueIn > b.max) {
    errors.push({
      code: 'implausible',
      message: `Measured ${dim} of ${Number.isFinite(valueIn) ? valueIn.toFixed(1) : '—'}″ is outside anything plausible (${b.min}–${b.max}″) — the reference corners or the endpoints are misplaced.`,
    });
  } else if (valueIn < b.typicalMin || valueIn > b.typicalMax) {
    warnings.push({ code: 'atypical', message: `${dim} of ${valueIn.toFixed(0)}″ is outside the typical closet range (${b.typicalMin}–${b.typicalMax}″)` });
  }
  return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings), metrics };
}

// ---------------------------------------------------------------- results

export function validateResultDims(dims) {
  const errors = [];
  const warnings = [];
  for (const [dim, v] of Object.entries(dims)) {
    const b = PLAUSIBLE[dim];
    if (!Number.isFinite(v) || v < b.min || v > b.max) {
      errors.push({ code: 'implausible', message: `The ${dim} (${Number.isFinite(v) ? v.toFixed(1) : '—'}″) is outside anything plausible for a closet (${b.min}–${b.max}″).` });
    } else if (v < b.typicalMin || v > b.typicalMax) {
      warnings.push({ code: 'atypical', message: `${dim} of ${v.toFixed(0)}″ is outside the typical closet range` });
    }
  }
  const vals = Object.values(dims).filter(Number.isFinite);
  if (vals.length >= 2) {
    const ratio = Math.max(...vals) / Math.max(1e-9, Math.min(...vals));
    if (ratio > THRESHOLDS.maxDimRatio) {
      errors.push({ code: 'implausible-ratio', message: `The dimensions are wildly out of proportion (${ratio.toFixed(0)}:1) — one of the scans is wrong.` });
    }
  }
  return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings) };
}

// -------------------------------------------------------------- confidence

// Per-view score; the scan's overall confidence is the weakest view.
export function confidenceView({
  paperAreaFrac = 0.01,
  orthoResidual: ortho = null,
  normRatio = 1,
  leverage = 3,
  megapixels = 12,
  hasExifFocal = false,
  focalDisagreePct = null,
  warnings = 0,
} = {}) {
  let score = 100;
  const reasons = [];
  if (paperAreaFrac < 0.004) { score -= 15; reasons.push('reference is small in the photo'); }
  if (ortho != null) {
    const d = Math.min(25, ortho * 150);
    if (d > 5) reasons.push('reference only approximately rectangular');
    score -= d;
  }
  {
    const ratioErr = Math.abs(Math.log(normRatio || 1));
    const d = Math.min(20, ratioErr * 80);
    if (d > 5) reasons.push('reference proportions look off');
    score -= d;
  }
  {
    const d = Math.min(25, Math.max(0, leverage - 3) * 2.5);
    if (d > 6) reasons.push('endpoints far from the reference');
    score -= d;
  }
  if (megapixels < 2) { score -= 10; reasons.push('low photo resolution'); }
  if (!hasExifFocal) { score -= 5; reasons.push('no camera focal data'); }
  if (focalDisagreePct != null && focalDisagreePct > 25) { score -= 10; reasons.push('perspective/camera focal disagree'); }
  score -= Math.min(10, warnings * 4);
  score = Math.max(0, Math.round(score));
  const level = score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low';
  return { score, level, reasons };
}

export function confidenceOverall(views, resultWarnings = 0) {
  let score = Math.min(...views.map((v) => v.score));
  const reasons = dedupeStrings(views.flatMap((v) => v.reasons));
  score -= Math.min(10, resultWarnings * 4);
  if (resultWarnings > 0) reasons.push('dimensions outside the typical closet range');
  score = Math.max(0, Math.round(score));
  const level = score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low';
  return { score, level, reasons };
}

function dedupeStrings(a) { return [...new Set(a)]; }

// -------------------------------------------------------------- display

// Carpenter fraction; den=16 for the standard display. Display resolution,
// not an accuracy claim — the ± band and Validation mode carry accuracy.
export function toFraction(inches, den = 16) {
  const units = Math.round(inches * den);
  const whole = Math.floor(units / den);
  let num = units - whole * den;
  let d = den;
  while (num > 0 && num % 2 === 0) { num /= 2; d /= 2; }
  return num === 0 ? `${whole}″` : `${whole} ${num}/${d}″`;
}

export function feetInches(inches) {
  // Round to sixteenths FIRST, then carry into feet — otherwise 83.999″
  // renders as the impossible "6′ 12″".
  const units = Math.round(inches * 16);
  const ft = Math.floor(units / 192);
  const rest = (units - ft * 192) / 16;
  if (ft === 0) return toFraction(rest);
  return rest === 0 ? `${ft}′` : `${ft}′ ${toFraction(rest)}`;
}

// Expected relative error (%) for one measured dimension.
export function errorBandPct({ leverage = 1, orthoResidual: ortho = 0, autoScale = true } = {}) {
  let pct = autoScale ? 8 : 1; // phone-height assumption dominates until corrected
  pct += Math.max(0, leverage - 1) * 0.35;
  pct += (ortho || 0) * 25;
  return Math.min(25, Math.max(0.5, Math.round(pct * 10) / 10));
}
