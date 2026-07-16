import { PlaneMeasurement } from './measurement.js';

// The challenge's accuracy target: 1/16 inch.
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
  // refCornersPx: calibration sheet corners (image px).
  constructor(refCornersPx) {
    this.plane = new PlaneMeasurement(refCornersPx);
  }

  // Measured inches between two tapped image points.
  measure(p1, p2) {
    return this.plane.distance(p1, p2);
  }

  // Error report against a known true length.
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
