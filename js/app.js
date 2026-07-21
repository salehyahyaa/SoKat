/**
 * SpaceScanApp — zero-input measurement from one photo.
 *
 * Sensor: the iPhone camera via Safari's <input capture> (no LiDAR/ARKit/
 * WebXR — Safari doesn't expose them). Flow: photograph the back wall →
 * tap its 4 corners → tap 2 points for height (confirm) → 2 points for
 * width (confirm) → results. Nothing to type, no reference object.
 *
 * Scale: the wall outline plus the camera focal (EXIF, or recovered from
 * the outline's vanishing points) yields the camera pose up to scale;
 * assuming a vertical wall on a horizontal floor, the camera's height above
 * the floor is known in wall units, and a typical phone-holding height
 * (58″) sets absolute scale — proven exact on synthetic ground truth in
 * tests/metrology.test.js. That assumption is the dominant error (±8%
 * band shown); tapping a result lets the user correct one number and the
 * other rescales. Every stage is validated; low confidence blocks.
 */
import { CameraCapture } from './camera.js';
import { CornerPicker } from './picker.js';
import { rectangleMetrology } from './metrology.js';
import { buildEmptiedViews, PhotoEraser } from './emptier.js';
import { runPrecisionScan } from './precision.js';
import {
  validateWallQuad, validateEndpoints, validateResultDims, orthoResidual,
  focalFromVanishingPoints, confidenceView, confidenceOverall,
  toFraction, feetInches, errorBandPct, PLAUSIBLE,
} from './validation.js';

import { RETAKE, HOME } from './flow.js';

const TARGET_COLOR = '#00e5a0';
const QUAD_COLOR = '#4da3ff';
const PHONE_HEIGHT_IN = 58; // typical standing chest-height phone hold

const WALL_LABELS = [
  'BOTTOM-LEFT corner of the back wall',
  'BOTTOM-RIGHT corner',
  'TOP-RIGHT corner',
  'TOP-LEFT corner',
];
const ENDPOINT_LABELS = {
  height: ['BOTTOM of the height you\'re measuring', 'TOP, straight above'],
  width: ['LEFT end of the width', 'RIGHT end'],
};

export class SpaceScanApp {
  constructor(doc = document) {
    this.doc = doc;
    this.$ = (id) => doc.getElementById(id);
    this.camera = new CameraCapture(this.$('camera-input'));
    this.picker = null;
    this.eraserView = null;

    this.mode = 'quick';
    this.$('mode-list').addEventListener('click', (e) => {
      const card = e.target.closest('.mode-card');
      if (!card) return;
      this.mode = card.dataset.mode;
      for (const c of this.doc.querySelectorAll('.mode-card')) {
        c.classList.toggle('selected', c === card);
      }
    });
    this.$('btn-start').addEventListener('click', () => {
      if (this.mode === 'lidar') { this.showScreen('lidar'); return; }
      this.runGuarded(() => (this.mode === 'precision' ? runPrecisionScan(this) : this.runScan()));
    });
    this.$('btn-lidar-home').addEventListener('click', () => this.showScreen('welcome'));
    this.$('btn-restart').addEventListener('click', () => this.showScreen('welcome'));
    this.$('dims').addEventListener('click', (e) => this.onDimTap(e));
    this.$('btn-erase-undo').addEventListener('click', () => { if (this.eraserView) this.eraserView.undo(); });
    this.$('btn-erase-reset').addEventListener('click', () => { if (this.eraserView) this.eraserView.reset(); });
    this.$('btn-diagnostics').addEventListener('click', () => {
      const p = this.$('diag-panel');
      p.hidden = !p.hidden;
    });
    this.showScreen('welcome');
    // Deep link used by the iOS app's mode picker.
    if (new URLSearchParams(window.location.search).get('mode') === 'precision') {
      this.runGuarded(() => runPrecisionScan(this));
    }
  }

  async runGuarded(fn) {
    if (this.busy) return; // ignore double-taps
    this.busy = true;
    try {
      await fn();
    } catch (err) {
      if (err !== HOME) alert(`Something went wrong: ${err.message || err}`);
      this.showScreen('welcome');
    } finally {
      this.teardownPicker();
      this.setOverlay(false);
      this.busy = false;
    }
  }

  showScreen(name) {
    for (const s of this.doc.querySelectorAll('.screen')) s.classList.remove('active');
    this.$(`screen-${name}`).classList.add('active');
  }

  teardownPicker() {
    if (this.picker) { this.picker.destroy(); this.picker = null; }
  }

  setOverlay(on, { title = '', sub = '' } = {}) {
    const overlay = this.$('loading-overlay');
    this.$('loading-title').textContent = title;
    this.$('loading-sub').textContent = sub;
    overlay.classList.toggle('active', on);
  }

  async withLoading(title, sub, work, minMs = 900) {
    this.setOverlay(true, { title, sub });
    const t0 = performance.now();
    try {
      await new Promise((r) => requestAnimationFrame(() => r()));
      const result = await work();
      const left = minMs - (performance.now() - t0);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      return result;
    } finally {
      this.setOverlay(false);
    }
  }

  // ------------------------------------------------------------------ guide

  showGuide() {
    this.showScreen('guide');
    drawIllustration(this.$('guide-large'), 'wall-quad');
    const btnGo = this.$('btn-guide-continue');
    const btnHome = this.$('btn-guide-home');
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

  // ---------------------------------------------------------------- capture

  capturePhoto({
    title = 'One photo',
    html = '<b>Stand up</b>, phone at chest height — that\'s how the app knows '
      + 'the scale.<br>Photograph the <b>whole back wall</b>, floor to ceiling.',
    illustration = 'wall-quad',
  } = {}) {
    this.showScreen('capture');
    this.$('capture-title').textContent = title;
    this.$('capture-text').innerHTML = html;
    drawIllustration(this.$('capture-illust'), illustration);
    const btnCam = this.$('btn-open-camera');
    const btnBack = this.$('btn-capture-home');
    return new Promise((resolve, reject) => {
      const onCam = () => this.camera.request();
      const onBack = () => { cleanup(); reject(HOME); };
      const cleanup = () => {
        btnCam.removeEventListener('click', onCam);
        btnBack.removeEventListener('click', onBack);
        this.camera.unsubscribe();
      };
      this.camera.onPhoto = (photo) => { cleanup(); resolve(photo); };
      this.camera.onError = (err) => { cleanup(); reject(err); };
      btnCam.addEventListener('click', onCam);
      btnBack.addEventListener('click', onBack);
    });
  }

  photoChecklist(photo) {
    this.showScreen('photocheck');
    const canvas = this.$('photocheck-canvas');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const s = Math.min(canvas.width / photo.width, canvas.height / photo.height);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(photo, (canvas.width - photo.width * s) / 2, (canvas.height - photo.height * s) / 2,
      photo.width * s, photo.height * s);

    const mp = (photo.width * photo.height) / 1e6;
    this.$('photocheck-auto').innerHTML = [
      autoCheck(mp >= 2, `${mp.toFixed(1)} MP${mp >= 2 ? '' : ' — low resolution'}`),
      autoCheck(!!photo.focalPx, photo.focalPx ? 'Camera metadata found' : 'No camera metadata (upload?) — accuracy reduced'),
    ].join('');

    const box = this.$('photocheck-confirm');
    box.checked = false;
    const btnGo = this.$('btn-photocheck-continue');
    const btnRetake = this.$('btn-photocheck-retake');
    const update = () => { btnGo.disabled = !box.checked; };
    update();

    return new Promise((resolve) => {
      const onGo = () => { cleanup(); resolve(photo); };
      const onRetake = () => { cleanup(); resolve(RETAKE); };
      const cleanup = () => {
        btnGo.removeEventListener('click', onGo);
        btnRetake.removeEventListener('click', onRetake);
        box.removeEventListener('change', update);
      };
      btnGo.addEventListener('click', onGo);
      btnRetake.addEventListener('click', onRetake);
      box.addEventListener('change', update);
    });
  }

  // ------------------------------------------------------------------ pick

  pickStage(photo, { title, labels, illustration, segments = [], segmentLabel = null, ghosts = [], color = TARGET_COLOR, validate, acceptText = 'Next', doneText = null }) {
    this.showScreen('pick');
    this.$('pick-title').textContent = title;
    const canvas = this.$('pick-canvas');
    const btnNext = this.$('btn-next');
    const btnUndo = this.$('btn-undo');
    const btnReset = this.$('btn-reset');
    const btnRetake = this.$('btn-retake');
    const instruction = this.$('pick-instruction');
    const errorStrip = this.$('pick-error');
    btnNext.textContent = acceptText;
    drawIllustration(this.$('guide-canvas'), illustration);
    let valid = false;

    this.teardownPicker();
    return new Promise((resolve) => {
      const update = (picker) => {
        errorStrip.hidden = true;
        valid = false;
        const n = picker.points.length;
        if (!picker.complete) {
          btnNext.disabled = true;
          const coach = n === 0 ? ' (slide to aim with the loupe, lift to set)' : '';
          instruction.textContent = `${n + 1} of ${labels.length}: tap the ${labels[n]}${coach}`;
          return;
        }
        const v = validate(picker.points);
        valid = v.ok;
        if (v.ok) {
          btnNext.disabled = false;
          instruction.textContent = doneText ? doneText(picker.points) : `✓ Drag to fine-tune, then ${acceptText}`;
        } else {
          btnNext.disabled = true;
          instruction.textContent = 'Placed — but a check failed:';
          errorStrip.textContent = v.errors[0].message;
          errorStrip.hidden = false;
        }
      };
      const picker = new CornerPicker(canvas, photo, {
        count: labels.length,
        color,
        segments,
        segmentLabel,
        ghosts,
        onChange: update,
      });
      this.picker = picker;

      const onNext = () => {
        if (!valid) return;
        const pts = picker.points.map((p) => ({ ...p }));
        cleanup();
        resolve(pts);
      };
      const onUndo = () => picker.undo();
      const onReset = () => picker.resetPoints();
      const onRetake = () => { cleanup(); resolve(RETAKE); };
      const cleanup = () => {
        btnNext.removeEventListener('click', onNext);
        btnUndo.removeEventListener('click', onUndo);
        btnReset.removeEventListener('click', onReset);
        btnRetake.removeEventListener('click', onRetake);
        this.teardownPicker();
      };
      btnNext.addEventListener('click', onNext);
      btnUndo.addEventListener('click', onUndo);
      btnReset.addEventListener('click', onReset);
      btnRetake.addEventListener('click', onRetake);
      update(picker);
    });
  }

  // ------------------------------------------------------------------ scan

  async runScan() {
    await this.showGuide();
    await this.finishQuick(await this.scanView());
  }

  // Precision mode's no-sheet fallback: run the quick pipeline on a photo
  // that was already taken, with a reduced-accuracy warning on the result.
  async runQuickWithPhoto(photo, warningMsg) {
    await this.finishQuick(await this.scanView(photo), warningMsg);
  }

  async finishQuick(wall, warningMsg = null) {
    const outcome = this.assemble(wall);
    if (warningMsg) outcome.plaus.warnings.push({ code: 'no-sheet', message: warningMsg });
    if (!outcome.ok) {
      this.showBlocked(outcome);
      return;
    }
    await this.withLoading('Calculating…', '', async () => this.showResults(outcome), 1000);
  }

  // Photo → wall outline (4 taps, calibrates pose + scale) → height (2 taps,
  // confirm) → width (2 taps, confirm).
  async scanView(initialPhoto = null) {
    let pending = initialPhoto;
    while (true) {
      const photo = pending || await this.capturePhoto();
      pending = null;
      if (await this.photoChecklist(photo) === RETAKE) continue;
      const imgW = photo.width; const imgH = photo.height;

      let metro = null;
      let scale = 0;
      let pose = null;
      const quad = await this.pickStage(photo, {
        title: 'Outline the back wall',
        labels: WALL_LABELS,
        illustration: 'wall-quad',
        color: QUAD_COLOR,
        segments: [[0, 1], [1, 2], [2, 3], [3, 0]],
        validate: (pts) => {
          const g = validateWallQuad(pts, imgW, imgH);
          if (!g.ok) return g;
          let m2;
          try {
            // 26mm-equiv iPhone main camera as a last resort when there's no
            // EXIF and the shot is too frontal to recover the focal from.
            m2 = rectangleMetrology(pts, imgW, imgH, {
              focalPx: photo.focalPx || null,
              assumedFocalPx: (Math.max(imgW, imgH) * 26) / 36,
            });
          } catch (err) {
            return { ok: false, errors: [{ code: 'pose', message: `${err.message}` }] };
          }
          const camU = Math.abs(m2.C[1]);
          if (!(camU > 1e-6)) {
            return { ok: false, errors: [{ code: 'pose', message: 'Could not recover the camera position — retake from a natural standing angle.' }] };
          }
          const s = PHONE_HEIGHT_IN / camU; // implied wall height, inches
          const hb = PLAUSIBLE.height;
          if (s < hb.min || s > hb.max) {
            return { ok: false, errors: [{ code: 'implausible', message: `This outline implies a ${s.toFixed(0)}″ wall — a corner is misplaced, or the photo wasn't taken from a normal standing position.` }] };
          }
          metro = m2;
          scale = s;
          const fVP = focalFromVanishingPoints(pts, imgW / 2, imgH / 2);
          pose = {
            areaFrac: g.metrics.areaFrac,
            ortho: orthoResidual(m2.Hcols.h1, m2.Hcols.h2, photo.focalPx || m2.f, imgW / 2, imgH / 2),
            focalVP: fVP,
            focalEXIF: photo.focalPx || null,
            focalUsed: m2.f,
            focalSourceUsed: m2.focalSource || (photo.focalPx ? 'exif' : 'recovered'),
            focalDisagreePct: (fVP && photo.focalPx) ? Math.abs(fVP - photo.focalPx) / photo.focalPx * 100 : null,
            impliedWallHeight: s,
          };
          return { ok: true };
        },
      });
      if (quad === RETAKE) continue;

      const out = { photo, quad, metro, scale, pose, measures: {}, rawUnits: {}, checks: {} };
      let retakeAll = false;
      for (const dim of ['height', 'width']) {
        const pts = await this.pickStage(photo, {
          title: `Measure — ${dim}`,
          labels: ENDPOINT_LABELS[dim],
          illustration: dim,
          ghosts: [{ points: quad, color: QUAD_COLOR }],
          segments: [[0, 1]],
          segmentLabel: (i, j, a, b) => toFraction(metro.distance(a, b) * scale),
          acceptText: 'Accept',
          doneText: (p2) => `${dim}: ${toFraction(metro.distance(p2[0], p2[1]) * scale)} — drag to adjust, then Accept`,
          validate: (p2) => {
            const value = metro.distance(p2[0], p2[1]) * scale;
            const r = validateEndpoints(p2, dim, value, imgW, imgH, quad);
            out.checks[dim] = r;
            return r;
          },
        });
        if (pts === RETAKE) { retakeAll = true; break; }
        out.rawUnits[dim] = metro.distance(pts[0], pts[1]);
        out.measures[dim] = out.rawUnits[dim] * scale;
      }
      if (retakeAll) continue;
      return out;
    }
  }

  assemble(wall) {
    const dims = { width: wall.measures.width, height: wall.measures.height };
    const plaus = validateResultDims(dims);
    if (wall.pose.focalSourceUsed === 'assumed') {
      plaus.warnings.push({
        code: 'assumed-lens',
        message: 'Lens unknown (no photo metadata) — the 1× lens was assumed. '
          + 'If you shot at 0.5× or 2×, every number is off by that same factor: '
          + 'retake at 1×, or tap a number and enter one known measurement.',
      });
    }

    const conf0 = confidenceView({
      paperAreaFrac: wall.pose.areaFrac * 2, // wall quads are naturally large
      orthoResidual: wall.pose.ortho,
      normRatio: 1,
      leverage: 1,
      megapixels: (wall.photo.width * wall.photo.height) / 1e6,
      hasExifFocal: !!wall.photo.focalPx,
      focalDisagreePct: wall.pose.focalDisagreePct,
      warnings: Object.values(wall.checks).reduce((x, c) => x + c.warnings.length, 0),
    });
    const conf = confidenceOverall([conf0], plaus.warnings.length);

    const bands = {};
    for (const dim of ['width', 'height']) {
      bands[dim] = errorBandPct({ orthoResidual: wall.pose.ortho, autoScale: true });
    }

    const ok = plaus.ok && conf.level !== 'low';
    return {
      ok,
      blockedBy: !plaus.ok ? plaus.errors
        : conf.level === 'low' ? [{ code: 'low-confidence', message: 'Confidence is too low to present dimensions.' }] : [],
      dims,
      bands,
      conf,
      plaus,
      wall,
      corrected: null,
    };
  }

  showBlocked(outcome) {
    this.showScreen('lowconf');
    const reasons = [
      ...outcome.blockedBy.map((e) => e.message),
      ...(outcome.conf.level === 'low' ? outcome.conf.reasons : []),
    ];
    this.$('lowconf-reasons').innerHTML = reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
    const btnRetake = this.$('btn-lowconf-retake');
    const btnHome = this.$('btn-lowconf-home');
    const onRetake = () => { cleanup(); this.runGuarded(() => this.runScan()); };
    const onHome = () => { cleanup(); this.showScreen('welcome'); };
    const cleanup = () => {
      btnRetake.removeEventListener('click', onRetake);
      btnHome.removeEventListener('click', onHome);
    };
    btnRetake.addEventListener('click', onRetake);
    btnHome.addEventListener('click', onHome);
  }

  // --------------------------------------------------------------- results

  showResults(outcome) {
    this.current = outcome;
    this.showScreen('results');
    this.renderDims();

    if (this.eraserView) { this.eraserView.destroy(); this.eraserView = null; }
    this.eraserView = new PhotoEraser(this.$('compare-canvas'), buildEmptiedViews(outcome.wall.photo), []);
    this.$('view-hint').textContent = 'cleanup (beta): drag over an object to blend it away — approximate';
    this.eraserView.layout();
    this.eraserView.render();
  }

  renderDims() {
    const o = this.current;
    const badge = this.$('conf-badge');
    badge.textContent = `${o.conf.level.toUpperCase()} confidence (${o.conf.score}/100)`;
    badge.className = `badge conf-${o.conf.level}`;
    this.$('conf-reasons').textContent = o.corrected
      ? `scaled from the ${o.corrected} you set — tap the other number to check it`
      : `auto-scale from camera position — tap a number to correct it${o.conf.reasons.length ? ' · ' + o.conf.reasons.join('; ') : ''}`;

    this.$('dims').innerHTML = ['width', 'height'].map((d) => (
      `<div class="dim-card" data-dim="${d}"><div class="dim-label">${d}</div>`
      + `<div class="dim-value">${toFraction(o.dims[d])}</div>`
      + `<div class="dim-edit">${feetInches(o.dims[d])} · ±${o.bands[d]}%${o.corrected === d ? ' · set by you' : ''}</div></div>`
    )).join('');

    this.$('result-warnings').innerHTML = o.plaus.warnings
      .map((w) => `⚠ ${escapeHtml(w.message)}`).join('<br>');

    const p = o.wall.pose;
    this.$('diag-panel').textContent = [
      `dims (unrounded): W ${o.dims.width.toFixed(4)}″  H ${o.dims.height.toFixed(4)}″`,
      `wall outline: ${(p.areaFrac * 100).toFixed(1)}% of frame · rectangularity residual ${p.ortho.toFixed(4)}`,
      `focal: EXIF ${p.focalEXIF ? p.focalEXIF.toFixed(0) : 'none'} · VP ${p.focalVP ? p.focalVP.toFixed(0) : 'n/a'}${p.focalDisagreePct != null ? ` (Δ${p.focalDisagreePct.toFixed(1)}%)` : ''} · used ${p.focalUsed.toFixed(0)} (${p.focalSourceUsed || 'exif'})`,
      `scale: assumed phone height ${PHONE_HEIGHT_IN}″ → implied wall height ${p.impliedWallHeight.toFixed(1)}″${o.corrected ? ` · overridden by your ${o.corrected}` : ''}`,
      `confidence: ${o.conf.score}/100`,
      '',
      '1/16″ formatting is display resolution, not measured accuracy.',
    ].join('\n');
    this.$('diag-panel').hidden = true;
  }

  // Optional: tap a result to correct it; the other dimension rescales (the
  // photo's proportions are exact — only the scale assumption moves).
  onDimTap(e) {
    const card = e.target.closest('.dim-card');
    if (!card || !this.current) return;
    const dim = card.dataset.dim;
    const answer = prompt(`Real ${dim} in inches (optional — rescales the other number too):`);
    if (answer == null) return;
    const value = parseFloat(answer);
    if (!Number.isFinite(value) || value <= 0) return;
    const o = this.current;
    const newScale = value / o.wall.rawUnits[dim];
    for (const d of ['width', 'height']) {
      o.dims[d] = o.wall.rawUnits[d] * newScale;
      o.bands[d] = errorBandPct({ orthoResidual: o.wall.pose.ortho, autoScale: false });
    }
    o.corrected = dim;
    o.plaus = validateResultDims(o.dims);
    this.renderDims();
  }

}

// --------------------------------------------------------------- helpers

function round3(v) { return Math.round(v * 1000) / 1000; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function autoCheck(pass, text) {
  return `<li class="${pass ? 'ok' : 'warn'}">${pass ? '✓' : '⚠'} ${escapeHtml(text)}</li>`;
}

// Minimal illustrations: the wall with its 4 numbered corners, and the
// per-dimension measurement arrows. 128-unit coordinate space.
export function drawIllustration(canvas, kind) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width; const H = canvas.height;
  const sx = W / 128; const sy = H / 128;
  const P = (x, y) => [x * sx, y * sy];
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = Math.max(2, W / 64);
  ctx.strokeStyle = '#5b6b80';

  const wallRect = [22, 14, 84, 84]; // x, y, w, h
  const drawWall = () => { ctx.strokeRect(...P(wallRect[0], wallRect[1]), wallRect[2] * sx, wallRect[3] * sy); };
  const arrow = (x1, y1, x2, y2) => {
    ctx.strokeStyle = '#00e5a0';
    ctx.beginPath();
    ctx.moveTo(...P(x1, y1)); ctx.lineTo(...P(x2, y2));
    ctx.stroke();
    for (const [hx, hy, ox, oy] of [[x1, y1, x2 - x1, y2 - y1], [x2, y2, x1 - x2, y1 - y2]]) {
      const l = Math.hypot(ox, oy) || 1;
      const ux = ox / l; const uy = oy / l;
      ctx.beginPath();
      ctx.moveTo(...P(hx + ux * 7 - uy * 4, hy + uy * 7 + ux * 4));
      ctx.lineTo(...P(hx, hy));
      ctx.lineTo(...P(hx + ux * 7 + uy * 4, hy + uy * 7 - ux * 4));
      ctx.stroke();
    }
    ctx.strokeStyle = '#5b6b80';
  };

  if (kind === 'wall-quad') {
    drawWall();
    // corner order: bottom-left, bottom-right, top-right, top-left
    const corners = [[22, 98], [106, 98], [106, 14], [22, 14]];
    corners.forEach(([x, y], i) => {
      ctx.fillStyle = '#4da3ff';
      ctx.beginPath(); ctx.arc(...P(x, y), Math.max(9, W / 12), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#05221a';
      ctx.font = `bold ${Math.max(10, W / 11)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), ...P(x, y));
    });
    return;
  }
  if (kind === 'height') { drawWall(); arrow(34, 94, 34, 18); return; }
  if (kind === 'width') { drawWall(); arrow(26, 88, 102, 88); return; }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('screen-welcome')) {
  window.app = new SpaceScanApp();
}
