/**
 * SpaceScanApp — orchestrator. Owns the screen state machine and wires the
 * capture → measure → scale → render pipeline together.
 *
 * The whole scan is ONE photo, 6 corner taps, and ONE typed number:
 *   photograph the space/object → tap its 6 corners (floor footprint
 *   assumed rectangular + the two top corners) → rectangle metrology
 *   recovers every dimension ratio from the perspective (EXIF focal when
 *   available) → the user enters ONE length they know (e.g. ceiling height)
 *   which sets the absolute scale for all three dimensions.
 *   Results: dimensions, the photo with an object-eraser brush (paint over
 *   anything to remove it — inpainted from the surrounding pixels), and a
 *   rotatable 3D model of the space.
 */
import { CameraCapture } from './camera.js';
import { CornerPicker } from './picker.js';
import { rectangleMetrology } from './metrology.js';
import { ClosetModel } from './closet-model.js';
import { EmptyClosetRenderer } from './renderer.js';
import { buildEmptiedViews, BeforeAfterView } from './emptier.js';

const RETAKE = Symbol('retake');
const HOME = Symbol('home');

const TARGET_COLOR = '#00e5a0';

const LABELS = [
  'floor BACK-LEFT corner (floor meets the back)',
  'floor BACK-RIGHT corner',
  'floor FRONT-LEFT corner (front edge)',
  'floor FRONT-RIGHT corner',
  'TOP-LEFT corner (top of the back)',
  'TOP-RIGHT corner',
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
    const model = await this.askScale(scan.raw);
    await this.withLoading(
      'Calculating dimensions…',
      'Solving the 3D geometry from your corners',
      async () => this.showResults({ ...scan, model }),
      1200,
    );
  }

  async stepScan() {
    while (true) {
      const photo = await this.capturePhoto(
        'One photo — the whole thing',
        'Photograph the space or object you want to measure.<br><br>'
        + 'Step back so ONE photo shows <b>all of it</b>: the floor/base from '
        + 'its front edge to the back, and the full height. Use the 0.5× '
        + 'lens if it doesn\'t all fit.',
      );
      const pts = await this.pickPoints(photo, {
        title: 'Tap the 6 corners',
        labels: LABELS,
      });
      if (pts === RETAKE) continue;

      try {
        const [bl, br, fl, fr, tl, tr] = pts;
        const metro = rectangleMetrology([bl, br, fr, fl], photo.width, photo.height, {
          focalPx: photo.focalPx || null,
        });
        const backQuad = [tl, tr, br, bl]; // used only to sample a wall tint
        return {
          // Every ratio is right; the absolute scale comes from askScale().
          raw: {
            width: metro.distance(bl, br),
            depth: metro.distance(bl, fl),
            heightLeft: metro.wallHeight(bl, br, tl),
            heightRight: metro.wallHeight(bl, br, tr),
          },
          photo,
          wallColor: sampleWallColor(photo, backQuad),
          note: photo.focalPx
            ? 'One-photo scan, scaled from the length you entered'
            : 'One-photo scan (no camera EXIF — accuracy reduced), scaled from the length you entered',
        };
      } catch (err) {
        alert(`${err.message || err}`);
      }
    }
  }

  // The one number the math cannot know from pixels: a real length. The user
  // enters whichever dimension they know (ceiling height is the usual one)
  // and every other dimension scales from it.
  askScale(raw) {
    this.showScreen('scale');
    const height = (raw.heightLeft + raw.heightRight) / 2;
    const rows = [
      { id: 'scale-h', dim: 'height', raw: height },
      { id: 'scale-w', dim: 'width', raw: raw.width },
      { id: 'scale-d', dim: 'depth', raw: raw.depth },
    ];
    const btn = this.$('btn-scale-done');
    const inputs = rows.map((r) => this.$(r.id));
    inputs.forEach((el) => { el.value = ''; });

    return new Promise((resolve) => {
      const firstFilled = () => {
        for (let i = 0; i < rows.length; i++) {
          const v = parseFloat(inputs[i].value);
          if (Number.isFinite(v) && v > 0) return { ...rows[i], value: v };
        }
        return null;
      };
      const update = () => { btn.disabled = !firstFilled(); };
      const onDone = () => {
        const known = firstFilled();
        if (!known) return;
        cleanup();
        const scale = known.value / known.raw;
        resolve(new ClosetModel({
          widthTop: raw.width * scale,
          widthBottom: raw.width * scale,
          heightLeft: raw.heightLeft * scale,
          heightRight: raw.heightRight * scale,
          depth: raw.depth * scale,
        }));
      };
      const cleanup = () => {
        btn.removeEventListener('click', onDone);
        inputs.forEach((el) => el.removeEventListener('input', update));
      };
      btn.addEventListener('click', onDone);
      inputs.forEach((el) => el.addEventListener('input', update));
      update();
    });
  }

  // --------------------------------------------------------------- results

  showResults({ model, photo, wallColor, note }) {
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
    if (photo) {
      this.compareView = new BeforeAfterView(this.$('compare-canvas'), buildEmptiedViews(photo));
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
      ? 'paint over an object and lift your finger — it disappears'
      : 'slide the handle to compare original vs edited';
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
      this.$('view-hint').textContent = 'tap Erase objects, then paint over anything to remove it';
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
