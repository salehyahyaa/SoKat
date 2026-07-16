/**
 * SpaceScanApp — orchestrator. Owns the screen state machine and wires the
 * capture → calibrate → measure → render pipeline together.
 *
 * The whole scan is ONE photo and ONE tapping session:
 *   drop a letter-size sheet flat on the floor of the space → photograph the
 *   whole space → tap 10 points (4 paper corners, then 6 space corners).
 *   Width & depth come straight off the paper-calibrated floor plane; height is recovered
 *   from the camera pose (single-view metrology, EXIF focal when available).
 *   Results: dimensions, a before/after "contents removed" photo, and a
 *   rotatable 3D model of the empty space.
 */
import { CameraCapture } from './camera.js';
import { CornerPicker } from './picker.js';
import { SingleViewMetrology } from './metrology.js';
import { ClosetModel } from './closet-model.js';
import { EmptyClosetRenderer } from './renderer.js';
import { buildEmptiedViews, BeforeAfterView } from './emptier.js';

const RETAKE = Symbol('retake');
const HOME = Symbol('home');

const PAPER_COLOR = '#4da3ff';
const TARGET_COLOR = '#00e5a0';

// One session: paper first (blue), then the space's corners (green).
const LABELS = [
  'paper corner — start of a LONG (11″) edge',
  'paper corner — other end of that LONG edge',
  'paper corner — continue around the sheet',
  'paper corner — last one',
  'floor BACK-LEFT corner (floor meets back wall)',
  'floor BACK-RIGHT corner',
  'floor FRONT-LEFT corner (front edge)',
  'floor FRONT-RIGHT corner',
  'TOP-LEFT of the back wall (at the ceiling)',
  'TOP-RIGHT of the back wall (at the ceiling)',
];
const POINT_COLORS = [
  PAPER_COLOR, PAPER_COLOR, PAPER_COLOR, PAPER_COLOR,
  TARGET_COLOR, TARGET_COLOR, TARGET_COLOR, TARGET_COLOR, TARGET_COLOR, TARGET_COLOR,
];

export class SpaceScanApp {
  constructor(doc = document) {
    this.doc = doc;
    this.$ = (id) => doc.getElementById(id);
    this.camera = new CameraCapture(this.$('camera-input'));
    this.picker = null;
    this.renderer = null;
    this.compareView = null;

    this.$('btn-view-photo').addEventListener('click', () => this.setResultsView('photo'));
    this.$('btn-view-3d').addEventListener('click', () => this.setResultsView('3d'));
    this.$('btn-erase').addEventListener('click', () => this.toggleErase());
    this.$('btn-erase-reset').addEventListener('click', () => {
      if (this.compareView) this.compareView.reset();
    });
    this.$('btn-start').addEventListener('click', () => this.runGuarded(() => this.runScan()));
    this.$('btn-restart').addEventListener('click', () => this.showScreen('welcome'));

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

  // The single tapping session on the photo; resolves the points, or RETAKE.
  pickPoints(photo, { title, labels, ghosts = [], doneText, segments = [], segmentLabel = null, pointColors = null }) {
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
        color: TARGET_COLOR,
        ghosts,
        segments,
        segmentLabel,
        pointColors,
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
    const scan = await this.stepScan();
    await this.withLoading(
      'Emptying the space…',
      'Removing contents and calculating dimensions',
      async () => this.showResults(scan),
      1400,
    );
  }

  async stepScan() {
    while (true) {
      const photo = await this.capturePhoto(
        'One photo — the whole space',
        'Drop the letter-size sheet <b>flat on the floor</b> of the space — '
        + 'no tape needed.<br><br>Step back so ONE photo shows the '
        + '<b>whole space</b>: the floor from its front edge to the back '
        + 'wall, and the back wall up to the ceiling. Use the 0.5× lens if '
        + 'it doesn\'t all fit.',
      );
      const pts = await this.pickPoints(photo, {
        title: 'Tap the 10 points',
        labels: LABELS,
        pointColors: POINT_COLORS,
      });
      if (pts === RETAKE) continue;

      try {
        const metro = new SingleViewMetrology(pts.slice(0, 4), photo.width, photo.height, {
          focalPx: photo.focalPx || null,
        });
        const [, , , , bl, br, fl, fr, tl, tr] = pts;
        const backQuad = [tl, tr, br, bl]; // TL TR BR BL of the back wall
        return {
          model: new ClosetModel({
            widthTop: metro.distance(bl, br),
            widthBottom: metro.distance(fl, fr),
            heightLeft: metro.wallHeight(bl, br, tl),
            heightRight: metro.wallHeight(bl, br, tr),
            depthLeft: metro.distance(bl, fl),
            depthRight: metro.distance(br, fr),
          }),
          photo,
          backQuad,
          wallColor: sampleWallColor(photo, backQuad),
          note: metro.focalSource === 'exif'
            ? 'One-photo scan · typical accuracy ±1/2″ (height ±1½″)'
            : 'One-photo scan (no camera EXIF — height is approximate)',
        };
      } catch (err) {
        alert(`${err.message || err}`);
      }
    }
  }

  // --------------------------------------------------------------- results

  showResults({ model, photo, backQuad, wallColor, note }) {
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
    if (photo && backQuad) {
      const views = buildEmptiedViews(photo, backQuad, wallColor);
      this.compareView = new BeforeAfterView(this.$('compare-canvas'), views);
    }
    this.$('btn-erase').classList.remove('active');
    this.setResultsView(this.compareView ? 'photo' : '3d');
  }

  // Erase mode: drag over any other object in the emptied photo to wipe it.
  toggleErase() {
    if (!this.compareView) return;
    const on = !this.compareView.eraseMode;
    this.compareView.setEraseMode(on);
    this.$('btn-erase').classList.toggle('active', on);
    this.$('view-hint').textContent = on
      ? 'drag over any object to wipe it away — tap Erase again when done'
      : 'slide the handle — left: as photographed, right: contents removed';
  }

  // Toggle between the emptied-photo comparison and the 3D model. Views are
  // (re)laid out on entry because a hidden canvas has zero size.
  setResultsView(which) {
    const photoMode = which === 'photo' && this.compareView;
    this.$('btn-view-photo').classList.toggle('active', !!photoMode);
    this.$('btn-view-3d').classList.toggle('active', !photoMode);
    this.$('compare-canvas').hidden = !photoMode;
    this.$('scene-canvas').hidden = !!photoMode;
    this.$('erase-bar').hidden = !photoMode;
    if (photoMode) {
      this.$('view-hint').textContent = 'slide the handle — left: as photographed, right: contents removed';
      this.compareView.layout();
      this.compareView.render();
    } else {
      this.$('view-hint').textContent = 'drag to look around the empty space';
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
}

function dimCard(label, value) {
  return `<div class="dim-card"><div class="dim-label">${label}</div><div class="dim-value">${value}</div></div>`;
}

// Sample a plausible wall tint just outside the back-wall quad's corners so
// the rendered empty space is tinted like the real one.
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
