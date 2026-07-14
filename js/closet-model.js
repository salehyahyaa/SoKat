/**
 * ClosetModel — value object holding the measured closet dimensions plus
 * consistency diagnostics, with 1/16"-fraction formatting.
 *
 * Width and height are each measured twice (top & bottom edge, left & right
 * edge). The averages are the reported dimensions; the spread between the two
 * readings is a built-in consistency check surfaced to the user.
 */
export class ClosetModel {
  /**
   * @param {object} d
   * @param {number} d.widthTop    inches
   * @param {number} d.widthBottom inches
   * @param {number} d.heightLeft  inches
   * @param {number} d.heightRight inches
   * @param {number} d.depth       inches
   */
  constructor({ widthTop, widthBottom, heightLeft, heightRight, depth }) {
    this.widthTop = widthTop;
    this.widthBottom = widthBottom;
    this.heightLeft = heightLeft;
    this.heightRight = heightRight;
    this.width = (widthTop + widthBottom) / 2;
    this.height = (heightLeft + heightRight) / 2;
    this.depth = depth;
  }

  /** Largest disagreement between the two readings of the same dimension, inches. */
  get maxSpread() {
    return Math.max(
      Math.abs(this.widthTop - this.widthBottom),
      Math.abs(this.heightLeft - this.heightRight),
    );
  }

  /** True when the two readings of each dimension agree within 1/4". */
  get isConsistent() {
    return this.maxSpread <= 0.25;
  }

  get widthText() { return ClosetModel.toFraction16(this.width); }
  get heightText() { return ClosetModel.toFraction16(this.height); }
  get depthText() { return ClosetModel.toFraction16(this.depth); }

  /**
   * Format inches as a carpenter-style fraction rounded to the nearest 1/16".
   * 36.1875 -> `36 3/16"`, 36.5 -> `36 1/2"`, 35.999 -> `36"`.
   */
  static toFraction16(inches) {
    const sixteenths = Math.round(inches * 16);
    const whole = Math.floor(sixteenths / 16);
    let num = sixteenths - whole * 16;
    let den = 16;
    while (num > 0 && num % 2 === 0) {
      num /= 2;
      den /= 2;
    }
    return num === 0 ? `${whole}″` : `${whole} ${num}/${den}″`;
  }
}
