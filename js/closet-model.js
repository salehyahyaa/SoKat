/**
 * ClosetModel — value object holding the measured closet dimensions plus
 * consistency diagnostics, with 1/16"-fraction formatting.
 *
 * Width and height are each measured twice (top & bottom edge, left & right
 * edge). The averages are the reported dimensions; the spread between the two
 * readings is a built-in consistency check surfaced to the user.
 */
export class ClosetModel {
  // Depth is either a single reading (two-photo flow) or a left/right pair
  // (single-photo flow), which then joins the consistency check.
  constructor({ widthTop, widthBottom, heightLeft, heightRight, depth, depthLeft, depthRight }) {
    this.widthTop = widthTop;
    this.widthBottom = widthBottom;
    this.heightLeft = heightLeft;
    this.heightRight = heightRight;
    this.width = (widthTop + widthBottom) / 2;
    this.height = (heightLeft + heightRight) / 2;
    this.depthLeft = depthLeft;
    this.depthRight = depthRight;
    this.depth = depthLeft != null ? (depthLeft + depthRight) / 2 : depth;
  }

  // Largest disagreement between paired readings of a dimension, inches.
  get maxSpread() {
    return Math.max(
      Math.abs(this.widthTop - this.widthBottom),
      Math.abs(this.heightLeft - this.heightRight),
      this.depthLeft != null ? Math.abs(this.depthLeft - this.depthRight) : 0,
    );
  }

  // Paired readings of each dimension agree within 1/4".
  get isConsistent() {
    return this.maxSpread <= 0.25;
  }

  get widthText() { return ClosetModel.toFraction16(this.width); }
  get heightText() { return ClosetModel.toFraction16(this.height); }
  get depthText() { return ClosetModel.toFraction16(this.depth); }

  // Carpenter fraction to the nearest 1/16": 36.1875 -> 36 3/16", 35.999 -> 36".
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
