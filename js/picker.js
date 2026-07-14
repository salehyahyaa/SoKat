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
  /**
   * @param {HTMLCanvasElement} canvas   display canvas (CSS-sized by layout)
   * @param {HTMLCanvasElement} photo    source photo at full resolution
   * @param {object} opts
   * @param {number} opts.count          number of points to collect
   * @param {string} opts.color          marker color
   * @param {{points:{x:number,y:number}[], color:string}[]} [opts.ghosts]
   *        previously placed point sets to show for context (not editable)
   * @param {(picker: CornerPicker) => void} [opts.onChange]
   */
  constructor(canvas, photo, { count, color = '#00e5a0', ghosts = [], onChange = null }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.photo = photo;
    this.count = count;
    this.color = color;
    this.ghosts = ghosts;
    this.onChange = onChange;
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

  /** Compute the contain-fit transform between photo pixels and canvas pixels. */
  layout() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    const sx = this.canvas.width / this.photo.width;
    const sy = this.canvas.height / this.photo.height;
    this.scale = Math.min(sx, sy);
    this.offsetX = (this.canvas.width - this.photo.width * this.scale) / 2;
    this.offsetY = (this.canvas.height - this.photo.height * this.scale) / 2;
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
    const grabRadius = 34 * this.dpr;
    let nearest = -1;
    let nearestDist = Infinity;
    this.points.forEach((pt, i) => {
      const c = this.imgToCanvas(pt);
      const d = Math.hypot(c.x - pos.x, c.y - pos.y);
      if (d < grabRadius && d < nearestDist) { nearest = i; nearestDist = d; }
    });
    if (nearest >= 0) {
      this.dragIndex = nearest;
    } else if (this.points.length < this.count) {
      this.points.push(this.canvasToImg(pos));
      this.dragIndex = this.points.length - 1;
    } else {
      return;
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

  /** @param {{x:number,y:number}|null} fingerPos canvas-px finger position while dragging */
  render(fingerPos = null) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      this.photo,
      this.offsetX, this.offsetY,
      this.photo.width * this.scale, this.photo.height * this.scale,
    );
    for (const ghost of this.ghosts) {
      ghost.points.forEach((pt, i) => this.drawMarker(pt, ghost.color, i + 1, true));
    }
    this.points.forEach((pt, i) => this.drawMarker(pt, this.color, i + 1, false));
    if (this.dragIndex >= 0 && fingerPos) {
      this.drawLoupe(this.points[this.dragIndex], fingerPos);
    }
  }

  drawMarker(imgPt, color, label, ghost) {
    const { ctx } = this;
    const c = this.imgToCanvas(imgPt);
    const r = 11 * this.dpr;
    ctx.save();
    ctx.globalAlpha = ghost ? 0.45 : 1;
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

  drawLoupe(imgPt, fingerPos) {
    const { ctx, canvas } = this;
    const R = 72 * this.dpr;                       // loupe radius
    const zoom = Math.max(this.scale * 5, 1.6);    // canvas px per photo px inside loupe
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
    const srcHalf = R / zoom;
    ctx.drawImage(
      this.photo,
      imgPt.x - srcHalf, imgPt.y - srcHalf, srcHalf * 2, srcHalf * 2,
      cx - R, cy - R, R * 2, R * 2,
    );
    // Crosshair marking the exact point.
    ctx.strokeStyle = this.color;
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
