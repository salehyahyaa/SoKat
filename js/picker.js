/**
 * CornerPicker — precision point-tapping UI on top of a captured photo.
 *
 * Accuracy design: a finger tap is ±10 px; that is not good enough. So every
 * touch immediately enters drag mode with a magnifier loupe showing a zoomed
 * crosshair view of the pixels under the point, offset above the finger. The
 * user slides until the crosshair sits exactly on the corner, then lifts.
 * Existing points can be grabbed and re-refined the same way.
 *
 * All points are stored in source-image pixel coordinates (full photo
 * resolution), independent of screen scale — screen zoom never costs accuracy.
 */
export class CornerPicker {
  // segments: pairs of point indices connected with dashed wireframe lines
  // (drawn as soon as both endpoints exist, following drags live) so the
  // user can verify the box geometry while placing points.
  constructor(canvas, photo, { count, color = '#00e5a0', onChange = null, segments = [] }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.photo = photo;
    this.count = count;
    this.color = color;
    this.onChange = onChange;
    this.segments = segments;
    this.points = [];
    this.dragIndex = -1;
    this.dpr = window.devicePixelRatio || 1;

    this._onDown = (e) => this.handleDown(e);
    this._onMove = (e) => this.handleMove(e);
    this._onUp = (e) => this.handleUp(e);
    this._onResize = () => { this.layout(); this.render(); };

    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    window.addEventListener('resize', this._onResize);

    this.layout();
    this.render();
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
    window.removeEventListener('resize', this._onResize);
  }

  get complete() {
    return this.points.length === this.count;
  }

  undo() {
    if (this.points.length > 0) {
      this.points.pop();
      this.dragIndex = -1;
      this.render();
      if (this.onChange) this.onChange(this);
    }
  }

  resetPoints() {
    if (this.points.length === 0) return;
    this.points = [];
    this.dragIndex = -1;
    this.render();
    if (this.onChange) this.onChange(this);
  }

  // Contain-fit transform between photo pixels and canvas pixels.
  layout() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    const sx = this.canvas.width / this.photo.width;
    const sy = this.canvas.height / this.photo.height;
    this.scale = Math.min(sx, sy);
    this.offsetX = (this.canvas.width - this.photo.width * this.scale) / 2;
    this.offsetY = (this.canvas.height - this.photo.height * this.scale) / 2;
    // Pre-scale the 12 MP photo once to display size so pointer-move redraws
    // are cheap; the full-res photo is only sampled by the loupe.
    this.display = document.createElement('canvas');
    this.display.width = Math.max(1, Math.round(this.photo.width * this.scale));
    this.display.height = Math.max(1, Math.round(this.photo.height * this.scale));
    this.display.getContext('2d')
      .drawImage(this.photo, 0, 0, this.display.width, this.display.height);
  }

  imgToCanvas(p) {
    return { x: p.x * this.scale + this.offsetX, y: p.y * this.scale + this.offsetY };
  }

  canvasToImg(p) {
    return {
      x: Math.min(this.photo.width - 1, Math.max(0, (p.x - this.offsetX) / this.scale)),
      y: Math.min(this.photo.height - 1, Math.max(0, (p.y - this.offsetY) / this.scale)),
    };
  }

  eventPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * this.dpr,
      y: (e.clientY - rect.top) * this.dpr,
    };
  }

  handleDown(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const pos = this.eventPos(e);
    // While points remain to be placed, every tap places the next point —
    // grabbing would make a small on-screen reference (paper far away)
    // swallow the neighboring taps. Fine-tuning by grabbing happens once all
    // points are down; Undo covers mistakes before that.
    if (this.points.length < this.count) {
      this.points.push(this.canvasToImg(pos));
      this.dragIndex = this.points.length - 1;
    } else {
      const grabRadius = 34 * this.dpr;
      let nearest = -1;
      let nearestDist = Infinity;
      this.points.forEach((pt, i) => {
        const c = this.imgToCanvas(pt);
        const d = Math.hypot(c.x - pos.x, c.y - pos.y);
        if (d < grabRadius && d < nearestDist) { nearest = i; nearestDist = d; }
      });
      if (nearest < 0) return;
      this.dragIndex = nearest;
    }
    this.points[this.dragIndex] = this.canvasToImg(pos);
    this.render(pos);
  }

  handleMove(e) {
    if (this.dragIndex < 0) return;
    e.preventDefault();
    const pos = this.eventPos(e);
    this.points[this.dragIndex] = this.canvasToImg(pos);
    this.render(pos);
  }

  handleUp() {
    if (this.dragIndex < 0) return;
    this.dragIndex = -1;
    this.render();
    if (this.onChange) this.onChange(this);
  }

  // fingerPos: canvas-px finger position while dragging (shows the loupe).
  render(fingerPos = null) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.display, this.offsetX, this.offsetY);
    this.drawSegments();
    this.points.forEach((pt, i) => this.drawMarker(pt, this.color, i + 1));
    if (this.dragIndex >= 0 && fingerPos) {
      this.drawLoupe(this.points[this.dragIndex], fingerPos, this.color);
    }
  }

  // Wireframe lines between placed points; they follow the finger live
  // while a point is dragged, so the box geometry stays verifiable.
  drawSegments() {
    const { ctx, dpr } = this;
    for (const [i, j] of this.segments) {
      const a = this.points[i];
      const b = this.points[j];
      if (!a || !b) continue;
      const ca = this.imgToCanvas(a);
      const cb = this.imgToCanvas(b);
      ctx.save();
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([7 * dpr, 5 * dpr]);
      ctx.beginPath();
      ctx.moveTo(ca.x, ca.y);
      ctx.lineTo(cb.x, cb.y);
      ctx.stroke();
      ctx.restore();
    }
  }


  drawMarker(imgPt, color, label) {
    const { ctx } = this;
    const c = this.imgToCanvas(imgPt);
    const r = 11 * this.dpr;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * this.dpr;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c.x - r * 1.5, c.y); ctx.lineTo(c.x - r * 0.4, c.y);
    ctx.moveTo(c.x + r * 0.4, c.y); ctx.lineTo(c.x + r * 1.5, c.y);
    ctx.moveTo(c.x, c.y - r * 1.5); ctx.lineTo(c.x, c.y - r * 0.4);
    ctx.moveTo(c.x, c.y + r * 0.4); ctx.lineTo(c.x, c.y + r * 1.5);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = `bold ${12 * this.dpr}px -apple-system, sans-serif`;
    ctx.fillText(String(label), c.x + r * 1.2, c.y - r * 1.2);
    ctx.restore();
  }

  drawLoupe(imgPt, fingerPos, color = this.color) {
    const { ctx, canvas } = this;
    const R = 72 * this.dpr;                       // loupe radius
    // Canvas px per photo px inside the loupe; the floor of 4 keeps real
    // magnification even when the photo is displayed heavily downscaled
    // (e.g. the paper sheet is far away and small on screen).
    const zoom = Math.max(this.scale * 5, 4);
    // Place the loupe above the finger; flip below if it would leave the canvas.
    let cx = fingerPos.x;
    let cy = fingerPos.y - R - 46 * this.dpr;
    if (cy - R < 0) cy = fingerPos.y + R + 46 * this.dpr;
    cx = Math.min(canvas.width - R, Math.max(R, cx));

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    // Clamp the source rect to the photo bounds (Safari misrenders
    // out-of-bounds source rects) and map the clamped part proportionally
    // into the loupe, so corners near the photo edge still magnify correctly.
    const srcHalf = R / zoom;
    const sx0 = Math.max(0, imgPt.x - srcHalf);
    const sy0 = Math.max(0, imgPt.y - srcHalf);
    const sx1 = Math.min(this.photo.width, imgPt.x + srcHalf);
    const sy1 = Math.min(this.photo.height, imgPt.y + srcHalf);
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.drawImage(
        this.photo,
        sx0, sy0, sx1 - sx0, sy1 - sy0,
        cx - R + (sx0 - (imgPt.x - srcHalf)) * zoom,
        cy - R + (sy0 - (imgPt.y - srcHalf)) * zoom,
        (sx1 - sx0) * zoom, (sy1 - sy0) * zoom,
      );
    }
    // Crosshair marking the exact point.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3 * this.dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
  }
}
