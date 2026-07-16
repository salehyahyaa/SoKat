import { Homography } from './homography.js';

// US Letter paper, landscape; manufactured tolerance is well under 1/64".
export const REF_LONG_IN = 11.0;
export const REF_SHORT_IN = 8.5;

/**
 * PlaneMeasurement — measures real-world distances (in inches) between points
 * that lie on the same physical plane as the calibration reference sheet.
 *
 * Calibration: the user taps the 4 corners of a letter-size sheet, going
 * around the sheet starting along a LONG (11") edge. Those pixel coordinates
 * are mapped to the sheet's known real-world coordinates, which fixes the
 * homography between the image and the physical plane.
 */
export class PlaneMeasurement {
  // refCornersPx: 4 tapped sheet corners (image px), ordered around the
  // sheet starting along a long edge.
  constructor(refCornersPx, longIn = REF_LONG_IN, shortIn = REF_SHORT_IN) {
    const world = [
      { x: 0, y: 0 },
      { x: longIn, y: 0 },
      { x: longIn, y: shortIn },
      { x: 0, y: shortIn },
    ];
    this.homography = Homography.solve(refCornersPx, world);
  }

  // Image-pixel point -> plane coordinates in inches.
  toWorld(px) {
    return this.homography.map(px);
  }

  // Real-world inches between two image-pixel points on the plane.
  distance(p1, p2) {
    const a = this.toWorld(p1);
    const b = this.toWorld(p2);
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
