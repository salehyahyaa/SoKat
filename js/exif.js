/**
 * Minimal JPEG EXIF reader — extracts FocalLengthIn35mmFilm (tag 0xA405).
 *
 * The 35mm-equivalent focal length converts directly to focal length in
 * pixels (f_px = longSidePx * f35 / 36), which makes single-photo height
 * recovery far more stable than estimating the focal from the paper quad.
 * Returns null on any structural surprise — the caller falls back.
 */
export function focal35FromJpeg(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xFFD8) return null; // not a JPEG

    // Walk JPEG segments looking for APP1/Exif.
    let off = 2;
    while (off + 4 <= view.byteLength) {
      if (view.getUint8(off) !== 0xFF) return null;
      const marker = view.getUint8(off + 1);
      const size = view.getUint16(off + 2);
      if (marker === 0xE1
          && view.getUint32(off + 4) === 0x45786966 // "Exif"
          && view.getUint16(off + 8) === 0x0000) {
        return readTiff(view, off + 10);
      }
      if (marker === 0xDA) return null; // start of scan — no EXIF ahead
      off += 2 + size;
    }
    return null;
  } catch {
    return null;
  }
}

function readTiff(view, tiff) {
  const le = view.getUint16(tiff) === 0x4949; // "II" little-endian
  const u16 = (o) => view.getUint16(o, le);
  const u32 = (o) => view.getUint32(o, le);
  if (u16(tiff + 2) !== 42) return null;

  // IFD0: find the ExifIFD pointer (0x8769).
  const ifd0 = tiff + u32(tiff + 4);
  const exifPtr = findTag(view, tiff, ifd0, 0x8769, u16, u32);
  if (exifPtr == null) return null;

  // ExifIFD: FocalLengthIn35mmFilm (0xA405, SHORT).
  const f35 = findTag(view, tiff, tiff + exifPtr, 0xA405, u16, u32);
  return f35 && f35 > 0 ? f35 : null;
}

// Scan one IFD for a tag; returns its inline numeric value (SHORT/LONG).
function findTag(view, tiff, ifd, wanted, u16, u32) {
  if (ifd + 2 > view.byteLength) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > view.byteLength) return null;
    if (u16(e) !== wanted) continue;
    const type = u16(e + 2);
    if (type === 3) return u16(e + 8); // SHORT
    if (type === 4) return u32(e + 8); // LONG
    return null;
  }
  return null;
}
