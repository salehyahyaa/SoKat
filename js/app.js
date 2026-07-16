/**
 * ClosetScanApp — orchestrator. Owns the screen state machine and wires the
 * capture → calibrate → measure → render pipeline together.
 *
 * Scan flow:
 *   1. Back-wall photo  → tap 4 paper corners (calibration) → tap 4 closet
 *      corners → width & height, each measured twice for consistency.
 *   2. Floor photo      → tap 4 paper corners → tap back edge & front edge
 *      → depth.
 *   3. Results          → dimensions to 1/16" + rotatable 3D empty closet.
 *
 * Accuracy Check flow: calibrate on sheet A, measure a second known distance,
 * display the live error vs. the 1/16" target.
 */
import { CameraCapture } from './camera.js';
import { CornerPicker } from './picker.js';
import { PlaneMeasurement } from './measurement.js';
import { SingleViewMetrology } from './metrology.js';
import { ClosetModel } from './closet-model.js';
import { EmptyClosetRenderer } from './renderer.js';
import { buildEmptiedViews, BeforeAfterView } from './emptier.js';
import { AccuracyChecker, TARGET_IN } from './accuracy.js';

const RETAKE = Symbol('retake');
const HOME = Symbol('home');

const PAPER_COLOR = '#4da3ff';
const TARGET_COLOR = '#00e5a0';

const LABELS = {
  paperWall: [
    'paper TOP-LEFT corner',
    'paper TOP-RIGHT corner',
    'paper BOTTOM-RIGHT corner',
    'paper BOTTOM-LEFT corner',
  ],
  closet: [
    'closet back wall TOP-LEFT corner',
    'closet back wall TOP-RIGHT corner',
    'closet back wall BOTTOM-RIGHT corner',
    'closet back wall BOTTOM-LEFT corner',
  ],
  closet6: [
    'closet floor BACK-LEFT corner (floor meets back wall)',
    'closet floor BACK-RIGHT corner',
    'closet floor FRONT-LEFT corner (front edge)',
    'closet floor FRONT-RIGHT corner',
    'TOP-LEFT of the back wall (at the ceiling)',
    'TOP-RIGHT of the back wall (at the ceiling)',
  ],
  paperFloor: [
    'paper corner — start of a LONG (11″) edge',
    'paper corner — other end of that LONG edge',
    'paper corner — continue around the sheet',
    'paper corner — last one',
  ],
  depth: [
    'floor where it meets the BACK wall',
    'FRONT edge of the closet floor (straight out from point 1)',
  ],
  accuracy: [
    'known distance — FIRST end',
    'known distance — SECOND end',
  ],
};

export class ClosetScanApp {
  constructor(doc = document) {
    this.doc = doc;
    this.$ = (id) => doc.getElementById(id);
    this.camera = new CameraCapture(this.$('camera-input'));
    this.picker = null;
    this.renderer = null;
    this.compareView = null;

    this.$('btn-view-photo').addEventListener('click', () => this.setResultsView('photo'));
    this.$('btn-view-3d').addEventListener('click', () => this.setResultsView('3d'));
    this.$('btn-start').addEventListener('click', () => this.runGuarded(() => this.runQuickScan()));
    this.$('btn-precision').addEventListener('click', () => this.runGuarded(() => this.runPrecisionScan()));
    this.$('btn-accuracy').addEventListener('click', () => this.runGuarded(() => this.runAccuracyCheck()));
    this.$('btn-restart').addEventListener('click', () => this.showScreen('welcome'));
    this.$('btn-acc-home').addEventListener('click', () => this.showScreen('welcome'));
    this.$('btn-acc-again').addEventListener('click', () => this.runGuarded(() => this.runAccuracyCheck()));
    this.$('acc-true').addEventListener('input', () => this.updateAccuracyReport());

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

  setOverlay(on, { title = '', sub = '', done = false } = {}) {
    const overlay = this.$('loading-overlay');
    this.$('loading-title').textContent = title;
    this.$('loading-sub').textContent = sub;
    overlay.classList.toggle('done', done);
    overlay.classList.toggle('active', on);
  }

  // Confirmation beat between steps: a ✓ with "what's next", so a Next tap
  // always produces visible feedback before the screen changes under it.
  async flashStep(title, sub, ms = 1100) {
    this.setOverlay(true, { title, sub, done: true });
    await new Promise((r) => setTimeout(r, ms));
    this.setOverlay(false);
  }

  // Spinner shown while `work` runs; stays up ≥ minMs so it reads as a real
  // processing step instead of a flicker.
  async withLoading(title, sub, work, minMs = 900) {
    this.setOverlay(true, { title, sub });
    const t0 = performance.now();
    try {
      // Let the overlay paint before any canvas-heavy work blocks the thread.
      await new Promise((r) => requestAnimationFrame(() => r()));
      const result = await work();
      const left = minMs - (performance.now() - t0);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      return result;
    } finally {
      this.setOverlay(false);
    }
  }

  // ---------------------------------------------------------------- capture

  // Show the capture screen and wait for a photo. The camera button stays
  // armed the whole time — a cancelled camera sheet (no event on iOS) just
  // means the user taps again. Rejects HOME if the user backs out.
  capturePhoto(title, text) {
    this.showScreen('capture');
    this.$('capture-title').textContent = title;
    this.$('capture-text').innerHTML = text;
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

  // ------------------------------------------------------------------ pick

  // One corner-picking session on a photo; resolves the points, or RETAKE.
  pickPoints(photo, { title, labels, color, ghosts = [], doneText, segments = [], segmentLabel = null }) {
    this.showScreen('pick');
    this.$('pick-title').textContent = title;
    const canvas = this.$('pick-canvas');
    const btnNext = this.$('btn-next');
    const btnUndo = this.$('btn-undo');
    const btnRetake = this.$('btn-retake');
    const instruction = this.$('pick-instruction');

    this.teardownPicker();
    return new Promise((resolve) => {
      const update = (picker) => {
        btnNext.disabled = !picker.complete;
        const n = picker.points.length;
        // Keep this short & stable — long wrapping text here resizes the
        // header and shifts the photo under the user's finger between taps.
        const coach = n === 0 ? ' (slide to align in the loupe, lift to set)' : '';
        instruction.textContent = picker.complete
          ? `✓ All ${labels.length} set — ${doneText || 'drag any point to fine-tune, then tap Next'}`
          : `${n + 1} of ${labels.length}: tap the ${labels[n]}${coach}`;
      };
      const picker = new CornerPicker(canvas, photo, {
        count: labels.length,
        color,
        ghosts,
        segments,
        segmentLabel,
        onChange: update,
      });
      this.picker = picker;

      const onNext = () => { cleanup(); resolve(picker.points.map((p) => ({ ...p }))); };
      const onUndo = () => { picker.undo(); };
      const onRetake = () => { cleanup(); resolve(RETAKE); };
      const cleanup = () => {
        btnNext.removeEventListener('click', onNext);
        btnUndo.removeEventListener('click', onUndo);
        btnRetake.removeEventListener('click', onRetake);
        this.teardownPicker();
      };
      btnNext.addEventListener('click', onNext);
      btnUndo.addEventListener('click', onUndo);
      btnRetake.addEventListener('click', onRetake);
      update(picker);
    });
  }

  // ------------------------------------------------------------------ scan

  // Quick Scan: ONE photo, paper simply dropped flat on the closet floor.
  // Width & depth are measured on the calibrated floor plane; height is
  // recovered from the camera pose (EXIF focal when available). Convenience
  // mode — typical accuracy ±1/2″, height ±1½″.
  async runQuickScan() {
    const scan = await this.stepQuickScan();
    await this.withLoading(
      'Emptying your closet…',
      'Removing contents and calculating dimensions',
      async () => this.showResults(scan),
      1400,
    );
  }

  async stepQuickScan() {
    while (true) {
      const photo = await this.capturePhoto(
        'One photo — the whole closet',
        'Drop the letter-size sheet <b>flat on the closet floor</b> — no tape '
        + 'needed.<br><br>Step back so ONE photo shows the <b>whole closet</b>: '
        + 'the floor from its front edge to the back wall, and the back wall '
        + 'up to the ceiling. Shoot from a natural standing height.',
      );
      const paper = await this.pickPoints(photo, {
        title: 'Calibrate — paper corners',
        labels: LABELS.paperFloor,
        color: PAPER_COLOR,
      });
      if (paper === RETAKE) continue;

      let metro;
      try {
        metro = new SingleViewMetrology(paper, photo.width, photo.height, {
          focalPx: photo.focalPx || null,
        });
      } catch (err) {
        alert(`${err.message || err}`);
        continue;
      }
      await this.flashStep(
        'Floor calibrated',
        'Same photo — tap the 6 closet corners. Lines measure LIVE as you drag.',
      );

      // Measured live segments: back width, front width, both depths, both
      // heights — the tape-measure lines that follow the finger.
      const SEGMENTS = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 4], [1, 5]];
      const SEG_PREFIX = { '0,1': 'W', '2,3': 'W', '0,2': 'D', '1,3': 'D', '0,4': 'H', '1,5': 'H' };
      const pts = await this.pickPoints(photo, {
        title: 'Measure — closet corners',
        labels: LABELS.closet6,
        color: TARGET_COLOR,
        ghosts: [{ points: paper, color: PAPER_COLOR }],
        segments: SEGMENTS,
        segmentLabel: (i, j, a, b) => {
          const prefix = SEG_PREFIX[`${i},${j}`];
          if (prefix === 'H') {
            const base = this.picker?.points;
            if (!base || !base[0] || !base[1]) return null;
            return `H ${ClosetModel.toFraction16(metro.wallHeight(base[0], base[1], b))}`;
          }
          return `${prefix} ${ClosetModel.toFraction16(metro.distance(a, b))}`;
        },
      });
      if (pts === RETAKE) continue;

      try {
        const backQuad = [pts[4], pts[5], pts[1], pts[0]]; // TL TR BR BL
        return {
          model: new ClosetModel({
            widthTop: metro.distance(pts[0], pts[1]),
            widthBottom: metro.distance(pts[2], pts[3]),
            heightLeft: metro.wallHeight(pts[0], pts[1], pts[4]),
            heightRight: metro.wallHeight(pts[0], pts[1], pts[5]),
            depthLeft: metro.distance(pts[0], pts[2]),
            depthRight: metro.distance(pts[1], pts[3]),
          }),
          photo,
          closetQuad: backQuad,
          wallColor: sampleWallColor(photo, backQuad),
          note: metro.focalSource === 'exif'
            ? 'Quick Scan (1 photo) · typical ±1/2″, height ±1½″ — use Precision Scan for 1/16″'
            : 'Quick Scan (1 photo, no camera EXIF — height is approximate) — use Precision Scan for 1/16″',
        };
      } catch (err) {
        alert(`${err.message || err}`);
      }
    }
  }

  // Precision Scan: the original two-photo flow — paper taped to the back
  // wall, then on the floor. Everything is measured ON a calibrated plane,
  // which is what reaches the 1/16″ target (see tests/noise.test.js).
  async runPrecisionScan() {
    let wall = await this.stepBackWall();
    let passes = 1;
    if (await this.offerRefinement()) {
      // Second independent photo + taps; averaging two independent
      // measurements cuts noise by ~sqrt(2) — this is what carries a large
      // width across the 1/16" target (see tests/noise.test.js).
      const second = await this.stepBackWall();
      wall = {
        widthTop: (wall.widthTop + second.widthTop) / 2,
        widthBottom: (wall.widthBottom + second.widthBottom) / 2,
        heightLeft: (wall.heightLeft + second.heightLeft) / 2,
        heightRight: (wall.heightRight + second.heightRight) / 2,
        wallColor: wall.wallColor,
        photo: wall.photo,
        closetQuad: wall.closetQuad,
      };
      passes = 2;
    }
    const depth = await this.stepFloor();
    await this.withLoading(
      'Emptying your closet…',
      'Removing contents and calculating dimensions to 1/16″',
      async () => this.showResults({
        model: new ClosetModel({ ...wall, depth }),
        photo: wall.photo,
        closetQuad: wall.closetQuad,
        wallColor: wall.wallColor,
        note: `Precision Scan (2 photos) · targets 1/16″${passes > 1 ? ` · ${passes} passes averaged` : ''}`,
      }),
      1400,
    );
  }

  // Ask whether to take a second back-wall photo for maximum accuracy.
  offerRefinement() {
    this.showScreen('refine');
    const btnYes = this.$('btn-refine-yes');
    const btnSkip = this.$('btn-refine-skip');
    return new Promise((resolve) => {
      const onYes = () => { cleanup(); resolve(true); };
      const onSkip = () => { cleanup(); resolve(false); };
      const cleanup = () => {
        btnYes.removeEventListener('click', onYes);
        btnSkip.removeEventListener('click', onSkip);
      };
      btnYes.addEventListener('click', onYes);
      btnSkip.addEventListener('click', onSkip);
    });
  }

  // Back-wall photo → paper calibration + closet corners → W & H.
  async stepBackWall() {
    while (true) {
      const photo = await this.capturePhoto(
        'Step 1 of 2 — Back wall',
        'Tape the letter-size sheet <b>flat</b> on the closet\'s back wall, '
        + '<b>landscape</b> (long edge horizontal), around chest height.<br><br>'
        + 'Stand back so the <b>whole back wall</b> is in frame, hold the phone '
        + 'as square to the wall as you can, and take the photo.',
      );
      const paper = await this.pickPoints(photo, {
        title: 'Calibrate — paper corners',
        labels: LABELS.paperWall,
        color: PAPER_COLOR,
      });
      if (paper === RETAKE) continue;
      await this.flashStep(
        'Paper calibrated',
        'Same photo — now tap the 4 corners of the closet back wall',
      );
      const closet = await this.pickPoints(photo, {
        title: 'Measure — closet corners',
        labels: LABELS.closet,
        color: TARGET_COLOR,
        ghosts: [{ points: paper, color: PAPER_COLOR }],
      });
      if (closet === RETAKE) continue;
      await this.flashStep('Width & height captured', 'Next: measure the depth');

      const plane = new PlaneMeasurement(paper);
      return {
        widthTop: plane.distance(closet[0], closet[1]),
        widthBottom: plane.distance(closet[3], closet[2]),
        heightLeft: plane.distance(closet[0], closet[3]),
        heightRight: plane.distance(closet[1], closet[2]),
        wallColor: sampleWallColor(photo, paper),
        photo,
        closetQuad: closet,
      };
    }
  }

  // Floor photo → paper calibration + 2 depth points → D.
  async stepFloor() {
    while (true) {
      const photo = await this.capturePhoto(
        'Step 2 of 2 — Floor (depth)',
        'Move the sheet to the <b>closet floor</b>, lying flat.<br><br>'
        + 'Photograph the floor so you can see both the <b>back wall base</b> '
        + 'and the <b>front edge</b> of the closet.',
      );
      const paper = await this.pickPoints(photo, {
        title: 'Calibrate — paper corners',
        labels: LABELS.paperFloor,
        color: PAPER_COLOR,
      });
      if (paper === RETAKE) continue;
      await this.flashStep(
        'Paper calibrated',
        'Same photo — now mark the closet depth with 2 points',
      );
      const pts = await this.pickPoints(photo, {
        title: 'Measure — depth',
        labels: LABELS.depth,
        color: TARGET_COLOR,
        ghosts: [{ points: paper, color: PAPER_COLOR }],
      });
      if (pts === RETAKE) continue;

      const plane = new PlaneMeasurement(paper);
      return plane.distance(pts[0], pts[1]);
    }
  }

  showResults({ model, photo, closetQuad, wallColor, note }) {
    this.showScreen('results');
    this.$('dims').innerHTML = [
      dimCard('Width', model.widthText),
      dimCard('Height', model.heightText),
      dimCard('Depth', model.depthText),
    ].join('');

    const spreadText = ClosetModel.toFraction16(model.maxSpread);
    const consistency = model.isConsistent
      ? `<span class="ok">✓ Consistency check passed</span> — paired readings agree within ${spreadText}`
      : `<span class="warn">⚠ Paired readings differ by ${spreadText}</span> — refine your corner taps or retake the photo`;
    this.$('diagnostics').innerHTML = `${consistency}<br>${note}`;

    if (this.renderer) { this.renderer.destroy(); this.renderer = null; }
    if (this.compareView) { this.compareView.destroy(); this.compareView = null; }
    this.resultsModel = model;
    this.resultsWallColor = wallColor;
    if (photo && closetQuad) {
      const views = buildEmptiedViews(photo, closetQuad, wallColor);
      this.compareView = new BeforeAfterView(this.$('compare-canvas'), views);
    }
    this.setResultsView(this.compareView ? 'photo' : '3d');
  }

  // Toggle between the emptied-photo comparison and the 3D model. Views are
  // (re)laid out on entry because a hidden canvas has zero size.
  setResultsView(which) {
    const photoMode = which === 'photo' && this.compareView;
    this.$('btn-view-photo').classList.toggle('active', !!photoMode);
    this.$('btn-view-3d').classList.toggle('active', !photoMode);
    this.$('compare-canvas').hidden = !photoMode;
    this.$('scene-canvas').hidden = !!photoMode;
    if (photoMode) {
      this.$('view-hint').textContent = 'slide the handle — left: as photographed, right: contents removed';
      this.compareView.layout();
      this.compareView.render();
    } else {
      this.$('view-hint').textContent = 'drag to look around the empty closet';
      if (!this.renderer && this.resultsModel) {
        this.renderer = new EmptyClosetRenderer(this.$('scene-canvas'), this.resultsModel, {
          wallColor: this.resultsWallColor,
        });
      } else if (this.renderer) {
        this.renderer.layout();
        this.renderer.render();
      }
    }
  }

  // ------------------------------------------------------- accuracy check

  async runAccuracyCheck() {
    while (true) {
      const photo = await this.capturePhoto(
        'Accuracy Check',
        'Tape <b>two</b> letter-size sheets on the same wall, a few feet apart '
        + '(or one sheet plus any distance you\'ve measured with a tape).<br><br>'
        + 'The app will calibrate on sheet A, measure the known distance, and '
        + 'show its own error live.',
      );
      const paper = await this.pickPoints(photo, {
        title: 'Calibrate — sheet A corners',
        labels: LABELS.paperWall,
        color: PAPER_COLOR,
      });
      if (paper === RETAKE) continue;
      await this.flashStep(
        'Sheet A calibrated',
        'Same photo — now tap the two ends of the known distance',
      );
      const livePlane = new PlaneMeasurement(paper);
      const pts = await this.pickPoints(photo, {
        title: 'Measure a known distance',
        labels: LABELS.accuracy,
        color: TARGET_COLOR,
        ghosts: [{ points: paper, color: PAPER_COLOR }],
        doneText: 'tip: sheet B\'s long edge is exactly 11.000″ — tap Next',
        segments: [[0, 1]],
        segmentLabel: (i, j, a, b) => `${livePlane.distance(a, b).toFixed(3)}″`,
      });
      if (pts === RETAKE) continue;

      const checker = new AccuracyChecker(paper);
      this.lastMeasured = await this.withLoading(
        'Measuring…', 'Comparing against the calibrated plane',
        async () => checker.measure(pts[0], pts[1]),
      );
      this.showScreen('accuracy');
      this.$('acc-measured').textContent = `${this.lastMeasured.toFixed(3)}″`;
      this.updateAccuracyReport();
      return;
    }
  }

  updateAccuracyReport() {
    if (this.lastMeasured == null) return;
    const trueIn = parseFloat(this.$('acc-true').value);
    const badge = this.$('acc-badge');
    if (!Number.isFinite(trueIn) || trueIn <= 0) {
      this.$('acc-error').textContent = '—';
      badge.textContent = 'enter true length';
      badge.className = 'badge';
      return;
    }
    const r = AccuracyChecker.report(this.lastMeasured, trueIn);
    const sign = r.errorIn >= 0 ? '+' : '−';
    this.$('acc-error').textContent =
      `${sign}${Math.abs(r.errorIn).toFixed(3)}″  (${sign}${Math.abs(r.errorSixteenths).toFixed(1)}/16)`;
    badge.textContent = r.pass ? `PASS — within 1/16″ (${TARGET_IN.toFixed(4)}″)` : 'outside 1/16″ target';
    badge.className = r.pass ? 'badge pass' : 'badge fail';
  }
}

function dimCard(label, value) {
  return `<div class="dim-card"><div class="dim-label">${label}</div><div class="dim-value">${value}</div></div>`;
}

// Sample the wall color just outside the paper's corners so the rendered
// empty closet is tinted like the real one.
function sampleWallColor(photo, paperPts) {
  try {
    const ctx = photo.getContext('2d');
    const cx = paperPts.reduce((a, p) => a + p.x, 0) / 4;
    const cy = paperPts.reduce((a, p) => a + p.y, 0) / 4;
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (const p of paperPts) {
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
  window.app = new ClosetScanApp();
}
