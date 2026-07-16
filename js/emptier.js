/**
 * ClosetEmptier — digitally removes the closet's contents from the captured
 * photo. The four back-wall corners the user already tapped define the closet
 * interior in the image; everything inside that quad (clothes, rods, boxes)
 * is replaced with a clean wall-toned surface — lit with a vertical light
 * falloff, corner shading and a floor shadow so it reads as a real empty
 * closet, not a flat patch. Runs fully on-device on a downscaled copy.
 *
 * BeforeAfterView shows the result as a swipeable before/after comparison.
 */

const MAX_DIM = 1600; // display copies; full-res isn't needed on a phone screen

// Build matched {original, emptied} canvases from the back-wall photo and the
// closet-corner quad (photo pixel coordinates, order TL TR BR BL).
export function buildEmptiedViews(photo, quad, wallColor = '#b8b0a4') {
  const scale = Math.min(1, MAX_DIM / Math.max(photo.width, photo.height));
  const w = Math.max(1, Math.round(photo.width * scale));
  const h = Math.max(1, Math.round(photo.height * scale));

  const original = document.createElement('canvas');
  original.width = w; original.height = h;
  original.getContext('2d').drawImage(photo, 0, 0, w, h);

  const emptied = document.createElement('canvas');
  emptied.width = w; emptied.height = h;
  const ctx = emptied.getContext('2d');
  ctx.drawImage(original, 0, 0);

  const q = quad.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  paintEmptyInterior(ctx, q, parseColor(wallColor), Math.max(w, h));

  return { original, emptied };
}

function quadPath(ctx, q) {
  ctx.beginPath();
  ctx.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
  ctx.closePath();
}

function paintEmptyInterior(ctx, q, rgb, dim) {
  const minX = Math.min(...q.map((p) => p.x));
  const maxX = Math.max(...q.map((p) => p.x));
  const minY = Math.min(...q.map((p) => p.y));
  const maxY = Math.max(...q.map((p) => p.y));

  ctx.save();
  quadPath(ctx, q);
  ctx.clip();

  // Base wall: brighter where ceiling light lands, darker toward the floor.
  const base = ctx.createLinearGradient(0, minY, 0, maxY);
  base.addColorStop(0, shade(rgb, 1.08));
  base.addColorStop(0.55, shade(rgb, 0.99));
  base.addColorStop(1, shade(rgb, 0.86));
  ctx.fillStyle = base;
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);

  // Side-wall falloff: interiors are darker toward the vertical corners.
  const sides = ctx.createLinearGradient(minX, 0, maxX, 0);
  sides.addColorStop(0, 'rgba(0,0,0,0.22)');
  sides.addColorStop(0.18, 'rgba(0,0,0,0)');
  sides.addColorStop(0.82, 'rgba(0,0,0,0)');
  sides.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = sides;
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);

  // Floor contact shadow along the bottom edge.
  const floor = ctx.createLinearGradient(0, maxY - (maxY - minY) * 0.16, 0, maxY);
  floor.addColorStop(0, 'rgba(0,0,0,0)');
  floor.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = floor;
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);

  // Fine noise so the synthetic wall matches photo grain instead of looking
  // like a flat sticker.
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = noisePattern(ctx);
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
  ctx.globalAlpha = 1;

  // Soft inner shadow hugging the quad boundary (half the stroke is clipped
  // away, leaving a feathered edge inside).
  quadPath(ctx, q);
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.lineWidth = dim * 0.02;
  ctx.filter = 'blur(' + (dim * 0.006).toFixed(1) + 'px)';
  ctx.stroke();
  ctx.filter = 'none';
  ctx.restore();
}

function noisePattern(ctx) {
  const tile = document.createElement('canvas');
  tile.width = 96; tile.height = 96;
  const tctx = tile.getContext('2d');
  const img = tctx.createImageData(96, 96);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(Math.random() * 255);
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  return ctx.createPattern(tile, 'repeat');
}

export function parseColor(css) {
  const hex = css.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = css.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [184, 176, 164];
}

export function shade([r, g, b], light) {
  const f = (c) => Math.round(Math.min(255, c * light));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/**
 * BeforeAfterView — swipeable comparison of the original photo and the
 * emptied one. Drag anywhere: left of the divider shows the closet as
 * photographed, right of it shows the contents digitally removed.
 */
export class BeforeAfterView {
  constructor(canvas, { original, emptied }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.original = original;
    this.emptied = emptied;
    this.pos = 0.5; // divider, fraction of image width
    this.dpr = window.devicePixelRatio || 1;
    this.dragging = false;

    this._onDown = (e) => { this.dragging = true; this.canvas.setPointerCapture(e.pointerId); this.moveTo(e); };
    this._onMove = (e) => { if (this.dragging) this.moveTo(e); };
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
    const s = Math.min(
      this.canvas.width / this.original.width,
      this.canvas.height / this.original.height,
    );
    this.drawW = this.original.width * s;
    this.drawH = this.original.height * s;
    this.drawX = (this.canvas.width - this.drawW) / 2;
    this.drawY = (this.canvas.height - this.drawH) / 2;
  }

  moveTo(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * this.dpr;
    this.pos = Math.min(1, Math.max(0, (x - this.drawX) / this.drawW));
    this.render();
  }

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.original, this.drawX, this.drawY, this.drawW, this.drawH);

    // Emptied side, clipped to the right of the divider.
    const split = this.drawX + this.drawW * this.pos;
    ctx.save();
    ctx.beginPath();
    ctx.rect(split, this.drawY, this.drawX + this.drawW - split, this.drawH);
    ctx.clip();
    ctx.drawImage(this.emptied, this.drawX, this.drawY, this.drawW, this.drawH);
    ctx.restore();

    this.drawDivider(split);
    this.drawTag('WITH CONTENTS', this.drawX + 8 * this.dpr, false);
    this.drawTag('EMPTIED', this.drawX + this.drawW - 8 * this.dpr, true);
  }

  drawDivider(x) {
    const { ctx, dpr } = this;
    const yTop = this.drawY;
    const yBot = this.drawY + this.drawH;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, yTop); ctx.lineTo(x, yBot);
    ctx.stroke();

    const cy = yTop + this.drawH / 2;
    const r = 17 * dpr;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0a0c10';
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath(); // ◄ ► arrows
    ctx.moveTo(x - r * 0.25, cy - r * 0.35); ctx.lineTo(x - r * 0.55, cy); ctx.lineTo(x - r * 0.25, cy + r * 0.35);
    ctx.moveTo(x + r * 0.25, cy - r * 0.35); ctx.lineTo(x + r * 0.55, cy); ctx.lineTo(x + r * 0.25, cy + r * 0.35);
    ctx.stroke();
  }

  drawTag(text, x, alignRight) {
    const { ctx, dpr } = this;
    ctx.save();
    ctx.font = `bold ${10 * dpr}px -apple-system, sans-serif`;
    const tw = ctx.measureText(text).width;
    const pad = 6 * dpr;
    const bx = alignRight ? x - tw - pad * 2 : x;
    const by = this.drawY + 8 * dpr;
    ctx.fillStyle = 'rgba(10,12,16,0.72)';
    ctx.fillRect(bx, by, tw + pad * 2, 20 * dpr);
    ctx.fillStyle = alignRight ? '#00e5a0' : '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + pad, by + 10 * dpr);
    ctx.restore();
  }
}
