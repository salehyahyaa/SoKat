/**
 * CameraCapture — opens the iPhone's native camera from Safari via a hidden
 * `<input type="file" capture="environment">` and delivers the photo as a
 * full-resolution canvas.
 *
 * This path is chosen deliberately over getUserMedia: it needs no permission
 * prompt, works over plain HTTP, and captures at full sensor resolution
 * (12 MP) instead of video resolution — resolution is accuracy here.
 *
 * Callback-based by design: iOS fires NO event when the user cancels the
 * camera sheet, so a promise returned per request() could hang forever.
 * Instead one persistent change listener delivers photos to whoever is
 * subscribed; a cancelled camera simply delivers nothing, and the caller's
 * "Open Camera" button stays armed for another try.
 */
export class CameraCapture {
  /** @param {HTMLInputElement} inputEl hidden file input with capture attribute */
  constructor(inputEl) {
    this.input = inputEl;
    /** @type {((photo: HTMLCanvasElement) => void)|null} */
    this.onPhoto = null;
    /** @type {((err: Error) => void)|null} */
    this.onError = null;
    this.input.addEventListener('change', async () => {
      const file = this.input.files && this.input.files[0];
      this.input.value = '';
      if (!file) return;
      try {
        const photo = await CameraCapture.fileToCanvas(file);
        if (this.onPhoto) this.onPhoto(photo);
      } catch (err) {
        if (this.onError) this.onError(err);
      }
    });
  }

  /** Open the camera. Must be called from a user-gesture handler. */
  request() {
    this.input.click();
  }

  /** Detach current subscribers (call when leaving a capture screen). */
  unsubscribe() {
    this.onPhoto = null;
    this.onError = null;
  }

  /**
   * Decode an image file to a canvas. Browsers apply EXIF orientation when
   * decoding into an <img>, so drawing that image yields upright pixels.
   * Downscales only if the image exceeds Safari's canvas area limit.
   * @param {File} file
   * @returns {Promise<HTMLCanvasElement>}
   */
  static async fileToCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = () => rej(new Error('Could not decode the photo'));
        el.src = url;
      });
      const MAX_PIXELS = 16000000; // iOS Safari canvas limit ~16.7 MP
      let { naturalWidth: w, naturalHeight: h } = img;
      const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
