import { PlaneMeasurement } from './measurement.js';

/** The challenge's accuracy target: 1/16 inch. */
export const TARGET_IN = 1 / 16;

/**
 * AccuracyChecker — live, on-stage accuracy validation.
 *
 * The app calibrates on reference sheet A, then measures a second known
 * distance on the same plane (sheet B's 11.000" edge, or any tape-measured
 * distance the presenter enters). Since the true value is known, the app can
 * display its own error in sixteenths, live.
 */
export class AccuracyChecker {
  /** @param {{x:number,y:number}[]} refCornersPx calibration sheet corners (image px) */
  constructor(refCornersPx) {
    this.plane = new PlaneMeasurement(refCornersPx);
  }

  /** Measured distance in inches between two tapped image points. */
  measure(p1, p2) {
    return this.plane.distance(p1, p2);
  }

  /**
   * Build an error report against a known true length.
   * @param {number} measuredIn
   * @param {number} trueIn
   */
  static report(measuredIn, trueIn) {
    const errorIn = measuredIn - trueIn;
    return {
      measuredIn,
      trueIn,
      errorIn,
      errorSixteenths: errorIn * 16,
      pass: Math.abs(errorIn) <= TARGET_IN + 1e-9,
    };
  }
}
