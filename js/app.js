/**
 * SpaceScanApp — orchestrator. Owns the screen state machine and wires the
 * capture → measure → scale → render pipeline together.
 *
 * The whole scan is ONE photo and 6 corner taps — nothing else:
 *   photograph the space/object → tap its 6 corners (a diagram highlights
 *   which corner each tap is) → rectangle metrology recovers every dimension
 *   ratio from the perspective (EXIF focal when available) → absolute scale
 *   is inferred from the camera's recovered height above the floor (typical
 *   phone-holding height). Tapping a dimension on the results screen
 *   corrects it and rescales the others.
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
  'BACK-LEFT floor corner',
  'BACK-RIGHT floor corner',
  'FRONT-LEFT floor corner',
  'FRONT-RIGHT floor corner',
  'TOP-LEFT of the back',
  'TOP-RIGHT of the back',
];

// How high people typically hold a phone when photographing a room. The
// camera's height above the floor comes out of the pose recovery in scene
// units, so this one assumption sets the absolute scale with no user input.
// Tapping a dimension on the results screen corrects it (and the others).
const ASSUMED_PHONE_HEIGHT_IN = 57;

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
    this.$('dims').addEventListener('click', (e) => this.onDimTap(e));

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
        drawGuide(this.$('guide-canvas'), picker.complete ? -1 : n);
        // Keep this short & stable — long wrapping text here resizes the
        // header and shifts the photo under the user's finger between taps.
        const coach = n === 0 ? ' (slide to align in the loupe, lift to set)' : '';
        instruction.textContent = picker.complete
          ? `✓ All ${labels.length} set — ${doneText || 'drag any point to fine-tune, then tap Next'}`
          : `${n + 1} of ${labels.length}: tap the ${labels[n]} \u2014 the green dot in the diagram${coach}`;
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
      'Calculating dimensions…',
      'Solving the 3D geometry from your corners',
      async () => this.showResults(scan),
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
        // The pose recovery yields the camera's height above the floor in
        // scene units — one assumption about how high a phone is held turns
        // that into absolute inches, with no user input at all.
        const camHeightUnits = Math.abs(metro.C[2]);
        if (!(camHeightUnits > 1e-6)) throw new Error('Could not recover the camera position — retake the photo');
        return {
          raw: {
            width: metro.distance(bl, br),
            depth: metro.distance(bl, fl),
            heightLeft: metro.wallHeight(bl, br, tl),
            heightRight: metro.wallHeight(bl, br, tr),
          },
          scale: ASSUMED_PHONE_HEIGHT_IN / camHeightUnits,
          photo,
          wallColor: sampleWallColor(photo, backQuad),
          note: photo.focalPx
            ? ''
            : ' · no camera EXIF in this photo — accuracy reduced',
        };
      } catch (err) {
        alert(`${err.message || err}`);
      }
    }
  }

  // --------------------------------------------------------------- results

  buildModel() {
    const { raw, scale } = this.current;
    return new ClosetModel({
      widthTop: raw.width * scale,
      widthBottom: raw.width * scale,
      heightLeft: raw.heightLeft * scale,
      heightRight: raw.heightRight * scale,
      depth: raw.depth * scale,
    });
  }

  renderDims() {
    const model = this.buildModel();
    this.resultsModel = model;
    this.$('dims').innerHTML = [
      dimCard('Width', model.widthText, 'width'),
      dimCard('Height', model.heightText, 'height'),
      dimCard('Depth', model.depthText, 'depth'),
    ].join('');

    const spreadText = ClosetModel.toFraction16(model.maxSpread);
    const consistency = model.isConsistent
      ? `<span class="ok">✓ Consistency check passed</span> — paired readings agree within ${spreadText}`
      : `<span class="warn">⚠ Paired readings differ by ${spreadText}</span> — refine your corner taps or retake the photo`;
    const scaleNote = this.current.corrected
      ? `scale set from the ${this.current.corrected} you entered`
      : 'auto-scale from phone height — tap any dimension to correct it, the others follow';
    this.$('diagnostics').innerHTML = `${consistency}<br>${scaleNote}${this.current.note}`;

    // Rescaling changes the 3D model; rebuild the renderer lazily.
    if (this.renderer) { this.renderer.destroy(); this.renderer = null; }
    if (this.$('scene-canvas').hidden === false) this.setResultsView('3d');
  }

  showResults({ raw, scale, photo, wallColor, note }) {
    this.current = { raw, scale, note, corrected: null };
    this.showScreen('results');
    this.resultsWallColor = wallColor;

    if (this.compareView) { this.compareView.destroy(); this.compareView = null; }
    if (photo) {
      this.compareView = new BeforeAfterView(this.$('compare-canvas'), buildEmptiedViews(photo));
    }
    this.$('btn-erase').classList.remove('active');
    this.renderDims();
    this.setResultsView(this.compareView ? 'photo' : '3d');
  }

  // Tap a dimension card to correct it; the other dimensions rescale from
  // the same factor (the proportions from the photo are already right).
  onDimTap(e) {
    const card = e.target.closest('.dim-card');
    if (!card || !this.current) return;
    const dim = card.dataset.dim;
    const raw = this.current.raw;
    const rawValue = dim === 'width' ? raw.width
      : dim === 'depth' ? raw.depth
      : (raw.heightLeft + raw.heightRight) / 2;
    const answer = prompt(`Enter the real ${dim} in inches — everything rescales from it:`);
    if (answer == null) return;
    const value = parseFloat(answer);
    if (!Number.isFinite(value) || value <= 0) return;
    this.current.scale = value / rawValue;
    this.current.corrected = dim;
    this.renderDims();
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

function dimCard(label, value, dim) {
  return `<div class="dim-card" data-dim="${dim}"><div class="dim-label">${label}</div>`
    + `<div class="dim-value">${value}</div><div class="dim-edit">tap to correct</div></div>`;
}

// Tiny 3D guide next to the tap instructions: a wireframe of the space with
// the corner to tap highlighted -- clearer than any wording.
function drawGuide(canvas, index) {
  const ctx = canvas.getContext('2d');
  const S = 2; // 128px backing for a 64px box
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // corner positions: back floor L/R, front floor L/R, back top L/R
  const corners = [
    [18, 42], [46, 42], [8, 56], [56, 56], [18, 8], [46, 8],
  ].map(([x, y]) => [x * S, y * S]);
  ctx.strokeStyle = '#5b6b80';
  ctx.lineWidth = 2;
  ctx.beginPath();
  // back wall
  ctx.moveTo(...corners[4]); ctx.lineTo(...corners[5]);
  ctx.lineTo(...corners[1]); ctx.lineTo(...corners[0]); ctx.closePath();
  // floor
  ctx.moveTo(...corners[0]); ctx.lineTo(...corners[2]); ctx.lineTo(...corners[3]); ctx.lineTo(...corners[1]);
  ctx.stroke();
  if (index >= 0 && index < 6) {
    const [x, y] = corners[index];
    ctx.fillStyle = '#00e5a0';
    ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke();
  }
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
