/**
 * SpaceScanApp — orchestrator for the paper-calibrated measurement flow.
 *
 * Sensor: the iPhone camera, via Safari's <input capture> (no LiDAR/ARKit/
 * WebXR — Safari doesn't expose them). Physical scale comes from a US
 * Letter sheet (8.5×11″) placed on the measured plane; a 4-corner tap
 * calibrates a homography (perspective rectification) and two endpoint taps
 * measure a real distance on that plane.
 *
 * Flow: width & height from one BACK-WALL view (sheet taped to the wall),
 * depth from one FLOOR view (sheet on the floor) — each dimension's
 * reference and endpoints share a physical plane. Every stage is validated
 * (quad geometry, sheet rectangularity + edge order, endpoint plausibility)
 * and scored; low confidence blocks the result. The contents are "removed"
 * by the parametric 3D closet model built from the measured dimensions; the
 * photo inpainting brush is kept as an experimental visual cleanup only.
 */
import { CameraCapture } from './camera.js';
import { CornerPicker } from './picker.js';
import { PlaneMeasurement } from './measurement.js';
import { ClosetModel } from './closet-model.js';
import { EmptyClosetRenderer } from './renderer.js';
import { buildEmptiedViews, PhotoEraser } from './emptier.js';
import {
  validatePaperQuad, paperPoseChecks, validateEndpoints, validateResultDims,
  confidenceView, confidenceOverall, toFraction, feetInches, errorBandPct,
} from './validation.js';

const RETAKE = Symbol('retake');
const HOME = Symbol('home');

const TARGET_COLOR = '#00e5a0';
const PAPER_COLOR = '#4da3ff';

const PAPER_LABELS = [
  'sheet corner — start of a LONG (11″) edge',
  'sheet corner — other end of that long edge',
  'sheet corner — continue around',
  'sheet corner — last one',
];
const ENDPOINT_LABELS = {
  width: ['LEFT corner of the back wall', 'RIGHT corner of the back wall'],
  height: ['FLOOR line of the back wall', 'CEILING line, straight above'],
  depth: ['BACK of the floor (base of the back wall)', 'FRONT edge of the floor'],
};
const VIEW_DIMS = { wall: ['width', 'height'], floor: ['depth'] };

export class SpaceScanApp {
  constructor(doc = document) {
    this.doc = doc;
    this.$ = (id) => doc.getElementById(id);
    this.camera = new CameraCapture(this.$('camera-input'));
    this.picker = null;
    this.renderer = null;
    this.eraserView = null;

    this.$('btn-start').addEventListener('click', () => this.runGuarded(() => this.runScan()));
    this.$('btn-restart').addEventListener('click', () => this.showScreen('welcome'));
    this.$('btn-view-photo').addEventListener('click', () => this.setResultsView('photo'));
    this.$('btn-view-3d').addEventListener('click', () => this.setResultsView('3d'));
    this.$('btn-erase-undo').addEventListener('click', () => { if (this.eraserView) this.eraserView.undo(); });
    this.$('btn-erase-reset').addEventListener('click', () => { if (this.eraserView) this.eraserView.reset(); });
    this.$('btn-diagnostics').addEventListener('click', () => {
      const p = this.$('diag-panel');
      p.hidden = !p.hidden;
    });
    this.$('btn-validate').addEventListener('click', () => this.openValidation());
    this.$('btn-validate-back').addEventListener('click', () => this.showScreen('results'));
    this.$('btn-validate-add').addEventListener('click', () => this.addValidationTrial());
    this.$('btn-validate-clear').addEventListener('click', () => {
      localStorage.removeItem('validation-trials');
      this.renderValidation();
    });
    this.$('btn-export-json').addEventListener('click', () => this.exportTrials('json'));
    this.$('btn-export-csv').addEventListener('click', () => this.exportTrials('csv'));

    this.showScreen('welcome');
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
    drawIllustration(this.$('guide-large'), 'wall');
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

  capturePhoto(view) {
    this.showScreen('capture');
    this.$('capture-title').textContent = view === 'wall'
      ? 'Step 1 · Back wall (width & height)'
      : 'Step 2 · Floor (depth)';
    this.$('capture-text').innerHTML = view === 'wall'
      ? 'Tape the sheet <b>flat on the back wall</b>, landscape.<br>Photograph the <b>whole wall</b>, standing centered.'
      : 'Move the sheet <b>flat onto the floor</b>.<br>Photograph the floor from the <b>back wall to the front edge</b>.';
    drawIllustration(this.$('capture-illust'), view);
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

  // Capture-quality gate: automatic checks + one confirmation.
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
      autoCheck(!!photo.focalPx, photo.focalPx ? 'Camera metadata found' : 'No camera metadata (upload?) — checks reduced'),
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

  // One tapping stage. `validate(points)` gates the accept button and its
  // first error is shown verbatim. Resolves points or RETAKE.
  pickStage(photo, { title, labels, illustration, segments = [], segmentLabel = null, ghosts = [], validate, acceptText = 'Next', doneText = null }) {
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
        color: TARGET_COLOR,
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
    const wall = await this.scanView('wall');
    const floor = await this.scanView('floor');
    const outcome = this.assemble(wall, floor);
    if (!outcome.ok) {
      this.showBlocked(outcome);
      return;
    }
    await this.withLoading('Calculating…', '', async () => this.showResults(outcome), 1000);
  }

  // One calibrated view: photo -> checklist -> sheet corners -> one endpoint
  // pair per dimension on that plane, each accepted with a live value.
  async scanView(view) {
    const dims = VIEW_DIMS[view];
    while (true) {
      const photo = await this.capturePhoto(view);
      if (await this.photoChecklist(photo) === RETAKE) continue;
      const imgW = photo.width; const imgH = photo.height;

      let poseResult = null;
      const paper = await this.pickStage(photo, {
        title: `Calibrate — sheet corners (${view})`,
        labels: PAPER_LABELS,
        illustration: 'paper',
        segments: [[0, 1], [1, 2], [2, 3], [3, 0]],
        validate: (pts) => {
          const quad = validatePaperQuad(pts, imgW, imgH);
          if (!quad.ok) return quad;
          let plane;
          try {
            plane = new PlaneMeasurement(pts);
          } catch (err) {
            return { ok: false, errors: [{ code: 'degenerate', message: err.message }] };
          }
          const pose = paperPoseChecks(pts, imgW, imgH, {
            exifFocal: photo.focalPx || null,
            homographyColumns: plane.Hcols,
          });
          poseResult = { ...pose, metrics: { ...pose.metrics, areaFrac: quad.metrics.areaFrac } };
          return pose.ok ? { ok: true } : pose;
        },
      });
      if (paper === RETAKE) continue;

      const plane = new PlaneMeasurement(paper);
      const out = { view, photo, paper, pose: poseResult, measures: {}, checks: {} };
      let retakeView = false;
      for (const dim of dims) {
        const pts = await this.pickStage(photo, {
          title: `Measure — ${dim}`,
          labels: ENDPOINT_LABELS[dim],
          illustration: dim,
          ghosts: [{ points: paper, color: PAPER_COLOR }],
          segments: [[0, 1]],
          segmentLabel: (i, j, a, b) => toFraction(plane.distance(a, b)),
          acceptText: 'Accept',
          doneText: (pts2) => `${dim}: ${toFraction(plane.distance(pts2[0], pts2[1]))} — drag to adjust, then Accept`,
          validate: (pts2) => {
            const value = plane.distance(pts2[0], pts2[1]);
            const r = validateEndpoints(pts2, dim, value, imgW, imgH, paper);
            out.checks[dim] = r;
            return r;
          },
        });
        if (pts === RETAKE) { retakeView = true; break; }
        out.measures[dim] = plane.distance(pts[0], pts[1]);
      }
      if (retakeView) continue;
      return out;
    }
  }

  assemble(wall, floor) {
    const dims = {
      width: wall.measures.width,
      height: wall.measures.height,
      depth: floor.measures.depth,
    };
    const plaus = validateResultDims(dims);

    const viewConf = (v) => confidenceView({
      paperAreaFrac: v.pose.metrics.areaFrac,
      orthoResidual: v.pose.metrics.orthoResidual ?? null,
      normRatio: v.pose.metrics.normRatio ?? 1,
      leverage: Math.max(...Object.values(v.checks).map((c) => c.metrics.leverage || 3)),
      megapixels: (v.photo.width * v.photo.height) / 1e6,
      hasExifFocal: !!v.photo.focalPx,
      focalDisagreePct: v.pose.metrics.focalDisagreePct ?? null,
      warnings: v.pose.warnings.length + Object.values(v.checks).reduce((a, c) => a + c.warnings.length, 0),
    });
    const confWall = viewConf(wall);
    const confFloor = viewConf(floor);
    const conf = confidenceOverall([confWall, confFloor], plaus.warnings.length);

    const bands = {};
    for (const [dim, v] of [['width', wall], ['height', wall], ['depth', floor]]) {
      if (!(dim in v.measures)) continue;
      bands[dim] = errorBandPct({
        leverage: v.checks[dim]?.metrics.leverage ?? 3,
        orthoResidual: v.pose.metrics.orthoResidual ?? 0,
        paperAreaFrac: v.pose.metrics.areaFrac,
      });
    }

    const ok = plaus.ok && conf.level !== 'low';
    return {
      ok,
      blockedBy: !plaus.ok ? plaus.errors
        : conf.level === 'low' ? [{ code: 'low-confidence', message: 'Confidence is too low to present dimensions.' }] : [],
      dims,
      bands,
      conf,
      confWall,
      confFloor,
      plaus,
      wall,
      floor,
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

    const badge = this.$('conf-badge');
    badge.textContent = `${outcome.conf.level.toUpperCase()} confidence (${outcome.conf.score}/100)`;
    badge.className = `badge conf-${outcome.conf.level}`;
    this.$('conf-reasons').textContent = outcome.conf.reasons.length
      ? outcome.conf.reasons.join('; ')
      : 'all checks clean';

    this.$('dims').innerHTML = ['width', 'height', 'depth'].map((d) => (
      `<div class="dim-card"><div class="dim-label">${d}</div>`
      + `<div class="dim-value">${toFraction(outcome.dims[d])}</div>`
      + `<div class="dim-edit">${feetInches(outcome.dims[d])} · ±${outcome.bands[d]}%</div></div>`
    )).join('');

    this.$('result-warnings').innerHTML = outcome.plaus.warnings
      .map((w) => `⚠ ${escapeHtml(w.message)}`).join('<br>');

    const viewDiag = (v, name) => {
      const m = v.pose.metrics;
      const lev = Object.entries(v.checks).map(([d, c]) => `${d} ${c.metrics.leverage?.toFixed(1) ?? '—'}×`).join(', ');
      return [
        `${name}: sheet ${(m.areaFrac * 100).toFixed(2)}% of frame · ortho ${m.orthoResidual?.toFixed(4) ?? 'n/a'} · edge-ratio ${m.normRatio?.toFixed(3) ?? 'n/a'}`,
        `  focal: EXIF ${m.focalEXIF ? m.focalEXIF.toFixed(0) : 'none'} · VP ${m.focalVP ? m.focalVP.toFixed(0) : 'n/a'}${m.focalDisagreePct != null ? ` (Δ${m.focalDisagreePct.toFixed(1)}%)` : ''} · leverage ${lev}`,
      ].join('\n');
    };
    this.$('diag-panel').textContent = [
      `dims (unrounded): W ${outcome.dims.width.toFixed(4)}″  H ${outcome.dims.height.toFixed(4)}″  D ${outcome.dims.depth.toFixed(4)}″`,
      viewDiag(outcome.wall, 'wall view'),
      viewDiag(outcome.floor, 'floor view'),
      `confidence: wall ${outcome.confWall.score} · floor ${outcome.confFloor.score} · overall ${outcome.conf.score}/100`,
      '',
      '1/16″ formatting is display resolution, not measured accuracy.',
      'Accuracy evidence lives in Validation mode (app vs tape measure).',
    ].join('\n');
    this.$('diag-panel').hidden = true;

    // Parametric 3D closet — the reliable "contents removed" representation.
    this.resultsModel = new ClosetModel({
      widthTop: outcome.dims.width, widthBottom: outcome.dims.width,
      heightLeft: outcome.dims.height, heightRight: outcome.dims.height,
      depth: outcome.dims.depth,
    });
    if (this.renderer) { this.renderer.destroy(); this.renderer = null; }
    if (this.eraserView) { this.eraserView.destroy(); this.eraserView = null; }
    this.eraserView = new PhotoEraser(this.$('compare-canvas'), buildEmptiedViews(outcome.wall.photo), []);
    this.setResultsView('3d');
  }

  setResultsView(which) {
    const photoMode = which === 'photo' && this.eraserView;
    this.$('btn-view-photo').classList.toggle('active', !!photoMode);
    this.$('btn-view-3d').classList.toggle('active', !photoMode);
    this.$('compare-canvas').hidden = !photoMode;
    this.$('scene-canvas').hidden = !!photoMode;
    this.$('erase-bar').hidden = !photoMode;
    if (photoMode) {
      this.$('view-hint').textContent = 'experimental cleanup: drag over an object to blend it away (approximate — hidden detail is not reconstructed)';
      this.eraserView.layout();
      this.eraserView.render();
    } else {
      this.$('view-hint').textContent = 'the measured closet, emptied — drag to rotate';
      if (!this.renderer && this.resultsModel) {
        this.renderer = new EmptyClosetRenderer(this.$('scene-canvas'), this.resultsModel, {});
      } else if (this.renderer) {
        this.renderer.layout();
        this.renderer.render();
      }
    }
  }

  // ------------------------------------------------------- validation mode

  openValidation() {
    this.showScreen('validate');
    for (const id of ['val-w', 'val-h', 'val-d']) this.$(id).value = '';
    this.renderValidation();
  }

  trials() {
    try { return JSON.parse(localStorage.getItem('validation-trials')) || []; } catch { return []; }
  }

  addValidationTrial() {
    const measured = {
      width: parseFloat(this.$('val-w').value),
      height: parseFloat(this.$('val-h').value),
      depth: parseFloat(this.$('val-d').value),
    };
    if (!Object.values(measured).every((v) => Number.isFinite(v) && v > 0)) {
      alert('Enter all three tape-measured dimensions in inches.');
      return;
    }
    const app = this.current.dims;
    const trial = { at: new Date().toISOString(), confidence: this.current.conf.level, dims: {} };
    for (const d of ['width', 'height', 'depth']) {
      const err = app[d] - measured[d];
      trial.dims[d] = {
        app: round3(app[d]),
        measured: measured[d],
        errorIn: round3(err),
        errorPct: round3(Math.abs(err) / measured[d] * 100),
      };
    }
    const all = this.trials();
    all.push(trial);
    localStorage.setItem('validation-trials', JSON.stringify(all));
    this.renderValidation();
  }

  renderValidation() {
    const all = this.trials();
    const table = this.$('val-table');
    if (all.length === 0) {
      table.innerHTML = '<p class="hint">No trials recorded yet.</p>';
      this.$('val-summary').textContent = '';
      return;
    }
    const rows = all.map((t, i) => {
      const cells = ['width', 'height', 'depth'].map((d) => {
        const c = t.dims[d];
        return `<td>${c.app}″ / ${c.measured}″<br><span class="err">${c.errorIn >= 0 ? '+' : ''}${c.errorIn}″ (${c.errorPct}%)</span></td>`;
      }).join('');
      return `<tr><td>#${i + 1}<br><span class="err">${t.at.slice(0, 10)}</span></td>${cells}</tr>`;
    }).join('');
    table.innerHTML = `<table><thead><tr><th>trial</th><th>W app/tape</th><th>H app/tape</th><th>D app/tape</th></tr></thead><tbody>${rows}</tbody></table>`;

    const errs = all.flatMap((t) => Object.values(t.dims).map((c) => Math.abs(c.errorIn)));
    const mae = errs.reduce((a, b) => a + b, 0) / errs.length;
    const maxErr = Math.max(...errs);
    const sixteenthMet = errs.every((e) => e <= 0.0625);
    this.$('val-summary').innerHTML =
      `Mean absolute error: <b>${mae.toFixed(3)}″</b> · Max error: <b>${maxErr.toFixed(3)}″</b> · ${errs.length} measurements, ${all.length} trial(s)<br>`
      + (sixteenthMet
        ? '<span class="ok">Every recorded error is within the 1/16″ (0.0625″) target.</span>'
        : `<span class="warn">1/16″ (0.0625″) target NOT met (max ${maxErr.toFixed(3)}″).</span>`);
  }

  exportTrials(kind) {
    const all = this.trials();
    if (all.length === 0) { alert('No trials to export yet.'); return; }
    let blob;
    let name;
    if (kind === 'json') {
      blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
      name = 'spacescan-validation.json';
    } else {
      const header = 'trial,timestamp,confidence,dimension,app_in,measured_in,error_in,error_pct';
      const lines = all.flatMap((t, i) => ['width', 'height', 'depth'].map((d) => {
        const c = t.dims[d];
        return `${i + 1},${t.at},${t.confidence},${d},${c.app},${c.measured},${c.errorIn},${c.errorPct}`;
      }));
      blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
      name = 'spacescan-validation.csv';
    }
    const a = this.doc.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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

// Minimal illustrations: wall/floor scene sketches, the sheet's tap order,
// and per-dimension measurement arrows. 128-unit coordinate space.
export function drawIllustration(canvas, kind) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width; const H = canvas.height;
  const sx = W / 128; const sy = H / 128;
  const P = (x, y) => [x * sx, y * sy];
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = Math.max(2, W / 64);
  ctx.strokeStyle = '#5b6b80';

  const wallRect = [18, 14, 92, 78]; // x, y, w, h
  const floorQuad = [[18, 92], [110, 92], [122, 118], [6, 118]];
  const drawWall = () => { ctx.strokeRect(...P(wallRect[0], wallRect[1]), wallRect[2] * sx, wallRect[3] * sy); };
  const drawFloor = () => {
    ctx.beginPath();
    floorQuad.forEach(([x, y], i) => (i ? ctx.lineTo(...P(x, y)) : ctx.moveTo(...P(x, y))));
    ctx.closePath();
    ctx.stroke();
  };
  const paperAt = (x, y, w = 22, h = 17) => {
    ctx.fillStyle = '#e8ecf3';
    ctx.fillRect(...P(x, y), w * sx, h * sy);
  };
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

  if (kind === 'paper') {
    // Sheet with numbered corners; taps start along a long edge.
    ctx.strokeRect(...P(14, 34), 100 * sx, 60 * sy);
    const corners = [[14, 34], [114, 34], [114, 94], [14, 94]];
    corners.forEach(([x, y], i) => {
      ctx.fillStyle = '#00e5a0';
      ctx.beginPath(); ctx.arc(...P(x, y), Math.max(9, W / 12), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#05221a';
      ctx.font = `bold ${Math.max(10, W / 11)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), ...P(x, y));
    });
    return;
  }
  if (kind === 'wall') { drawWall(); paperAt(53, 42); drawFloor(); return; }
  if (kind === 'floor') { drawFloor(); paperAt(53, 96, 24, 16); return; }
  if (kind === 'width') { drawWall(); paperAt(53, 30); arrow(20, 78, 108, 78); return; }
  if (kind === 'height') { drawWall(); paperAt(53, 42); arrow(28, 90, 28, 16); return; }
  if (kind === 'depth') { drawFloor(); paperAt(72, 96, 24, 16); arrow(40, 94, 30, 116); return; }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('screen-welcome')) {
  window.app = new SpaceScanApp();
}
