# SpaceScan

Measure a closet's width & height with an iPhone — in Safari, no app
install, nothing to type, no reference object. The **iPhone camera is the
sensor**; scale is inferred automatically from the camera's recovered
position (assumed standing phone height), and tapping any result lets the
user correct it. One photo, validated at every step, with an honest
confidence score and a built-in tape-measure validation mode.

**Demo:** open the GitHub Pages URL on an iPhone in Safari. Everything runs
on-device; there is no backend.

## Architecture

```
photo (iPhone camera via <input capture>)
  → capture-quality checks (resolution, EXIF, user confirmation)
  → tap the back wall's 4 corners (magnifier loupe, undo/reset/retake)
  → geometry validation: convex quad, size, tops-above-bottoms, side tilt,
      rectangularity residual under the EXIF or vanishing-point focal
  → pose recovery: the wall rectangle + focal → camera position; assuming
      a vertical wall on a horizontal floor, the camera's height above the
      floor in wall units + a standing phone height (58″) = absolute scale
      (exact on synthetic ground truth — tests/metrology.test.js)
  → tap 2 endpoints per dimension (live measured length on the line)
  → endpoint validation + plausibility bounds → accept height, accept width
```

- The phone-height assumption is the dominant error: results carry an
  explicit **±8% band** until the user taps a result and corrects it, which
  rescales the other dimension from the photo's exact proportions (band
  drops to ~±1%).
- **Confidence** (High/Medium/Low) is scored per view from: sheet size in
  frame, rectangularity residual, edge-order ratio, endpoint leverage
  (distance from the sheet), resolution, and focal cross-checks. The scan's
  confidence is its weakest view; **Low blocks the result** and asks for a
  retake. Implausible values (e.g. a 180″ height) are blocked at the moment
  of measurement, never displayed.
- **Photo cleanup (beta):** an inpainting brush blends objects into their
  surroundings — an approximate visual cleanup, not reconstruction of
  hidden detail.
- Zero dependencies, no build step. Pure-math modules (`homography`,
  `measurement`, `validation`, `closet-model`, `accuracy`) run identically in
  the browser and in Node's test runner, so every validation rule is
  CI-enforced.

## Validation procedure

1. **Synthetic ground truth (CI):** a virtual pinhole camera photographs
   scenes of exactly known size; the pipeline must recover distances to
   <1e-6 relative error (`tests/synthetic.test.js`, `measurement.test.js`).
2. **Rule tests (CI):** every rejection path has a unit test — crossed or
   duplicated corners, outline too small, top-below-bottom, misplaced-corner
   rectangularity, near-identical endpoints, implausible values, confidence
   tiers, display formatting (`tests/validation.test.js`); the camera-height
   scale recovery is proven exact in `tests/metrology.test.js`.
3. **Noise envelope (CI):** seeded tap noise quantifies expected error
   (`tests/noise.test.js`); the UI's ±% band comes from the same model.
4. **In-app Validation mode:** tape-measure the same closet, record trials;
   the app reports per-dimension absolute + percentage error, mean absolute
   error, and max error, stores trials locally, and exports CSV/JSON.

## Accuracy — honest statement

- Display formats to the nearest **1/16″** and feet/inches. **That is
  display resolution, not measured accuracy** — every result carries an
  explicit ±% band, and the diagnostics panel shows unrounded values.
- The math is exact; real error is dominated by the phone-height
  assumption (±8% typical) until the user corrects one dimension, after
  which tap precision and lens distortion dominate (~±1–2%). The app never
  claims the 1/16″ target is met unless every recorded validation-trial
  error is ≤ 0.0625″.
- Safari exposes **no LiDAR/ARKit/RoomPlan/WebXR** — this is the strongest
  honest implementation available in a browser. A native iOS app could use
  RoomPlan (roughly inch-level) or ARKit ray-casting; true 1/16″ generally
  requires contact measurement.

## Run it

```
npm test          # all unit + validation suites (no dependencies)
npm run check     # syntax gate
npm run serve     # local server at http://localhost:8000
```

CI (`.github/workflows/ci.yml`) runs both gates on every push and deploys to
GitHub Pages only when they pass.

## Limitations

- Measures width & height on the wall plane; depth is not measured.
- Assumes a planar vertical wall on a horizontal floor, photographed from a
  standing position; crouching or holding the phone unusually high skews
  the auto-scale (the tap-to-correct fixes it).
- Endpoints must lie (approximately) on the wall plane; off-plane features
  add error the homography can't correct.
- Wide-angle (0.5×) lens distortion is uncorrected — the app tells users to
  avoid it.
- The inpainting cleanup is approximate by design and labeled experimental.
