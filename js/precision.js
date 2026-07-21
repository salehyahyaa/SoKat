/**
 * Precision mode — 1/16″ measurement against the printed target
 * (target.html). User flow: tape the target → one photo → the app auto-finds
 * the target and calibrates on its 28 crossings → tap the 2 ends of the
 * width and the 2 ends of the height → both answers with a measured (not
 * assumed) error band. If the band exceeds 1/16″, the
 * user can add a second photo and the two readings are averaged.
 *
 * This file is the DOM glue; all math lives in js/target.js and is tested
 * end-to-end on synthetic photos in tests/precision.test.js.
 */
import { findDiscQuad, orderDiscQuad, refineTarget } from './target.js';
import { toFraction } from './validation.js';
import { RETAKE, HOME } from './flow.js';

const SIXTEENTH = 1 / 16;

const DISC_LABELS = [
  'FIRST black dot (any corner of the target)',
  'SECOND black dot (next corner around)',
  'THIRD black dot',
  'FOURTH black dot',
];

export async function runPrecisionScan(app) {
  await precisionGuide(app);
  let carry = null; // first photo's reading while a 2nd-photo average is underway
  while (true) {
    const shot = await captureAndCalibrate(app, carry != null);
    if (!shot) continue;
    if (shot.quick) {
      // User chose to proceed without the sheet: quick pipeline, same photo,
      // with the reduced-accuracy warning shown on the result.
      await app.runQuickWithPhoto(shot.photo,
        'No printed sheet in the photo — accuracy is about ±5–8%, not 1/16″. '
        + 'Tape the printed target for verified accuracy.');
      return;
    }
    const { photo, calib } = shot;

    let needNewPhoto = false;
    while (!needNewPhoto) {
      const pts = await pickEndpoints(app, photo, calib, carry != null);
      if (pts === RETAKE) { carry = null; needNewPhoto = true; continue; }

      const reading = {
        width: calib.plane.distance(pts[0], pts[1]),
        height: calib.plane.distance(pts[2], pts[3]),
        bandW: calib.plane.band(pts[0], pts[1]),
        bandH: calib.plane.band(pts[2], pts[3]),
      };
      let display = { ...reading, averaged: false };
      if (carry) {
        display = {
          width: (carry.width + reading.width) / 2,
          height: (carry.height + reading.height) / 2,
          // Two independent photos: calibration and taps are independent, so
          // the averaged band tightens by ~sqrt(2).
          bandW: Math.max(carry.bandW, reading.bandW) / Math.SQRT2,
          bandH: Math.max(carry.bandH, reading.bandH) / Math.SQRT2,
          averaged: true,
        };
        carry = null;
      }

      const action = await showPrecisionResult(app, display, calib);
      if (action === 'again') continue;
      if (action === 'improve') { carry = reading; needNewPhoto = true; continue; }
      app.showScreen('welcome');
      return; // done
    }
  }
}

// ------------------------------------------------------------------ screens

function precisionGuide(app) {
  app.showScreen('pguide');
  const btnGo = app.$('btn-pguide-continue');
  const btnHome = app.$('btn-pguide-home');
  return new Promise((resolve, reject) => {
    const onGo = () => { cleanup(); resolve(); };
    const onHome = () => { cleanup(); reject(HOME); };
    const cleanup = () => {
      btnGo.removeEventListener('click', onGo);
      btnHome.removeEventListener('click', onHome);
    };
    btnGo.addEventListener('click', onGo);
    btnHome.addEventListener('click', onHome);
  });
}

// The sheet wasn't detected: let the user say whether it's actually there
// (taped but missed → tap its dots), absent (continue at quick accuracy),
// or worth a retake.
function noSheetChoice(app) {
  app.showScreen('nosheet');
  const btnDots = app.$('btn-nosheet-dots');
  const btnGo = app.$('btn-nosheet-continue');
  const btnRetake = app.$('btn-nosheet-retake');
  return new Promise((resolve) => {
    const finish = (v) => { cleanup(); resolve(v); };
    const onDots = () => finish('dots');
    const onGo = () => finish('continue');
    const onRetake = () => finish('retake');
    const cleanup = () => {
      btnDots.removeEventListener('click', onDots);
      btnGo.removeEventListener('click', onGo);
      btnRetake.removeEventListener('click', onRetake);
    };
    btnDots.addEventListener('click', onDots);
    btnGo.addEventListener('click', onGo);
    btnRetake.addEventListener('click', onRetake);
  });
}

async function captureAndCalibrate(app, isSecondPhoto) {
  const photo = await app.capturePhoto({
    title: isSecondPhoto ? 'Second photo' : 'Photograph the target',
    html: (isSecondPhoto
      ? 'Take <b>another photo</b> of the same target and span, from a slightly different position.'
      : 'Get <b>both</b> in one photo: the taped target <b>and</b> the span you\'re measuring.')
      + '<br>Closer is more accurate — fill the frame.',
  });

  let discs = await app.withLoading('Finding the printed target…', 'looking for the 4 black dots', async () => detectDiscs(photo));
  if (!discs) {
    const choice = await noSheetChoice(app);
    if (choice === 'retake') return null;
    if (choice === 'continue') return { quick: true, photo };
    const pts = await app.pickStage(photo, {
      title: 'Target not found — tap its 4 dots',
      labels: DISC_LABELS,
      illustration: 'wall-quad',
      segments: [[0, 1], [1, 2], [2, 3], [3, 0]],
      validate: () => ({ ok: true, warnings: [] }),
    });
    if (pts === RETAKE) return null;
    discs = await app.withLoading('Matching the target…', '', async () => matchManualDiscs(photo, pts));
    if (!discs) {
      alert('Those 4 points don\'t look like the target\'s dots — check the print and retake the photo.');
      return null;
    }
  }

  try {
    const calib = await app.withLoading('Calibrating…', 'refining the target\'s 28 crossings to sub-pixel', async () => refineTarget(makeCanvasSampler(photo), discs));
    return { photo, calib };
  } catch (err) {
    alert(err.message || String(err));
    return null;
  }
}

function pickEndpoints(app, photo, calib, isSecondPhoto) {
  const plane = calib.plane;
  return app.pickStage(photo, {
    title: isSecondPhoto ? 'Tap the SAME four points' : 'Measure',
    labels: [
      'LEFT end of the WIDTH',
      'RIGHT end of the WIDTH',
      'TOP end of the HEIGHT',
      'BOTTOM end of the HEIGHT',
    ],
    illustration: 'width',
    segments: [[0, 1], [2, 3]],
    segmentLabel: (i, j, a, b) => toFraction(plane.distance(a, b)),
    acceptText: 'Accept',
    doneText: (p) => `W ${toFraction(plane.distance(p[0], p[1]))} × H ${toFraction(plane.distance(p[2], p[3]))} — drag to adjust, then Accept`,
    validate: () => ({ ok: true, warnings: [] }),
  });
}

function showPrecisionResult(app, display, calib) {
  app.showScreen('presult');
  const band = Math.max(display.bandW, display.bandH);
  const verified = band <= SIXTEENTH;
  const badge = app.$('presult-badge');
  badge.textContent = verified
    ? `✓ within ±1/16″ (band ±${bandSixteenths(band)}/16″)`
    : `±${bandSixteenths(band)}/16″ — wider than 1/16″`;
  badge.className = `badge conf-${verified ? 'high' : 'medium'}`;

  app.$('presult-width').textContent = toFraction(display.width);
  app.$('presult-height').textContent = toFraction(display.height);
  app.$('presult-sub').textContent = display.averaged
    ? 'average of two photos'
    : (verified ? '' : 'tighter: retake closer to the target, or add a second photo');
  app.$('presult-diag').textContent =
    `calibrated on ${calib.usedCorners}/28 target crossings · `
    + `held-out calibration check ±${(calib.calibErrIn * 16).toFixed(2)}/16″ at the target · `
    + `${calib.spacingPx.toFixed(0)} px per target inch`;

  const btnImprove = app.$('btn-presult-improve');
  btnImprove.hidden = display.averaged; // one averaging round only
  const btnAgain = app.$('btn-presult-again');
  const btnDone = app.$('btn-presult-done');
  return new Promise((resolve) => {
    const finish = (action) => { cleanup(); resolve(action); };
    const onAgain = () => finish('again');
    const onImprove = () => finish('improve');
    const onDone = () => finish('done');
    const cleanup = () => {
      btnAgain.removeEventListener('click', onAgain);
      btnImprove.removeEventListener('click', onImprove);
      btnDone.removeEventListener('click', onDone);
    };
    btnAgain.addEventListener('click', onAgain);
    btnImprove.addEventListener('click', onImprove);
    btnDone.addEventListener('click', onDone);
  });
}

function bandSixteenths(band) {
  return Math.max(1, Math.ceil(band * 16));
}

// ------------------------------------------------------- pixels & sampling

// Grayscale copy of the photo downscaled to ~maxDim for blob detection.
function grayDownscale(photo, maxDim = 1200) {
  const scale = Math.min(1, maxDim / Math.max(photo.width, photo.height));
  const w = Math.max(1, Math.round(photo.width * scale));
  const h = Math.max(1, Math.round(photo.height * scale));
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photo, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    data[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return { data, width: w, height: h, scaleX: photo.width / w, scaleY: photo.height / h };
}

// Downscaled pixel index (x, y) averages the source block whose center in
// continuous photo coordinates is ((x + 0.5) * scaleX, (y + 0.5) * scaleY).
function upscalePoint(small, p) {
  return { x: (p.x + 0.5) * small.scaleX, y: (p.y + 0.5) * small.scaleY };
}

function detectDiscs(photo) {
  const small = grayDownscale(photo);
  const found = findDiscQuad(small);
  if (!found) return null;
  return found.discsPx.map((p) => upscalePoint(small, p));
}

function matchManualDiscs(photo, tappedPts) {
  const small = grayDownscale(photo);
  const downPts = tappedPts.map((p) => ({ x: p.x / small.scaleX - 0.5, y: p.y / small.scaleY - 0.5 }));
  const ordered = orderDiscQuad(small, downPts);
  if (!ordered) return null;
  return ordered.discsPx.map((p) => upscalePoint(small, p));
}

// Full-resolution grayscale crops straight off the photo canvas, for
// sub-pixel corner refinement. Crop index (i, j) is a sample at continuous
// photo coordinate (x0 + i, y0 + j) — ImageData pixel (x, y) covers
// [x, x+1), i.e. is centered at x + 0.5, hence the half-pixel in x0/y0.
function makeCanvasSampler(photo) {
  const ctx = photo.getContext('2d', { willReadFrequently: true });
  return (cx, cy, half) => {
    const x0 = Math.max(0, Math.round(cx - half - 0.5));
    const y0 = Math.max(0, Math.round(cy - half - 0.5));
    const x1 = Math.min(photo.width, Math.round(cx + half + 0.5));
    const y1 = Math.min(photo.height, Math.round(cy + half + 0.5));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 8 || h < 8) return null;
    const rgba = ctx.getImageData(x0, y0, w, h).data;
    const data = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      data[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    }
    return { data, width: w, height: h, x0: x0 + 0.5, y0: y0 + 0.5 };
  };
}
