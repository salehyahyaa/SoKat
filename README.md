# SpaceScan

Measure a closet's width & height with an iPhone — in Safari, no app
install. The **iPhone camera is the sensor**; physical scale comes from
**any flat rectangle of known size** (default: 8.5 × 11″ paper) placed on
the measured plane. One photo, validated at every step, with an honest
confidence score and a built-in tape-measure validation mode.

**Demo:** open the GitHub Pages URL on an iPhone in Safari. Everything runs
on-device; there is no backend.

## Architecture

```
photo (iPhone camera via <input capture>)
  → capture-quality checks (resolution, EXIF, user confirmation)
  → tap the reference's 4 corners, any order around it (magnifier loupe,
      undo/reset/retake; orientation auto-resolves from the edge ratio)
  → geometry validation: convex quad, size, rectangularity (homography
      column orthogonality under the EXIF or vanishing-point focal —
      rejects bent/misplaced references)
  → homography (DLT) = perspective rectification: image px ↔ plane inches
  → tap 2 endpoints per dimension (live measured length on the line)
  → endpoint validation: separation, borders, plausibility bounds
  → accept width, accept height → results
```

- Width & height come from **one back-wall view**: the reference and both
  endpoint pairs share a physical plane — the regime where a single
  homography is exact.
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
   duplicated reference corners, reference too small, tap-order
   auto-resolution, non-rectangular taps, near-identical endpoints,
   implausible values, confidence tiers, display formatting
   (`tests/validation.test.js`).
3. **Noise envelope (CI):** seeded tap noise quantifies expected error
   (`tests/noise.test.js`); the UI's ±% band comes from the same model.
4. **In-app Validation mode:** tape-measure the same closet, record trials;
   the app reports per-dimension absolute + percentage error, mean absolute
   error, and max error, stores trials locally, and exports CSV/JSON.

## Accuracy — honest statement

- Display formats to the nearest **1/16″** and feet/inches. **That is
  display resolution, not measured accuracy** — every result carries an
  explicit ±% band, and the diagnostics panel shows unrounded values.
- The math is exact; real error comes from tap precision (±0.5–2 px), lens
  distortion, sheet flatness, and endpoint leverage. Under good conditions
  the noise model predicts roughly **±0.5–2% per dimension** (about
  1/8″–3/4″ on typical closet spans); the app never claims the 1/16″ target
  is met unless every recorded validation-trial error is ≤ 0.0625″.
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
- Assumes the wall is planar and the reference lies flat on it; the entered
  reference size must be accurate — its error scales all results.
- Endpoints must lie (approximately) on the calibrated plane; off-plane
  features add error the homography can't correct.
- Wide-angle (0.5×) lens distortion is uncorrected — the app tells users to
  avoid it.
- The inpainting cleanup is approximate by design and labeled experimental.
