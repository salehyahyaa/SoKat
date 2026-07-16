# SpaceScan

Measure a **rectangular closet, pantry, or alcove** with an iPhone — in the
browser, no app install. One photo, six corner taps, one known reference
measurement. The app validates the tapped geometry before computing anything,
scores its own confidence, blocks implausible results instead of displaying
them, and ships a tape-measure validation mode that records and exports its
real error.

**Demo:** open the GitHub Pages URL on an iPhone in Safari. Everything runs
on-device; there is no backend.

**Supported target:** box-shaped enclosed spaces only. Couches, chairs, and
irregular objects are not supported — the geometry assumes a rectangular
floor footprint and a vertical back wall, and validation rejects scans that
don't fit that model.

---

## How it works

An iPhone browser gets camera access but **not** LiDAR/ARKit (Apple exposes
those only to native apps), so SpaceScan measures with single-view metrology:

1. The user taps the closet's 6 corners in a guided order (back-bottom-left,
   back-bottom-right, front-bottom-left, front-bottom-right, back-top-left,
   back-top-right), with a wireframe overlay to verify the box.
2. Geometry validation gates the flow: crossed or duplicated points, an
   invalid floor quadrilateral, a top edge below the floor, inconsistent
   wall verticals, implausible vanishing points, and near-border points are
   all rejected with specific explanations (`js/validation.js`).
3. From the floor rectangle's perspective and the camera focal length (EXIF
   `FocalLengthIn35mmFilm`, cross-checked against a vanishing-point
   estimate), the homography is decomposed into the camera pose — giving
   every dimension **ratio** (`js/metrology.js`, exact to <1e-6 on synthetic
   ground truth).
4. Pixels can never provide absolute units, so the user enters **one**
   known dimension (range-checked); the other two scale from it.
5. Independent estimates are compared (left vs right wall height, floor
   rectangularity residual, EXIF vs vanishing-point focal, predicted vs
   tapped verticals) and folded into a High/Medium/Low **confidence score**.
   Low confidence or implausible dimensions (e.g. a 180″ "height") block the
   result with an explanation instead of displaying it.

## Accuracy — honest statement

**A single browser photo plus one manually entered dimension cannot
guarantee 1/16″ accuracy.** This app does not claim it can:

- Results display at 1/4″ resolution with an explicit ± error band.
  Formatting precision is never presented as measured accuracy.
- The math itself is exact (validated to <1e-6 against a synthetic pinhole
  camera); real-world error is dominated by finger-tap precision (~±0.5–2 px
  per corner), lens distortion, and the accuracy of the user's reference
  measurement. Realistic end-to-end error is on the order of **±1–5%** per
  dimension under good conditions.
- The built-in **Validation mode** records app-vs-tape-measure errors per
  trial (absolute and percentage, mean and max) and exports CSV/JSON. The
  1/16″ target is only ever reported as met if every recorded error is
  ≤ 0.0625″ — which a photo-based method should not be expected to achieve.

**If the challenge strictly requires sensor-based scanning and demonstrated
1/16″ accuracy, a native iOS implementation is required**: ARKit + LiDAR
(e.g. RoomPlan) provides true metric scale without a user reference, and
Apple quotes roughly inch-level accuracy for RoomPlan — still short of
1/16″, which in practice requires contact measurement (tape/laser).
This web app is the strongest version physically possible inside a browser.

## Project structure

```
.
├── index.html                  # single-page app shell (all screens)
├── css/
│   └── style.css               # mobile-first dark UI
├── js/                         # one class per module, zero dependencies
│   ├── app.js                  # SpaceScanApp — screen state machine / orchestrator
│   ├── camera.js               # CameraCapture — native iPhone camera via <input capture>
│   ├── picker.js               # CornerPicker — tapping UI: loupe, drag-refine, box wireframe
│   ├── validation.js           # geometry / plausibility / confidence rules (pure math)
│   ├── homography.js           # Homography — DLT solve + perspective mapping (pure math)
│   ├── metrology.js            # SingleViewMetrology + rectangleMetrology — pose recovery
│   ├── exif.js                 # focal35FromJpeg — EXIF focal length
│   ├── measurement.js          # PlaneMeasurement — plane homography, pixels → plane units
│   ├── closet-model.js         # ClosetModel — dimensions value object + fraction formatting
│   ├── emptier.js              # PhotoEraser — classical texture inpainting (visual cleanup)
│   ├── renderer.js             # EmptyClosetRenderer — 3D box view (Canvas 2D)
│   └── accuracy.js             # AccuracyChecker — error report vs. a known length (tests)
├── tests/                      # run with `npm test` (node --test, no deps)
│   ├── helpers.js              # synthetic pinhole camera + seeded PRNG
│   ├── validation.test.js      # invalid geometry, implausible output, confidence, formatting
│   ├── metrology.test.js       # pose recovery: exactness + honest noise envelope
│   ├── homography.test.js      # math correctness & numerical stability
│   ├── measurement.test.js     # plane math, fractions, error report
│   ├── synthetic.test.js       # ground-truth scenes: math exact to <1e-6
│   └── noise.test.js           # tap-noise envelope (quantified, not hidden)
├── docs/
│   └── VALIDATION.md           # validation methodology + honest error budget
├── .github/workflows/ci.yml    # CI: test + static gates → deploy to GitHub Pages
└── package.json                # scripts only (test / check / serve) — no dependencies
```

## Architecture

Zero-dependency vanilla JS (ES2022). `validation.js`, `homography.js`,
`metrology.js`, `measurement.js`, `closet-model.js`, and `accuracy.js` are
pure logic with no DOM access — they run identically in the browser and in
Node's test runner, which is what makes the validation rules CI-enforceable.

Design decisions:
- **No framework, no build step** — a single-flow app; tooling adds risk, not value.
- **No OpenCV.js** — one homography + pose decomposition; own code beats an 8 MB WASM download.
- **No Three.js** — one box interior; own projection is ~200 lines.
- **No backend** — measurement is pure math; a server adds a demo failure mode and changes results by zero.
- **`<input capture>` over `getUserMedia`** — no permission friction, full-res stills, EXIF access.
- **Inpainting is classical** (diffusion base + exemplar patch synthesis with
  PatchMatch-style propagation) — described in the UI as a *visual cleanup
  approximation*, never as AI reconstruction of hidden detail.

## Validation

1. **Synthetic ground truth (CI):** virtual closets of exactly known size
   projected through a pinhole camera → the math recovers dimensions to
   <1e-6 relative error across sizes, poses, and focal lengths.
2. **Rule tests (CI):** every geometry rejection rule, plausibility bound,
   left/right disagreement gate, and confidence tier has a unit test,
   including a couch-like non-rectangular scan that must be rejected.
3. **Noise envelope (CI):** seeded tap noise quantifies realistic error —
   published as an expected ±% band in the UI, not hidden.
4. **In-app Validation mode:** tape-measure comparison per trial with
   absolute/percentage errors, mean/max summary, local history, CSV/JSON
   export. The 1/16″ target is only reported met if every recorded error is
   ≤ 0.0625″.

## CI/CD

GitHub Actions: every push runs all test suites and static checks;
**deployment to GitHub Pages only happens if both gates pass.**

```
push → [test: npm test] + [static: npm run check] → deploy → GitHub Pages
```

## Run it

```bash
npm test          # all unit + validation suites (no dependencies)
npm run check     # syntax gate
npm run serve     # local server at http://localhost:8000
npm run build     # minified production build in dist/ (esbuild via npx, still no deps)
```

To try on an iPhone during development: `npm run serve`, then open
`http://<your-mac-ip>:8000` on the phone (same Wi-Fi).

## Demo script (~3 minutes)

1. Open the Pages URL → **Scan a closet** → walk the corner diagram and the
   shooting checklist.
2. Photograph the closet → confirm the photo checklist → tap the 6 corners
   (show the loupe, the live box wireframe, and drag-to-adjust). Optionally
   misplace a point to show the specific rejection message.
3. Enter one known dimension (e.g. ceiling height) → results with the
   confidence badge and ± error band. Open **Diagnostics** to show the
   unrounded internals and cross-check numbers.
4. **Photo cleanup**: drag over the contents to remove them (call it a
   visual approximation), and show the 3D box view.
5. Finale — **Validation mode**: enter tape-measured width/height/depth;
   the app records and displays its own error, and exports the table as CSV.
