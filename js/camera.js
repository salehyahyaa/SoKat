/**
 * CameraCapture — opens the iPhone's native camera from Safari via a hidden
 * `<input type="file" capture="environment">` and returns the photo as a
 * full-resolution canvas.
 *
 * This path is chosen deliberately over getUserMedia: it needs no permission
 * prompt, works over plain HTTP, and captures at full sensor resolution
 * (12 MP) instead of video resolution — resolution is accuracy here.
 */
export class CameraCapture {
  /** @param {HTMLInputElement} inputEl hidden file input with capture attribute */
  constructor(inputEl) {
    this.input = inputEl;
  }

  /**
   * Trigger the camera and resolve with the photo drawn on a canvas
   * (EXIF orientation applied). Resolves null if the user cancels.
   * Must be called from a user-gesture handler (button tap).
   * @returns {Promise<HTMLCanvasElement|null>}
   */
  capture() {
    return new Promise((resolve, reject) => {
      const onChange = async () => {
        cleanup();
        const file = this.input.files && this.input.files[0];
        this.input.value = '';
        if (!file) return resolve(null);
        try {
          resolve(await CameraCapture.fileToCanvas(file));
        } catch (err) {
          reject(err);
        }
      };
      // iOS fires no event on cancel; if focus returns with no file, resolve null.
      const onFocusBack = () => {
        setTimeout(() => {
          if (!this.input.files || this.input.files.length === 0) {
            cleanup();
            resolve(null);
          }
        }, 500);
      };
      const cleanup = () => {
        this.input.removeEventListener('change', onChange);
        window.removeEventListener('focus', onFocusBack);
      };
      this.input.addEventListener('change', onChange, { once: true });
      window.addEventListener('focus', onFocusBack, { once: true });
      this.input.click();
    });
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
