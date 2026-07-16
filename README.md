# SpaceScan

Measure any space with an iPhone — a closet, pantry, alcove, or room corner —
in the browser, no app install. ONE photo, ten taps: the app digitally
empties the space (with a brush to erase any other object), shows a clean
rotatable 3D model, and displays the dimensions. Zero dependencies.

**Demo:** open the GitHub Pages URL on an iPhone in Safari. Everything runs
on-device; there is no backend.

---

## How it works

An iPhone browser gets camera access but **not** LiDAR/ARKit (Apple exposes
those only to native apps), so ClosetScan measures the way photogrammetry
tools do: a **known-size reference** — a letter-size sheet of paper
(8.500″ × 11.000″, manufactured to <1/64″ tolerance) placed in the closet —
fixes the scale of the scene.

Two modes:

- **Quick Scan (default)** — ONE photo, paper simply dropped flat on the
  closet floor (no tape). Width & depth are measured directly on the
  calibrated floor plane; height is recovered via single-view metrology:
  the paper's homography is decomposed into the camera pose (Zhang's method,
  EXIF focal length when available), and the tapped ceiling corners are
  ray-cast onto the vertical back-wall plane. Measured lines extend and
  recalculate LIVE as corners are dragged. Typical accuracy ±1/2″
  (height ±1½″) — see `tests/metrology.test.js` for the noise envelope.
- **Precision Scan** — the two-photo flow (paper taped to the back wall,
  then on the floor). Every distance is measured ON a calibrated plane;
  this is the mode that meets the **1/16″** target.

Pipeline per photo:

```
camera photo (12 MP)
  → user taps the paper's 4 corners (magnifier loupe → ~0.5 px precision)
  → Homography: DLT solve, image plane ↔ physical plane (inches)
  → user taps closet corners → real-world distances on that plane
  → ClosetModel: paired-edge averaging + consistency diagnostics
  → ClosetEmptier: contents digitally removed from the photo (before/after swipe)
  → EmptyClosetRenderer: clean 3D interior at measured size, contents gone
```

In Precision Scan, width & height come from a back-wall photo; depth from a
floor photo. An optional **refinement pass** (second photo, averaged) cuts
random error by √2 — that is what carries large spans inside the 1/16″
target (proven in `tests/noise.test.js`).

## Project structure

```
.
├── index.html                  # single-page app shell (all screens)
├── css/
│   └── style.css               # mobile-first dark UI
├── js/                         # one class per module, zero dependencies
│   ├── app.js                  # ClosetScanApp — screen state machine / orchestrator
│   ├── camera.js               # CameraCapture — native iPhone camera via <input capture>
│   ├── picker.js               # CornerPicker — precision tapping UI with magnifier loupe
│   ├── homography.js           # Homography — DLT solve + perspective mapping (pure math)
│   ├── metrology.js            # SingleViewMetrology — camera-pose recovery, 3D from ONE photo
│   ├── exif.js                 # focal35FromJpeg — EXIF focal length for stable height recovery
│   ├── measurement.js          # PlaneMeasurement — calibrated plane, pixels → inches
│   ├── closet-model.js         # ClosetModel — dimensions value object + 1/16″ formatting
│   ├── emptier.js              # buildEmptiedViews + BeforeAfterView — remove contents from the photo
│   ├── renderer.js             # EmptyClosetRenderer — 3D empty-closet view (Canvas 2D)
│   └── accuracy.js             # AccuracyChecker — live error report vs. known length
├── tests/                      # run with `npm test` (node --test, no deps)
│   ├── helpers.js              # synthetic pinhole camera + seeded PRNG
│   ├── homography.test.js      # math correctness & numerical stability
│   ├── metrology.test.js       # single-photo mode: exactness + honest noise envelope
│   ├── measurement.test.js     # pipeline units, fractions, accuracy report
│   ├── synthetic.test.js       # ground-truth closets: pipeline exact to <1/1600″
│   └── noise.test.js           # tap-noise envelope: proves the 1/16″ operating window
├── docs/
│   └── VALIDATION.md           # 4-layer accuracy validation: data, protocol, error budget
├── .github/
│   └── workflows/
│       └── ci.yml              # CI/CD: test + static gates → deploy to GitHub Pages
└── package.json                # scripts only (test / check / serve / build) — no dependencies
```

## Architecture

Zero-dependency vanilla JS (ES2022), one class per module:

| Class | File | Responsibility |
|---|---|---|
| `ClosetScanApp` | `js/app.js` | Screen state machine; wires the pipeline |
| `CameraCapture` | `js/camera.js` | Native camera via `<input capture>`; EXIF-upright full-res canvas |
| `CornerPicker` | `js/picker.js` | Precision tapping UI: drag-refine + magnifier loupe; stores full-res pixel coords |
| `Homography` | `js/homography.js` | DLT solve (Gaussian elimination w/ partial pivoting), perspective mapping |
| `PlaneMeasurement` | `js/measurement.js` | Calibrated plane: pixel points → distances in inches |
| `ClosetModel` | `js/closet-model.js` | Dimensions value object; paired-edge averaging; 1/16″ fraction formatting |
| `BeforeAfterView` | `js/emptier.js` | Inpaints the tapped closet region with a clean, lit wall surface; swipeable with-contents / emptied comparison |
| `EmptyClosetRenderer` | `js/renderer.js` | Own perspective projection on Canvas 2D; rotatable empty interior + dimension callouts |
| `AccuracyChecker` | `js/accuracy.js` | Live on-stage error report vs. a known length |

`Homography`, `PlaneMeasurement`, `ClosetModel`, `AccuracyChecker` are pure
logic with no DOM access — they run identically in the browser and in Node's
test runner, which is what makes the accuracy claims CI-enforceable.

Design decisions (and rejections):
- **No framework, no build step** — a single-flow app; tooling adds risk, not value.
- **No OpenCV.js** — we need one algorithm (4-point homography); 100 own lines beat an 8 MB WASM download.
- **No Three.js** — one box interior; own projection is ~200 lines.
- **No backend** — measurement is pure math; a server would add a demo-day failure mode and change results by exactly zero.
- **`<input capture>` over `getUserMedia`** — no permission friction, full 12 MP stills (resolution = accuracy), works over plain HTTP.

## Accuracy: tested and validated

Four layers — see [`docs/VALIDATION.md`](docs/VALIDATION.md) for full data:

1. **Synthetic ground truth (CI):** virtual closets of exactly known size
   projected through a realistic pinhole camera → pipeline error **< 1/1600″**
   across all sizes/poses. The math is exact.
2. **Noise envelope (CI):** seeded gaussian tap noise, 300 trials/config,
   p95 assertions. Full protocol (loupe taps + refinement pass):
   **p95 = 0.046″ on a 36″ width — inside 1/16″.** Degraded conditions are
   quantified, not hidden.
3. **Physical protocol:** steel-tape ground truth on a real closet, 3 app
   runs × 5 dimensions, recorded in a results table.
4. **Live Accuracy Check mode:** the app measures a second sheet's 11.000″
   edge on stage and displays its own error with a PASS/FAIL badge (~8×
   margin in simulation).

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`): every push runs the accuracy
suites and static checks; **deployment to GitHub Pages only happens if both
gates pass** — a change that breaks the 1/16″ envelope can't reach the demo
URL.

```
push → [test: npm test] + [static: npm run check] → deploy → GitHub Pages
```

One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

## Run it

```bash
npm test          # accuracy + unit suites (18 tests, no dependencies)
npm run check     # syntax gate
npm run serve     # local server at http://localhost:8000
npm run build     # minified production build in dist/ (esbuild via npx, still no deps)
```

To try on an iPhone during development: `npm run serve`, then open
`http://<your-mac-ip>:8000` on the phone (same Wi-Fi).

## Demo script (~3 minutes)

1. Tape a letter sheet to the closet's back wall (landscape, flat). Open the
   Pages URL → **Scan Closet**.
2. Photograph the back wall → tap paper corners → tap closet corners (show
   the loupe). Add the refinement pass.
3. Move the sheet to the floor → photograph → tap → depth done.
4. Results: rotate the **emptied closet** in 3D; dimensions in carpenter
   fractions; consistency check ✓.
5. Finale — **Accuracy Check**: measure the second sheet's 11.000″ edge;
   the PASS badge shows the error live, in thousandths of an inch.
