# Validation methodology

## What "accurate" means here — and what it doesn't

SpaceScan measures a rectangular closet from ONE photo plus ONE user-entered
reference dimension. That method has a hard ceiling:

- The **math** is exact: on synthetic ground truth (a pinhole camera
  projecting closets of exactly known size), recovered dimensions match to
  <1e-6 relative error (`tests/metrology.test.js`, `tests/validation.test.js`).
- The **real-world error** is dominated by inputs the math can't control:
  finger-tap precision (±0.5–2 px per corner), lens distortion, EXIF focal
  tolerance, non-ideal geometry (walls that aren't plumb, floors that aren't
  square), and the accuracy of the user's own reference measurement.
- Realistic end-to-end accuracy is **±1–5% per dimension** under good
  conditions. Display formatting is 1/4″; that is a display choice, not an
  accuracy claim.

**The original 1/16″ (0.0625″) target is not achievable with this method**,
and the app never claims otherwise. The in-app Validation mode records
app-vs-tape errors per trial and only reports the 1/16″ target as met if
every recorded error is ≤0.0625″. Achieving that genuinely requires either
contact measurement (tape/laser) or, at minimum, a native iOS app using
ARKit/LiDAR (Apple RoomPlan) — which itself is quoted at roughly inch-level
accuracy, still short of 1/16″.

## Validation layers

1. **Synthetic exactness (CI)** — pose recovery and scaling are checked
   against a virtual camera to <1e-6. Any math regression fails CI and
   blocks deployment.
2. **Rejection rules (CI)** — every geometry gate has a unit test: crossed
   edges, duplicate points, top-below-floor, border points, leaning wall
   edges, non-rectangular (couch-like) footprints, left/right height
   disagreement, implausible dimensions (a 180″ height must be blocked),
   out-of-proportion results, and reference range checks.
3. **Noise envelope (CI)** — seeded gaussian tap noise quantifies expected
   error; the UI's ±% band comes from the same model.
4. **In-app Validation mode** — the user tape-measures the same closet and
   records trials; the app computes per-dimension absolute and percentage
   error, mean absolute error, and max error, stores trials locally, and
   exports CSV/JSON for presentation.

## Confidence scoring

Each scan is scored from independent evidence: EXIF focal presence, EXIF vs
vanishing-point focal agreement, floor rectangularity residual, left/right
height agreement, tapped-vs-predicted wall verticals, camera pitch, photo
resolution, and border proximity. High ≥75, Medium ≥50, otherwise Low —
and Low-confidence scans are blocked with reasons instead of displayed.
