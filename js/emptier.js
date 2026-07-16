/**
 * Photo editing views for the results screen.
 *
 * buildEmptiedViews produces matched {original, emptied} display copies of
 * the photo. The "emptied" copy starts identical — nothing synthetic is
 * painted — and the user removes objects with the erase brush: a drag
 * selects the object, and on release the region is inpainted by diffusing
 * the surrounding real pixels inward, so the fill blends with the photo.
 */

const MAX_DIM = 1600; // display copies; full-res isn't needed on a phone screen

export function buildEmptiedViews(photo) {
  const scale = Math.min(1, MAX_DIM / Math.max(photo.width, photo.height));
  const w = Math.max(1, Math.round(photo.width * scale));
  const h = Math.max(1, Math.round(photo.height * scale));

  const original = document.createElement('canvas');
  original.width = w; original.height = h;
  original.getContext('2d').drawImage(photo, 0, 0, w, h);

  const emptied = cloneCanvas(original);
  return { original, emptied };
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

/**
 * BeforeAfterView — swipeable comparison of the original photo and the
 * emptied one. Drag anywhere: left of the divider shows the space as
 * photographed, right of it shows the contents digitally removed.
 *
 * Erase mode: dragging becomes a brush that wipes any other object out of
 * the emptied photo — each stamp is inpainted with the color sampled from a
 * ring around it, so the fill blends with its surroundings. reset() restores
 * the freshly-emptied state.
 */
export class BeforeAfterView {
  constructor(canvas, { original, emptied }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.original = original;
    this.emptied = emptied;
    this.pristine = cloneCanvas(emptied); // for reset()
    this.pos = 0.5; // divider, fraction of image width
    this.dpr = window.devicePixelRatio || 1;
    this.dragging = false;
    this.eraseMode = false;
    this.stroke = []; // image-coord points of the erase stroke being drawn

    this._onDown = (e) => { this.dragging = true; this.canvas.setPointerCapture(e.pointerId); this.moveTo(e); };
    this._onMove = (e) => { if (this.dragging) this.moveTo(e); };
    this._onUp = () => {
      this.dragging = false;
      if (this.eraseMode && this.stroke.length) {
        this.applyErase(this.stroke);
        this.stroke = [];
        this.render();
      }
    };
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
    if (this.eraseMode) {
      const y = (e.clientY - rect.top) * this.dpr;
      this.stroke.push({
        x: ((x - this.drawX) / this.drawW) * this.emptied.width,
        y: ((y - this.drawY) / this.drawH) * this.emptied.height,
      });
    } else {
      this.pos = Math.min(1, Math.max(0, (x - this.drawX) / this.drawW));
    }
    this.render();
  }

  // ------------------------------------------------------------- erase mode

  setEraseMode(on) {
    this.eraseMode = on;
    if (on) this.pos = 0; // show the emptied image full-width while erasing
    this.render();
  }

  reset() {
    this.emptied.getContext('2d').drawImage(this.pristine, 0, 0);
    this.render();
  }

  brushRadius() {
    return Math.max(14, Math.max(this.emptied.width, this.emptied.height) * 0.045);
  }

  // Real object removal: rasterize the stroke into a mask, then fill the
  // masked region by diffusing the surrounding photo pixels inward (Jacobi
  // iterations on a downscaled patch), composite back through a feathered
  // mask and re-grain — the object disappears into its surroundings.
  applyErase(stroke) {
    const img = this.emptied;
    const R = this.brushRadius();
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const p of stroke) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    minX = Math.max(0, Math.floor(minX - R * 2));
    minY = Math.max(0, Math.floor(minY - R * 2));
    maxX = Math.min(img.width, Math.ceil(maxX + R * 2));
    maxY = Math.min(img.height, Math.ceil(maxY + R * 2));
    const bw = maxX - minX; const bh = maxY - minY;
    if (bw < 4 || bh < 4) return;

    // Work at reduced resolution — diffusion converges fast and the smooth
    // result upscales cleanly.
    const S = Math.min(1, 200 / Math.max(bw, bh));
    const sw = Math.max(4, Math.round(bw * S));
    const sh = Math.max(4, Math.round(bh * S));

    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    const sctx = small.getContext('2d');
    sctx.drawImage(img, minX, minY, bw, bh, 0, 0, sw, sh);

    // Feathered stroke mask (soft-edged circles along the stroke).
    const maskC = document.createElement('canvas');
    maskC.width = sw; maskC.height = sh;
    const mctx = maskC.getContext('2d');
    for (const p of stroke) {
      const cx = (p.x - minX) * S; const cy = (p.y - minY) * S; const r = R * S;
      const g = mctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.75, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      mctx.fillStyle = g;
      mctx.beginPath(); mctx.arc(cx, cy, r, 0, Math.PI * 2); mctx.fill();
    }

    const cd = sctx.getImageData(0, 0, sw, sh);
    const md = mctx.getImageData(0, 0, sw, sh);
    const n = sw * sh;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = md.data[i * 4 + 3] > 100 ? 1 : 0;

    // Seed masked pixels with the average of the unmasked surroundings so
    // diffusion starts near the answer.
    let ar = 0; let ag = 0; let ab = 0; let an = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) { ar += cd.data[i * 4]; ag += cd.data[i * 4 + 1]; ab += cd.data[i * 4 + 2]; an++; }
    }
    if (an === 0) return;
    ar /= an; ag /= an; ab /= an;
    let a = new Float32Array(n * 3);
    let b = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      a[i * 3] = mask[i] ? ar : cd.data[i * 4];
      a[i * 3 + 1] = mask[i] ? ag : cd.data[i * 4 + 1];
      a[i * 3 + 2] = mask[i] ? ab : cd.data[i * 4 + 2];
    }
    b.set(a);
    for (let it = 0; it < 60; it++) {
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const i = y * sw + x;
          if (!mask[i]) continue;
          const L = x > 0 ? i - 1 : i;
          const Rt = x < sw - 1 ? i + 1 : i;
          const U = y > 0 ? i - sw : i;
          const D = y < sh - 1 ? i + sw : i;
          b[i * 3] = (a[L * 3] + a[Rt * 3] + a[U * 3] + a[D * 3]) / 4;
          b[i * 3 + 1] = (a[L * 3 + 1] + a[Rt * 3 + 1] + a[U * 3 + 1] + a[D * 3 + 1]) / 4;
          b[i * 3 + 2] = (a[L * 3 + 2] + a[Rt * 3 + 2] + a[U * 3 + 2] + a[D * 3 + 2]) / 4;
        }
      }
      const t = a; a = b; b = t;
    }
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      cd.data[i * 4] = a[i * 3];
      cd.data[i * 4 + 1] = a[i * 3 + 1];
      cd.data[i * 4 + 2] = a[i * 3 + 2];
    }

    // Exemplar pass: re-texture the smooth diffusion base by stamping real
    // patches copied from the unmasked surroundings — texture continues
    // through the hole instead of turning into a smudge.
    exemplarFill(cd.data, mask, sw, sh);

    sctx.putImageData(cd, 0, 0);

    // Keep only the (feathered) masked part of the fill, re-grain it so it
    // matches photo texture, then composite back at full resolution.
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(maskC, 0, 0);
    sctx.globalCompositeOperation = 'source-atop';
    sctx.globalAlpha = 0.05;
    sctx.fillStyle = noisePattern(sctx);
    sctx.fillRect(0, 0, sw, sh);
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = 'source-over';

    const ictx = img.getContext('2d');
    ictx.imageSmoothingEnabled = true;
    ictx.imageSmoothingQuality = 'high';
    ictx.drawImage(small, 0, 0, sw, sh, minX, minY, bw, bh);
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

    if (this.eraseMode) {
      // Live preview of the selection being painted.
      if (this.stroke.length) {
        const r = this.brushRadius() * (this.drawW / this.emptied.width);
        this.ctx.save();
        this.ctx.fillStyle = 'rgba(0, 229, 160, 0.30)';
        for (const p of this.stroke) {
          const cx = this.drawX + (p.x / this.emptied.width) * this.drawW;
          const cy = this.drawY + (p.y / this.emptied.height) * this.drawH;
          this.ctx.beginPath();
          this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
          this.ctx.fill();
        }
        this.ctx.restore();
      }
      this.drawTag('ERASE — paint over an object, lift to remove it', this.drawX + 8 * this.dpr, false);
    } else {
      this.drawDivider(split);
      this.drawTag('ORIGINAL', this.drawX + 8 * this.dpr, false);
      this.drawTag('EDITED', this.drawX + this.drawW - 8 * this.dpr, true);
    }
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

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// Exemplar-based texture synthesis over an inpaint mask (data: RGBA bytes).
// Grid points across the mask are filled boundary-first; each takes the
// best-matching (SSD against already-known context) of K randomly sampled
// patches from the unmasked surroundings, stamped with a feathered edge.
// Classical content-aware-fill: real pixels, so grain and texture continue.
function exemplarFill(data, mask, sw, sh) {
  const n = sw * sh;
  const src = new Uint8ClampedArray(data); // patch source: pre-stamp snapshot

  // BFS distance-to-known so the fill grows inward from the boundary.
  const dist = new Int32Array(n).fill(-1);
  let queue = [];
  for (let i = 0; i < n; i++) if (!mask[i]) { dist[i] = 0; queue.push(i); }
  if (queue.length === 0 || queue.length === n) return;
  while (queue.length) {
    const next = [];
    for (const i of queue) {
      const x = i % sw; const y = (i / sw) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < sw - 1 ? i + 1 : -1, y > 0 ? i - sw : -1, y < sh - 1 ? i + sw : -1]) {
        if (j >= 0 && dist[j] < 0) { dist[j] = dist[i] + 1; next.push(j); }
      }
    }
    queue = next;
  }

  const PR = Math.max(5, Math.round(Math.min(sw, sh) / 12)); // patch radius
  const STEP = Math.max(2, Math.round(PR * 0.75));
  const K = 12;

  // Source candidates: unmasked centers with a fully in-bounds patch.
  const validSource = (i) => {
    const x = i % sw; const y = (i / sw) | 0;
    return x >= PR && x < sw - PR && y >= PR && y < sh - PR
      && !mask[i] && !mask[i - PR] && !mask[i + PR] && !mask[i - PR * sw] && !mask[i + PR * sw];
  };
  const sources = [];
  for (let y = PR; y < sh - PR; y += 2) {
    for (let x = PR; x < sw - PR; x += 2) {
      const i = y * sw + x;
      if (validSource(i)) sources.push(i);
    }
  }
  if (sources.length === 0) return;

  // Grid targets over the mask, nearest-to-boundary first.
  const targets = [];
  for (let y = 0; y < sh; y += STEP) {
    for (let x = 0; x < sw; x += STEP) {
      const i = y * sw + x;
      if (mask[i]) targets.push(i);
    }
  }
  targets.sort((p, q) => dist[p] - dist[q]);

  const known = new Uint8Array(n); // original known context + stamped areas
  for (let i = 0; i < n; i++) known[i] = mask[i] ? 0 : 1;

  // PatchMatch-style propagation: neighbors reuse each other's source
  // offsets, so periodic structure (planks, tiles, stripes) continues in
  // phase through the hole instead of averaging into a blur. Three sweeps:
  // boundary-first to seed, then scanline and reverse-scanline to let good
  // offsets flow across the whole hole.
  const offsets = new Map(); // "gx,gy" -> chosen (source - target) offset
  const sweeps = [
    targets,
    [...targets].sort((p, q) => p - q),
    [...targets].sort((p, q) => q - p),
  ];
  for (const sweep of sweeps) for (const t of sweep) {
    const tx = t % sw; const ty = (t / sw) | 0;
    const gx = (tx / STEP) | 0; const gy = (ty / STEP) | 0;
    const candidates = [];
    for (const [nx, ny] of [[gx - 1, gy], [gx + 1, gy], [gx, gy - 1], [gx, gy + 1]]) {
      const off = offsets.get(nx + ',' + ny);
      if (off != null) {
        const c = t + off;
        if (c >= 0 && c < n && validSource(c)) candidates.push(c);
      }
    }
    for (let k = 0; k < K; k++) candidates.push(sources[(Math.random() * sources.length) | 0]);

    let best = -1; let bestScore = Infinity;
    for (const c of candidates) {
      const cx = c % sw; const cy = (c / sw) | 0;
      let score = 0; let cnt = 0;
      for (let dy = -PR; dy <= PR; dy += 2) {
        const y2 = ty + dy;
        if (y2 < 0 || y2 >= sh) continue;
        for (let dx = -PR; dx <= PR; dx += 2) {
          const x2 = tx + dx;
          if (x2 < 0 || x2 >= sw) continue;
          const ti = y2 * sw + x2;
          if (!known[ti]) continue;
          const si = (cy + dy) * sw + (cx + dx);
          const dr = data[ti * 4] - src[si * 4];
          const dg = data[ti * 4 + 1] - src[si * 4 + 1];
          const db = data[ti * 4 + 2] - src[si * 4 + 2];
          score += dr * dr + dg * dg + db * db;
          cnt++;
        }
      }
      score = cnt ? score / cnt : Math.random() * 1e6;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (best < 0) continue;
    offsets.set(gx + ',' + gy, best - t);
    const bx = best % sw; const by = (best / sw) | 0;
    for (let dy = -PR; dy <= PR; dy++) {
      const y2 = ty + dy;
      if (y2 < 0 || y2 >= sh) continue;
      for (let dx = -PR; dx <= PR; dx++) {
        const x2 = tx + dx;
        if (x2 < 0 || x2 >= sw) continue;
        const ti = y2 * sw + x2;
        if (!mask[ti]) continue; // never touch real photo pixels
        const r2 = (dx * dx + dy * dy) / (PR * PR);
        if (r2 > 1) continue;
        // full copy in the patch core; feather only the rim so texture stays crisp
        const rim = r2 < 0.55 ? 1 : (1 - r2) / 0.45;
        const w = known[ti] ? rim * 0.95 : 1;
        const si = ((by + dy) * sw + (bx + dx)) * 4;
        data[ti * 4] = data[ti * 4] * (1 - w) + src[si] * w;
        data[ti * 4 + 1] = data[ti * 4 + 1] * (1 - w) + src[si + 1] * w;
        data[ti * 4 + 2] = data[ti * 4 + 2] * (1 - w) + src[si + 2] * w;
        known[ti] = 1;
      }
    }
  }
}
