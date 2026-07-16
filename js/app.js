/**
 * SpaceScanApp — orchestrator. Owns the screen state machine and wires the
 * capture → validate → measure → scale → render pipeline together.
 *
 * Supported target: RECTANGULAR, box-shaped enclosed spaces — closets,
 * pantries, alcoves. Not couches or irregular objects; the geometry assumes
 * a rectangular floor footprint and a vertical back wall, and validation
 * rejects scans that don't fit that model instead of inventing numbers.
 *
 * Flow: guide (diagram + shooting checklist) → photo → photo checklist →
 * tap 6 corners (live geometry validation gates Next) → enter ONE known
 * reference dimension (required; sets the absolute scale) → plausibility
 * checks + confidence scoring → results (Low confidence blocks and asks
 * for a retake). Results include a photo cleanup brush (classical texture
 * inpainting — a visual approximation, not AI reconstruction), a 3D view,
 * diagnostics with unrounded numbers, and a tape-measure validation mode.
 */
import { CameraCapture } from './camera.js';
import { CornerPicker } from './picker.js';
import { rectangleMetrology } from './metrology.js';
import { ClosetModel } from './closet-model.js';
import { EmptyClosetRenderer } from './renderer.js';
import { buildEmptiedViews, PhotoEraser } from './emptier.js';
import {
  validateGeometry, crossChecks, validateReference, validateResult,
  confidence, toFraction, errorBandPct, REFERENCE_RANGES,
} from './validation.js';

const RETAKE = Symbol('retake');
const HOME = Symbol('home');

const TARGET_COLOR = '#00e5a0';

const LABELS = [
  'back-bottom-left corner (floor meets the back wall, left)',
  'back-bottom-right corner',
  'front-bottom-left corner (front edge of the floor)',
  'front-bottom-right corner',
  'back-top-left corner (ceiling line of the back wall)',
  'back-top-right corner',
];

// Box wireframe drawn between placed points so the user can verify the
// geometry: floor cycle + wall verticals + ceiling edge.
const BOX_EDGES = [[0, 1], [0, 2], [1, 3], [2, 3], [0, 4], [1, 5], [4, 5]];

const REF_PRESETS = {
  height: [80, 84, 96],
  width: [24, 36, 48, 60],
  depth: [24],
};

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
    this.$('btn-clear-all').addEventListener('click', () => {
      if (this.eraserView) this.withLoading('Cleaning up…', 'Approximating the background', async () => this.eraserView.clearAll(), 600);
    });
    this.$('btn-erase-undo').addEventListener('click', () => {
      if (this.eraserView) this.eraserView.undo();
    });
    this.$('btn-erase-reset').addEventListener('click', () => {
      if (this.eraserView) this.eraserView.reset();
    });
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
    if (this.busy) return; // ignore double-taps that would start a second flow
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

  // ---------------------------------------------------------------- overlay

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
      // Let the overlay paint before canvas-heavy work blocks the thread.
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
    drawGuide(this.$('guide-large'), -1, { numbered: true });
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

  // Camera button stays armed the whole time — a cancelled camera sheet
  // (no event on iOS) just means the user taps again. Rejects HOME on back.
  capturePhoto() {
    this.showScreen('capture');
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

  // Photo checklist: automatic checks (resolution, camera metadata) plus
  // user-confirmed visibility items — the photo isn't accepted until all
  // confirmable items are ticked. Resolves the photo or RETAKE.
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
      autoCheck(mp >= 2, `Resolution: ${mp.toFixed(1)} MP ${mp >= 2 ? '' : '— low, accuracy reduced'}`),
      autoCheck(!!photo.focalPx, photo.focalPx
        ? 'Camera focal data found (EXIF)'
        : 'No camera focal data — accuracy reduced; shoot with the camera app if possible'),
    ].join('');

    const boxes = [...this.doc.querySelectorAll('#photocheck-list input')];
    boxes.forEach((b) => { b.checked = false; });
    const btnGo = this.$('btn-photocheck-continue');
    const btnRetake = this.$('btn-photocheck-retake');
    const update = () => { btnGo.disabled = !boxes.every((b) => b.checked); };
    update();

    return new Promise((resolve) => {
      const onGo = () => { cleanup(); resolve(photo); };
      const onRetake = () => { cleanup(); resolve(RETAKE); };
      const cleanup = () => {
        btnGo.removeEventListener('click', onGo);
        btnRetake.removeEventListener('click', onRetake);
        boxes.forEach((b) => b.removeEventListener('change', update));
      };
      btnGo.addEventListener('click', onGo);
      btnRetake.addEventListener('click', onRetake);
      boxes.forEach((b) => b.addEventListener('change', update));
    });
  }

  // ------------------------------------------------------------------ pick

  // The tapping session. Next stays disabled until all 6 points pass
  // geometry validation AND the pose cross-checks; the first failure is
  // shown as a specific message. Resolves {pts, metro, checks} or RETAKE.
  pickPoints(photo) {
    this.showScreen('pick');
    const canvas = this.$('pick-canvas');
    const btnNext = this.$('btn-next');
    const btnUndo = this.$('btn-undo');
    const btnReset = this.$('btn-reset');
    const btnRetake = this.$('btn-retake');
    const instruction = this.$('pick-instruction');
    const errorStrip = this.$('pick-error');
    let lastValidation = null;

    this.teardownPicker();
    return new Promise((resolve) => {
      const update = (picker) => {
        const n = picker.points.length;
        drawGuide(this.$('guide-canvas'), picker.complete ? -1 : n);
        errorStrip.hidden = true;
        lastValidation = null;
        if (!picker.complete) {
          btnNext.disabled = true;
          const coach = n === 0 ? ' (slide to align in the loupe, lift to set)' : '';
          instruction.textContent = `${n + 1} of 6: tap the ${LABELS[n]} — the green dot in the diagram${coach}`;
          return;
        }
        // All six placed: validate before allowing Next.
        const v = this.validatePick(picker.points, photo);
        lastValidation = v;
        if (v.ok) {
          btnNext.disabled = false;
          instruction.textContent = '✓ Geometry checks passed — drag any point to fine-tune, then tap Next';
        } else {
          btnNext.disabled = true;
          instruction.textContent = 'All 6 placed — but the geometry doesn\'t check out:';
          errorStrip.textContent = v.errors[0].message;
          errorStrip.hidden = false;
        }
      };
      const picker = new CornerPicker(canvas, photo, {
        count: 6,
        color: TARGET_COLOR,
        segments: BOX_EDGES,
        onChange: update,
      });
      this.picker = picker;

      const onNext = () => {
        if (!lastValidation?.ok) return;
        const pts = picker.points.map((p) => ({ ...p }));
        cleanup();
        resolve({ pts, metro: lastValidation.metro, checks: lastValidation.checks });
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

  // Geometry rules + pose cross-checks for the current 6 points.
  validatePick(pts, photo) {
    const geo = validateGeometry(pts, photo.width, photo.height);
    if (!geo.ok) return { ok: false, errors: geo.errors, warnings: geo.warnings };
    const [bl, br, fl, fr] = pts;
    let metro;
    try {
      metro = rectangleMetrology([bl, br, fr, fl], photo.width, photo.height, {
        focalPx: photo.focalPx || null,
      });
    } catch (err) {
      return { ok: false, errors: [{ code: 'pose', message: `${err.message}` }], warnings: [] };
    }
    const checks = crossChecks({
      metro, pts, imgW: photo.width, imgH: photo.height,
      exifFocal: photo.focalPx || null,
      homographyColumns: metro.Hcols,
    });
    return {
      ok: checks.ok,
      errors: checks.errors,
      warnings: [...geo.warnings, ...checks.warnings],
      metro,
      checks: { ...checks, geoWarnings: geo.warnings },
    };
  }

  // -------------------------------------------------------------- reference

  // Exactly one known dimension, in inches, sets the absolute scale.
  askReference(raw) {
    this.showScreen('reference');
    const msg = this.$('ref-msg');
    const input = this.$('ref-value');
    const customBox = this.$('ref-custom');
    const btnDone = this.$('btn-ref-done');
    const btnBack = this.$('btn-ref-back');
    const dimChips = [...this.doc.querySelectorAll('#ref-dims button')];
    let dim = 'height';
    input.value = '';
    customBox.checked = false;
    msg.textContent = '';

    const renderPresets = () => {
      this.$('ref-presets').innerHTML = REF_PRESETS[dim]
        .map((v) => `<button data-v="${v}">${v}″</button>`).join('');
      for (const b of this.$('ref-presets').querySelectorAll('button')) {
        b.addEventListener('click', () => { input.value = b.dataset.v; update(); });
      }
      const r = REFERENCE_RANGES[dim];
      this.$('ref-range').textContent = `typical closet ${dim}: ${r.min}–${r.max}″`;
    };
    const selectDim = (d) => {
      dim = d;
      dimChips.forEach((c) => c.classList.toggle('active', c.dataset.dim === d));
      renderPresets();
      update();
    };
    const update = () => {
      const v = parseFloat(input.value);
      const check = validateReference(dim, v, { custom: customBox.checked });
      msg.textContent = Number.isFinite(v) && !check.ok ? check.message : '';
      btnDone.disabled = !check.ok;
    };

    return new Promise((resolve) => {
      const onDim = (e) => selectDim(e.currentTarget.dataset.dim);
      const onDone = () => {
        const v = parseFloat(input.value);
        if (!validateReference(dim, v, { custom: customBox.checked }).ok) return;
        cleanup();
        resolve({ dim, value: v });
      };
      const onBack = () => { cleanup(); resolve(RETAKE); };
      const cleanup = () => {
        dimChips.forEach((c) => c.removeEventListener('click', onDim));
        btnDone.removeEventListener('click', onDone);
        btnBack.removeEventListener('click', onBack);
        input.removeEventListener('input', update);
        customBox.removeEventListener('change', update);
      };
      dimChips.forEach((c) => c.addEventListener('click', onDim));
      btnDone.addEventListener('click', onDone);
      btnBack.addEventListener('click', onBack);
      input.addEventListener('input', update);
      customBox.addEventListener('change', update);
      selectDim('height');
    });
  }

  // ------------------------------------------------------------------ scan

  async runScan() {
    await this.showGuide();
    scan: while (true) {
      let photo = await this.capturePhoto();
      if (await this.photoChecklist(photo) === RETAKE) continue;

      let picked;
      let ref;
      while (true) {
        picked = await this.pickPoints(photo);
        if (picked === RETAKE) continue scan;

        ref = await this.askReference();
        if (ref === RETAKE) continue; // back to the same photo's points
        break;
      }

      const outcome = this.computeResult(photo, picked, ref);
      if (!outcome.ok) {
        this.showBlocked(outcome);
        return;
      }
      await this.withLoading(
        'Calculating dimensions…',
        'Solving the 3D geometry from your corners',
        async () => this.showResults(outcome),
        1200,
      );
      return;
    }
  }

  computeResult(photo, { pts, metro, checks }, ref) {
    const [bl, br, fl, fr, tl, tr] = pts;
    const raw = {
      width: metro.distance(bl, br),
      depth: metro.distance(bl, fl),
      heightLeft: checks.metrics.heightLeft,
      heightRight: checks.metrics.heightRight,
    };
    raw.height = (raw.heightLeft + raw.heightRight) / 2;
    const scale = ref.value / raw[ref.dim];
    const dims = {
      width: raw.width * scale,
      height: raw.height * scale,
      depth: raw.depth * scale,
    };
    const camHeightIn = Math.abs(metro.C[2]) * scale;

    const plaus = validateResult(dims, { camHeightIn });
    const conf = confidence({
      hasExifFocal: !!photo.focalPx,
      focalDisagreePct: checks.metrics.focalDisagreePct ?? null,
      orthoResidual: checks.metrics.orthoResidual ?? null,
      heightDisagreePct: checks.metrics.heightDisagreePct,
      vertAngleMaxDeg: Math.max(checks.metrics.vertAngleLeftDeg || 0, checks.metrics.vertAngleRightDeg || 0),
      camPitchDeg: checks.metrics.camPitchDeg,
      megapixels: (photo.width * photo.height) / 1e6,
      borderWarnings: (checks.geoWarnings || []).filter((w) => w.code === 'border').length,
      resultWarnings: plaus.warnings.length,
    });

    const ok = plaus.ok && conf.level !== 'low';
    return {
      ok,
      blockedBy: !plaus.ok ? plaus.errors : conf.level === 'low' ? [{ code: 'low-confidence', message: 'Confidence is too low to present precise dimensions.' }] : [],
      dims,
      raw,
      scale,
      ref,
      camHeightIn,
      conf,
      plaus,
      checks,
      photo,
      corners: pts,
      wallColor: sampleWallColor(photo, [tl, tr, br, bl]),
    };
  }

  // ----------------------------------------------------------- result gates

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

    // Confidence badge with reasons.
    const badge = this.$('conf-badge');
    badge.textContent = `${outcome.conf.level.toUpperCase()} confidence (${outcome.conf.score}/100)`;
    badge.className = `badge conf-${outcome.conf.level}`;
    const band = errorBandPct(outcome.checks.metrics, !!outcome.photo.focalPx);
    this.$('conf-reasons').textContent = outcome.conf.reasons.length
      ? `Expected error ±${band}% · ${outcome.conf.reasons.join('; ')}`
      : `Expected error ±${band}% — all checks clean`;

    // Dimensions, quarter-inch display; the reference one is highlighted.
    const model = new ClosetModel({
      widthTop: outcome.dims.width, widthBottom: outcome.dims.width,
      heightLeft: outcome.raw.heightLeft * outcome.scale,
      heightRight: outcome.raw.heightRight * outcome.scale,
      depth: outcome.dims.depth,
    });
    this.resultsModel = model;
    this.$('dims').innerHTML = ['width', 'height', 'depth'].map((d) => {
      const isRef = d === outcome.ref.dim;
      return `<div class="dim-card${isRef ? ' ref' : ''}">`
        + `<div class="dim-label">${d}</div>`
        + `<div class="dim-value">${toFraction(outcome.dims[d])}</div>`
        + `<div class="dim-edit">${isRef ? 'your reference' : `±${band}%`}</div></div>`;
    }).join('');

    this.$('result-warnings').innerHTML = outcome.plaus.warnings
      .map((w) => `⚠ ${escapeHtml(w.message)}`).join('<br>');

    // Diagnostics: unrounded internals for the demo.
    const m = outcome.checks.metrics;
    this.$('diag-panel').textContent = [
      `dims (unrounded): W ${outcome.dims.width.toFixed(3)}″  H ${outcome.dims.height.toFixed(3)}″  D ${outcome.dims.depth.toFixed(3)}″`,
      `height left/right: ${(outcome.raw.heightLeft * outcome.scale).toFixed(3)}″ / ${(outcome.raw.heightRight * outcome.scale).toFixed(3)}″  (disagree ${m.heightDisagreePct.toFixed(2)}%)`,
      `reference: ${outcome.ref.dim} = ${outcome.ref.value}″  (scale ${outcome.scale.toFixed(5)}″/unit)`,
      `floor rectangularity residual: ${m.orthoResidual != null ? m.orthoResidual.toFixed(4) : 'n/a'}`,
      `vertical edge error L/R: ${m.vertAngleLeftDeg?.toFixed(2)}° / ${m.vertAngleRightDeg?.toFixed(2)}°`,
      `focal: used ${m.focalUsed?.toFixed(1)} px · EXIF ${m.focalEXIF ? m.focalEXIF.toFixed(1) : 'none'} · vanishing-point ${m.focalVP ? m.focalVP.toFixed(1) : 'n/a'}${m.focalDisagreePct != null ? ` (disagree ${m.focalDisagreePct.toFixed(1)}%)` : ''}`,
      `camera: pitch ${m.camPitchDeg.toFixed(1)}°, implied height ${outcome.camHeightIn.toFixed(1)}″`,
      `photo: ${outcome.photo.width}×${outcome.photo.height} (${((outcome.photo.width * outcome.photo.height) / 1e6).toFixed(1)} MP)`,
      `confidence score: ${outcome.conf.score}/100`,
      '',
      'Display is rounded to 1/4″. Displayed precision is NOT measured accuracy;',
      'see Validation mode for tape-measure comparison.',
    ].join('\n');
    this.$('diag-panel').hidden = true;

    if (this.renderer) { this.renderer.destroy(); this.renderer = null; }
    if (this.eraserView) { this.eraserView.destroy(); this.eraserView = null; }
    const views = buildEmptiedViews(outcome.photo);
    const hull = outcome.corners.map((p) => ({ x: p.x * views.scale, y: p.y * views.scale }));
    this.eraserView = new PhotoEraser(this.$('compare-canvas'), views, hull);
    this.setResultsView('photo');
  }

  setResultsView(which) {
    const photoMode = which === 'photo' && this.eraserView;
    this.$('btn-view-photo').classList.toggle('active', !!photoMode);
    this.$('btn-view-3d').classList.toggle('active', !photoMode);
    this.$('compare-canvas').hidden = !photoMode;
    this.$('scene-canvas').hidden = !!photoMode;
    this.$('erase-bar').hidden = !photoMode;
    if (photoMode) {
      this.$('view-hint').textContent = 'drag over an object to clean it up (visual approximation — hidden detail is not reconstructed)';
      this.eraserView.layout();
      this.eraserView.render();
    } else {
      this.$('view-hint').textContent = 'drag to look around the box model';
      if (!this.renderer && this.resultsModel) {
        this.renderer = new EmptyClosetRenderer(this.$('scene-canvas'), this.resultsModel, {
          wallColor: this.current?.wallColor,
        });
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
    const trial = {
      at: new Date().toISOString(),
      confidence: this.current.conf.level,
      dims: {},
    };
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
      `Mean absolute error: <b>${mae.toFixed(3)}″</b> · Max error: <b>${maxErr.toFixed(3)}″</b> · ${errs.length} measurements over ${all.length} trial(s)<br>`
      + (sixteenthMet
        ? '<span class="ok">Every recorded error is within the 1/16″ (0.0625″) target.</span>'
        : `<span class="warn">The 1/16″ (0.0625″) target is NOT met (max ${maxErr.toFixed(3)}″). This is expected — see the README's honesty section.</span>`);
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

// Wireframe guide of the box. index highlights one corner; numbered mode
// labels all six with their tap order (used on the pre-scan guide screen).
export function drawGuide(canvas, index, { numbered = false } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width; const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const sx = W / 128; const sy = H / 128;
  // corner order: back-bottom L/R, front-bottom L/R, back-top L/R
  const corners = [
    [36, 84], [92, 84], [16, 112], [112, 112], [36, 16], [92, 16],
  ].map(([x, y]) => [x * sx, y * sy]);
  ctx.strokeStyle = '#5b6b80';
  ctx.lineWidth = Math.max(2, W / 64);
  ctx.beginPath();
  ctx.moveTo(...corners[4]); ctx.lineTo(...corners[5]); // ceiling edge
  ctx.lineTo(...corners[1]); ctx.lineTo(...corners[0]); ctx.closePath(); // wall
  ctx.moveTo(...corners[0]); ctx.lineTo(...corners[2]); // floor
  ctx.lineTo(...corners[3]); ctx.lineTo(...corners[1]);
  ctx.stroke();
  const r = Math.max(10, W / 11);
  if (numbered) {
    corners.forEach(([x, y], i) => {
      ctx.fillStyle = '#00e5a0';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#05221a';
      ctx.font = `bold ${r * 1.1}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 1);
    });
  } else if (index >= 0 && index < 6) {
    const [x, y] = corners[index];
    ctx.fillStyle = '#00e5a0';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  }
}

// Sample a wall tint just outside the back-wall quad, for the 3D view.
function sampleWallColor(photo, quadPts) {
  try {
    const ctx = photo.getContext('2d');
    const cx = quadPts.reduce((a, p) => a + p.x, 0) / 4;
    const cy = quadPts.reduce((a, p) => a + p.y, 0) / 4;
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (const p of quadPts) {
      const sx = Math.round(p.x + (p.x - cx) * 0.45);
      const sy = Math.round(p.y + (p.y - cy) * 0.45);
      if (sx < 2 || sy < 2 || sx > photo.width - 3 || sy > photo.height - 3) continue;
      const data = ctx.getImageData(sx - 2, sy - 2, 5, 5).data;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    if (n === 0) return '#b8b0a4';
    return `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
  } catch {
    return '#b8b0a4';
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('screen-welcome')) {
  window.app = new SpaceScanApp();
}
