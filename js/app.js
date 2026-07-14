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
import { ClosetModel } from './closet-model.js';
import { EmptyClosetRenderer } from './renderer.js';
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

    this.$('btn-start').addEventListener('click', () => this.runGuarded(() => this.runScan()));
    this.$('btn-accuracy').addEventListener('click', () => this.runGuarded(() => this.runAccuracyCheck()));
    this.$('btn-restart').addEventListener('click', () => this.showScreen('welcome'));
    this.$('btn-acc-home').addEventListener('click', () => this.showScreen('welcome'));
    this.$('btn-acc-again').addEventListener('click', () => this.runGuarded(() => this.runAccuracyCheck()));
    this.$('acc-true').addEventListener('input', () => this.updateAccuracyReport());

    this.showScreen('welcome');
  }

  async runGuarded(fn) {
    try {
      await fn();
    } catch (err) {
      if (err === HOME) { this.showScreen('welcome'); return; }
      alert(`Something went wrong: ${err.message || err}`);
      this.showScreen('welcome');
    } finally {
      this.teardownPicker();
    }
  }

  showScreen(name) {
    for (const s of this.doc.querySelectorAll('.screen')) s.classList.remove('active');
    this.$(`screen-${name}`).classList.add('active');
  }

  teardownPicker() {
    if (this.picker) { this.picker.destroy(); this.picker = null; }
  }

  // ---------------------------------------------------------------- capture

  /**
   * Show the capture screen and wait for a photo.
   * @returns {Promise<HTMLCanvasElement>} throws HOME if the user backs out
   */
  async capturePhoto(title, text) {
    this.showScreen('capture');
    this.$('capture-title').textContent = title;
    this.$('capture-text').innerHTML = text;
    const btnCam = this.$('btn-open-camera');
    const btnBack = this.$('btn-capture-home');
    while (true) {
      const photo = await new Promise((resolve, reject) => {
        const onCam = async () => {
          cleanup();
          try { resolve(await this.camera.capture()); } catch (e) { reject(e); }
        };
        const onBack = () => { cleanup(); reject(HOME); };
        const cleanup = () => {
          btnCam.removeEventListener('click', onCam);
          btnBack.removeEventListener('click', onBack);
        };
        btnCam.addEventListener('click', onCam, { once: true });
        btnBack.addEventListener('click', onBack, { once: true });
      });
      if (photo) return photo; // null = user cancelled the camera; stay here
    }
  }

  // ------------------------------------------------------------------ pick

  /**
   * Run one corner-picking session on a photo.
   * @returns {Promise<{x:number,y:number}[]|typeof RETAKE>}
   */
  pickPoints(photo, { title, labels, color, ghosts = [], doneText }) {
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
        instruction.textContent = picker.complete
          ? (doneText || 'Drag any point to fine-tune, then tap Next')
          : `Tap the ${labels[picker.points.length]} — slide to line up the loupe crosshair, then lift`;
      };
      const picker = new CornerPicker(canvas, photo, {
        count: labels.length,
        color,
        ghosts,
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

  async runScan() {
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
      };
      passes = 2;
    }
    const depth = await this.stepFloor();
    this.showResults(wall, depth, passes);
  }

  /** Ask whether to take a second back-wall photo for maximum accuracy. */
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

  /** Photo of the back wall → paper calibration + closet corners → W & H. */
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
      const closet = await this.pickPoints(photo, {
        title: 'Measure — closet corners',
        labels: LABELS.closet,
        color: TARGET_COLOR,
        ghosts: [{ points: paper, color: PAPER_COLOR }],
      });
      if (closet === RETAKE) continue;

      const plane = new PlaneMeasurement(paper);
      return {
        widthTop: plane.distance(closet[0], closet[1]),
        widthBottom: plane.distance(closet[3], closet[2]),
        heightLeft: plane.distance(closet[0], closet[3]),
        heightRight: plane.distance(closet[1], closet[2]),
        wallColor: sampleWallColor(photo, paper),
      };
    }
  }

  /** Photo of the floor → paper calibration + 2 depth points → D. */
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

  showResults(wall, depth, passes = 1) {
    const model = new ClosetModel({ ...wall, depth });
    this.showScreen('results');
    this.$('dims').innerHTML = [
      dimCard('Width', model.widthText),
      dimCard('Height', model.heightText),
      dimCard('Depth', model.depthText),
    ].join('');

    const spreadText = ClosetModel.toFraction16(model.maxSpread);
    const passNote = passes > 1 ? ` · ${passes} measurement passes averaged` : '';
    this.$('diagnostics').innerHTML = model.isConsistent
      ? `<span class="ok">✓ Consistency check passed</span> — opposite edges agree within ${spreadText}${passNote}`
      : `<span class="warn">⚠ Opposite edges differ by ${spreadText}</span> — refine your corner taps or retake the photo more square-on`;

    if (this.renderer) this.renderer.destroy();
    this.renderer = new EmptyClosetRenderer(this.$('scene-canvas'), model, {
      wallColor: wall.wallColor,
    });
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
      const pts = await this.pickPoints(photo, {
        title: 'Measure a known distance',
        labels: LABELS.accuracy,
        color: TARGET_COLOR,
        ghosts: [{ points: paper, color: PAPER_COLOR }],
        doneText: 'Tip: sheet B\'s long edge is exactly 11.000″',
      });
      if (pts === RETAKE) continue;

      const checker = new AccuracyChecker(paper);
      this.lastMeasured = checker.measure(pts[0], pts[1]);
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

/**
 * Sample the real wall color from the photo just outside the paper's corners,
 * so the rendered empty closet is tinted like the actual closet.
 */
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
