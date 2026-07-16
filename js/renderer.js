/**
 * EmptyClosetRenderer — draws the "digitally emptied" closet: an interactive
 * 3D interior (back wall, side walls, floor, ceiling) at the measured
 * dimensions, with carpenter-fraction dimension callouts. Drag to orbit.
 *
 * Own perspective projection on Canvas 2D — one box interior does not justify
 * a 3D engine dependency.
 */
export class EmptyClosetRenderer {
  // wallColor: CSS color sampled from the real closet wall.
  constructor(canvas, model, { wallColor = '#b8b0a4' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = model;
    this.wallRGB = parseColor(wallColor);
    this.yaw = -0.35;
    this.pitch = -0.12;
    this.dpr = window.devicePixelRatio || 1;
    this.dragging = false;
    this.last = null;

    this._onDown = (e) => { this.dragging = true; this.last = { x: e.clientX, y: e.clientY }; this.canvas.setPointerCapture(e.pointerId); };
    this._onMove = (e) => {
      if (!this.dragging) return;
      this.yaw = clamp(this.yaw + (e.clientX - this.last.x) * 0.008, -0.85, 0.85);
      this.pitch = clamp(this.pitch + (e.clientY - this.last.y) * 0.006, -0.5, 0.35);
      this.last = { x: e.clientX, y: e.clientY };
      this.render();
    };
    this._onUp = () => { this.dragging = false; };
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

  layout() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
  }

  // Rotate a box-space point by yaw/pitch and project to canvas pixels.
  project(p) {
    const cy = Math.cos(this.yaw); const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch); const sp = Math.sin(this.pitch);
    // Yaw around Y, then pitch around X.
    const x1 = p.x * cy + p.z * sy;
    const z1 = -p.x * sy + p.z * cy;
    const y2 = p.y * cp - z1 * sp;
    const z2 = p.y * sp + z1 * cp;

    const m = this.model;
    const size = Math.max(m.width, m.height);
    const camDist = m.depth / 2 + size * 1.35;
    const f = Math.min(this.canvas.width, this.canvas.height) * 1.15;
    const zc = camDist - z2;
    return {
      x: this.canvas.width / 2 + (f * x1) / zc,
      y: this.canvas.height / 2 - (f * y2) / zc,
      depth: zc,
    };
  }

  render() {
    const { ctx, canvas, model: m } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const W = m.width / 2; const H = m.height / 2; const D = m.depth / 2;
    // Box space: x right, y up, z toward viewer; front opening at z = +D.
    const faces = [
      { name: 'back', pts: [v(-W, H, -D), v(W, H, -D), v(W, -H, -D), v(-W, -H, -D)], normal: [0, 0, 1], light: 1.0 },
      { name: 'left', pts: [v(-W, H, -D), v(-W, H, D), v(-W, -H, D), v(-W, -H, -D)], normal: [1, 0, 0], light: 0.8 },
      { name: 'right', pts: [v(W, H, -D), v(W, H, D), v(W, -H, D), v(W, -H, -D)], normal: [-1, 0, 0], light: 0.8 },
      { name: 'floor', pts: [v(-W, -H, -D), v(W, -H, -D), v(W, -H, D), v(-W, -H, D)], normal: [0, 1, 0], light: 0.62 },
      { name: 'ceiling', pts: [v(-W, H, -D), v(W, H, -D), v(W, H, D), v(-W, H, D)], normal: [0, -1, 0], light: 1.12 },
    ];

    const drawable = [];
    for (const face of faces) {
      const proj = face.pts.map((p) => this.project(p));
      // A face is visible when its interior-facing normal points toward the camera.
      const n = this.rotateNormal(face.normal);
      const center = face.pts.reduce((a, p) => v(a.x + p.x / 4, a.y + p.y / 4, a.z + p.z / 4), v(0, 0, 0));
      const rc = this.rotatePoint(center);
      const camDist = m.depth / 2 + Math.max(m.width, m.height) * 1.35;
      const toCam = [-rc.x, -rc.y, camDist - rc.z];
      const dot = n[0] * toCam[0] + n[1] * toCam[1] + n[2] * toCam[2];
      if (dot <= 0) continue;
      const meanDepth = proj.reduce((a, p) => a + p.depth, 0) / 4;
      drawable.push({ face, proj, meanDepth });
    }
    drawable.sort((a, b) => b.meanDepth - a.meanDepth);

    for (const { face, proj } of drawable) {
      ctx.beginPath();
      proj.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = shade(this.wallRGB, face.light);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.stroke();
    }

    // Front opening outline.
    const front = [v(-W, H, D), v(W, H, D), v(W, -H, D), v(-W, -H, D)].map((p) => this.project(p));
    ctx.beginPath();
    front.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2 * this.dpr;
    ctx.stroke();

    this.drawDimension(v(-W, -H, D), v(W, -H, D), `W ${m.widthText}`, 0, 26);
    this.drawDimension(v(-W, -H, D), v(-W, H, D), `H ${m.heightText}`, -30, 0);
    this.drawDimension(v(W, -H, D), v(W, -H, -D), `D ${m.depthText}`, 30, 14);
  }

  rotatePoint(p) {
    const cy = Math.cos(this.yaw); const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch); const sp = Math.sin(this.pitch);
    const x1 = p.x * cy + p.z * sy;
    const z1 = -p.x * sy + p.z * cy;
    return v(x1, p.y * cp - z1 * sp, p.y * sp + z1 * cp);
  }

  rotateNormal(n) {
    const r = this.rotatePoint(v(n[0], n[1], n[2]));
    return [r.x, r.y, r.z];
  }

  drawDimension(a, b, label, dx, dy) {
    const { ctx } = this;
    const pa = this.project(a);
    const pb = this.project(b);
    const ox = dx * this.dpr; const oy = dy * this.dpr;
    ctx.save();
    ctx.strokeStyle = '#00e5a0';
    ctx.fillStyle = '#00e5a0';
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(pa.x + ox, pa.y + oy);
    ctx.lineTo(pb.x + ox, pb.y + oy);
    ctx.stroke();
    for (const p of [pa, pb]) {
      ctx.beginPath();
      ctx.arc(p.x + ox, p.y + oy, 3 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    const mx = (pa.x + pb.x) / 2 + ox;
    const my = (pa.y + pb.y) / 2 + oy;
    ctx.font = `bold ${13 * this.dpr}px -apple-system, sans-serif`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,12,16,0.85)';
    roundRect(ctx, mx - tw / 2 - 6 * this.dpr, my - 11 * this.dpr, tw + 12 * this.dpr, 21 * this.dpr, 5 * this.dpr);
    ctx.fill();
    ctx.fillStyle = '#00e5a0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx, my);
    ctx.restore();
  }
}

function v(x, y, z) { return { x, y, z }; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

function parseColor(css) {
  const m = css.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = css.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [184, 176, 164];
}

function shade([r, g, b], light) {
  const f = (c) => Math.round(Math.min(255, c * light));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
