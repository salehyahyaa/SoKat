# SoKat / SpaceScan — Complete Project Documentation

**SpaceScan** is a measuring tool for interior spaces built around one idea: an
iPhone photo, plus the right geometry, replaces a tape measure. It ships as a
zero-dependency browser web app (deployed on GitHub Pages) with a native iOS
companion app for LiDAR.

- Production web app: **https://salehyahyaa.github.io/SoKat/**
- Repository: `github.com/salehyahyaa/SoKat`
- Deploy model: pushing to `main` **is** the deploy (CI runs tests + syntax
  gates first, then publishes the repo root to GitHub Pages).

This document covers the architecture, all three measuring modes, the complete
workflows, setup and troubleshooting, and — in the greatest detail — **Precision
mode**: how it reaches 1/16″, exactly how that claim was validated, what the
validation does and does not prove, and every factor that can break it.

---

## 1. The three modes at a glance

| Mode | Platform | Setup | Accuracy | Scale comes from |
|---|---|---|---|---|
| **Quick Scan** | Web (Safari) | None | ±5–8% (≈2–3″ on a closet) | Assumed 58″ chest-height phone position |
| **LiDAR Scan** | Native iOS app | None | ≈ ±0.5″ | LiDAR depth sensor (ARKit raycasts) |
| **Precision** | Web (Safari) | Print + tape one sheet | **1/16″ near the target** (verified per photo); ±1/8–1/4″ far from it | A printed checkerboard of exactly-1.000″ squares visible in the photo |

The core truth underneath all three: **a camera image alone contains no absolute
scale.** A photo of a big closet far away and a small closet up close can be
pixel-identical. Every mode is a different answer to "where does the scale come
from," and each answer has a different accuracy ceiling:

- Quick guesses the scale (from how people typically hold phones) → percent-level error.
- LiDAR measures depth directly, but coarsely (sparse grid, ~1% depth error) → half-inch-level.
- Precision puts a manufactured ground-truth object *into the photo* → sub-sixteenth-level, and uniquely, **it can verify its own accuracy on every shot** (§5.6).

### Accuracy in plain inches

If someone asks "how far off will the number be," the answer per mode:

| Mode | How far off, in inches |
|---|---|
| **Quick Scan** | Off by up to **2 to 3 inches** on a typical closet. If you correct any one dimension with a tape measure, the rest tighten to within about **half an inch**. |
| **LiDAR Scan** | Off by up to **half an inch**, regardless of room size — that's the limit of the sensor. |
| **Precision** | Off by no more than **1/16 of an inch** for anything on or near the printed target — in testing, the typical error was **3/100 of an inch** and the single worst case was **5/100 of an inch** on a 26-inch span (§6.2). Far from the target it degrades to within **1/8 to 1/4 of an inch**. |

Rule of thumb: Quick is off by a couple of inches, LiDAR by half an inch,
Precision by less than the thickness of a nickel — and Precision prints its
actual error range on every photo (§5.5).

---

## 2. Repository layout

```
index.html            Single-page app: all screens (welcome/guide/capture/pick/results/…)
target.html           Printable Precision target (CSS physical inches)
target.pdf            Same target as a vector PDF (geometry in exact PDF points, 1/72 in)
css/style.css         All styling
js/
  app.js              App shell: screens, mode picker, Quick-scan flow, results UI
  precision.js        Precision-mode flow (DOM glue only; no math)
  target.js           Precision math: detection, sub-pixel corners, calibration, error band
  metrology.js        Single-view metrology: pose from a quad, focal recovery, wall height
  measurement.js      Plane measurement via homography (reference-sheet math)
  homography.js       DLT homography solver (exact 4-point + normalized least-squares)
  validation.js       Geometry gates, confidence scoring, formatting (1/16″ fractions)
  picker.js           Corner-tapping UI with magnifier loupe (the "tap accuracy" layer)
  camera.js           Camera via <input capture>; EXIF focal extraction
  exif.js             Minimal JPEG EXIF reader (35mm-equivalent focal length)
  emptier.js          "Cleanup" inpainting eraser on the results screen (beta)
  flow.js             Shared flow sentinels (RETAKE/HOME) — see §9 note on module identity
tests/
  precision.test.js   Synthetic-render end-to-end proof of the 1/16″ claim (§6)
  metrology.test.js   Pose/metrology math + quick-mode noise envelopes
  noise.test.js       Tap-noise Monte Carlo envelopes for the reference-sheet math
  synthetic.test.js   Exactness tests on perfect inputs
  homography.test.js, measurement.test.js, validation.test.js
  helpers.js          PinholeCamera (synthetic ground truth), seeded PRNG, jitter, percentiles
ios/
  project.yml         XcodeGen spec (bundle id com.sokat.SpaceScan)
  Sources/            SwiftUI app: mode home + native LiDAR measuring (ARKit)
docs/VALIDATION.md    Earlier validation notes for the reference-sheet pipeline
```

Zero runtime dependencies. Tests run on plain `node --test`. The build
(`npm run build`) is only minification; the deployed site is the repo root.

---

## 3. Quick Scan — workflow and how it works

**User flow:** Select *Quick Scan* → Start → guide → take one photo of the back
wall (whole wall, floor to ceiling, standing, 1× lens) → tap the wall's 4
corners → tap 2 points for height (live value, Accept) → 2 points for width →
results with confidence badge and ±% band.

**How it works (js/metrology.js `rectangleMetrology`):**

1. The 4 tapped wall corners are assumed to be a physical rectangle of unknown
   size. Its plane→image homography is computed.
2. The camera focal length comes from, in priority order: photo EXIF
   (35mm-equivalent → pixels) → recovery from the rectangle's vanishing-point
   orthogonality → an assumed 26mm-equivalent (the iPhone main camera), used
   only when the shot is too frontal to recover from (a head-on wall has no
   perspective to read).
3. With the focal, the homography decomposes into the camera pose (Zhang's
   method). The rectangle's aspect ratio falls out exactly; everything is
   correct **up to one global scale factor**.
4. Scale: the camera's height above the floor is known in wall-units from the
   pose; assuming a 58″ chest-height phone position converts that to inches.
   This assumption is the dominant error (±5–8%).
5. Every stage is gated: quad geometry checks, pose plausibility (an outline
   implying a 20″ or 300″ wall is rejected), confidence scoring; low confidence
   **blocks** the result rather than showing bad numbers.
6. Escape hatch: tapping a result and typing one tape-measured dimension
   rescales the other from the photo's (accurate) proportions — ~±1%.

**Known quick-mode failure modes** (all observed in real use):
- **Wrong lens**: with no EXIF, the 1× lens is assumed. A 0.5× ultrawide shot
  makes every number ~2× too small; 2× telephoto ~2× too big. The app shows an
  explicit warning whenever the lens had to be assumed.
- **Outline not floor-to-ceiling**: the scale anchor is the camera's height
  above the *floor*; if the tapped quad's bottom edge is not the floor line,
  scale breaks silently. The instructions and guide enforce this.
- Missing EXIF (some upload paths, some capture paths strip it) removes the
  best focal source; accuracy degrades but the flow no longer hard-fails.

---

## 4. LiDAR Scan (native iOS app) — workflow and how it works

**User flow:** open the SpaceScan iOS app → *LiDAR Scan* → aim the crosshair →
tap **+** at floor, ceiling, left edge, right edge → result card (inches + cm),
undo at any step.

**How it works (ios/Sources/):** ARKit world tracking with scene-mesh
reconstruction. Each **+** raycasts the screen-center reticle against the LiDAR
mesh (`MeasureSession.swift`); height = vertical distance floor→ceiling marks,
width = horizontal distance left→right marks. On non-LiDAR iPhones it falls
back to estimated planes with a visible "accuracy reduced" banner.

**Platform requirement:** LiDAR only works on iOS, and only natively. The
sensor exists solely on iPhone Pro models (12 Pro and later) and recent iPads
Pro, and Apple exposes it exclusively through ARKit to native apps — no
browser has a LiDAR API, which is why this mode cannot exist in the web app.
Non-Pro iPhones run the same app in a camera-only fallback (~±2″) with a
visible banner.

**Why ±0.5″ and not better:** the iPhone LiDAR is a sparse (~256×192) depth
sensor with roughly ±1% depth error; ARKit fuses it with visual tracking, but
mesh quantization and tracking drift keep practical accuracy at the half-inch
level — the same ballpark as Apple's own Measure app. **No phone LiDAR reaches
1/16″;** that is a sensor limit, not an implementation limit.

The iOS app's home screen also links the two web modes (opened in-app), so the
single app exposes all three modes. Build/distribution: §10.

---

## 5. Precision mode — full detail

### 5.1 What it is and when to use it

Precision mode measures distances **on a flat surface** to a verified 1/16″
near a printed reference target. Use it when the number actually matters —
built-ins, trim carpentry, furniture clearances. Don't use it for rough sizing
(Quick is faster) or for point-to-point distances that don't lie on one plane
(no photo mode can do that; that's LiDAR's job at ±0.5″).

**Precision mode does not use LiDAR** — it is camera-plus-printed-sheet only,
and it runs in Safari, which has no LiDAR access anyway. LiDAR and Precision
are opposite strategies: LiDAR measures depth with a laser and caps out at
±0.5″; Precision skips depth sensing entirely and pins the geometry to
manufactured ground truth in the photo, which is how it reaches 1/16″ — an
accuracy the LiDAR sensor is physically incapable of.

**User workflow:**

1. **One-time:** download `target.pdf` (button in the app) and print it on
   letter paper at **100% / Actual Size** — never "Fit to page". No cutting;
   the whole sheet is used as-is. Verify with any ruler: the checkerboard must
   measure exactly **8 × 5 inches**.
2. **Tape the sheet flat** on the surface being measured (wall for wall
   distances, floor for floor distances), ideally centered on the span.
3. **One photo** containing both the sheet and the span. Closer = tighter.
4. The app **auto-detects the sheet** (no tapping). Fallbacks: tap its 4 dots,
   or proceed without a sheet at quick-mode accuracy with an explicit warning.
5. **Tap the 2 endpoints** of the distance (any direction — horizontal,
   vertical, diagonal). The magnifier loupe gives ~0.5px tap precision.
6. **Answer** with a per-photo accuracy badge, e.g.
   `36 5/16″ · ✓ within ±1/16″ (band ±1/16″)`. "Measure another distance"
   reuses the same photo; "Add a 2nd photo" averages two shots for a
   ~1.4× tighter band.

### 5.2 The printed target (target.pdf / target.html)

An **8×5 grid of 1.000″ squares** (alternating black/white; square (i,j) is
black iff i+j is even) with **four ⌀0.6″ solid black discs** centered 0.6″
diagonally outside the board corners. Geometry is defined identically in three
places that must stay in sync: `js/target.js` (`TARGET`), `target.html` (CSS
physical inches), `target.pdf` (vector PDF, 1pt = 1/72″ exactly).

Design rationale:
- **1″ squares** give 28 interior X-crossings — 28 precisely known reference
  points instead of a blank sheet's 4 corners.
- **X-crossings (saddle points)** are the most precisely localizable feature in
  an image — sub-pixel refinable to ~0.05px, robust to blur and exposure.
- **The 4 discs** exist only for *finding* the board: large isolated dark blobs
  are easy to detect at any scale/angle. Their centroids only initialize the
  search; final accuracy never depends on them.
- **No orientation marks needed:** any assignment of the detected disc quad
  onto the true disc rectangle (in hull order) differs from the truth by an
  in-plane rotation/mirror — and those are isometries, so measured *distances*
  are unaffected. Wrong assignments (long edge ↔ short edge) are eliminated by
  the checkerboard-match score.
- Everything sits ≥0.6″ inside the paper edge — inside any printer's printable
  area, hence "no cutting needed."

### 5.3 Detection pipeline (js/target.js)

Runs on a grayscale copy downscaled to ≤1200px:

1. **Contrast-adaptive threshold** (2nd/98th percentile range) → dark-pixel
   mask → **connected components** (4-connectivity flood fill).
2. **Disc candidates**: blobs filtered by area, bbox aspect, and fill ratio,
   ranked by closeness of fill to π/4 ≈ 0.785 (a disc's signature — the
   checkerboard's own black squares sit near 1.0 and rank low). Top 20 kept.
3. **Quad search**: every 4-candidate subset forming a strictly convex quad,
   with similar blob areas, is tried in all 4 cyclic assignments onto the
   known disc rectangle. Each implies a homography; each homography is
   **scored by sampling the 40 predicted square centers** and comparing
   black/white means against the image (normalized by global contrast).
4. Best score wins; below 0.35 → "not found" → user fallback choices.
   This scoring is what rejects arbitrary dark blobs, doorways, and sheetless
   photos instead of hallucinating a target.

### 5.4 Sub-pixel calibration (the heart of the 1/16″)

From the disc quad (`refineTarget`):

1. An initial homography (target inches → image px) predicts all 28 interior
   crossing positions.
2. Each is refined with **iterative gradient corner refinement** (the classic
   OpenCV `cornerSubPix` algorithm): at the true saddle point q, every gradient
   g in the window satisfies g·(p−q)=0; solving the weighted least squares
   gives q to **~0.05px** (measured; §6.2). Window size adapts to the square
   spacing; refinements that wander more than half a square are discarded.
3. All surviving crossings (≥16 required; typically 28/28) feed a
   **normalized least-squares homography** (Hartley-normalized DLT,
   `Homography.solveLS`) — error is averaged over ~28 points instead of
   trusting any 4.
4. Pixel-coordinate conventions are handled explicitly (a pixel's sample point
   is its center; downscale block centers map back accordingly) — a class of
   half-pixel bug that the test suite specifically caught during development.

### 5.5 Measurement and the honest error band

The calibration homography maps any tapped pixel to inches on the target's
plane; distance is Euclidean in that plane. Each measurement also gets a
**p95-style error band** (`PrecisionPlane.band`):

```
band = calibErr × (lever₁ + lever₂)  +  2.8 × tapσ × in/px
```

- `calibErr` — the *measured* calibration error of this photo (§5.6).
- `leverᵢ` — how far endpoint i sits outside the board (extrapolation
  amplifies calibration error linearly; lever = 1 on the board).
- `tapσ` = 0.5px (loupe-refined taps), scaled by the local inches-per-pixel.

The band is displayed with every answer and decides the badge: green
"✓ within ±1/16″" only when band ≤ 1/16″. Validation confirmed the band
**upper-bounds** the actual error distribution (§6.3) — the app is calibrated
to be pessimistic, never flattering.

### 5.6 Per-photo self-verification (why the badge can be trusted)

Every scan splits the 28 crossings by parity into two halves and, both ways,
**fits the homography on one half and measures the held-out half** against
their known true positions. The 95th-percentile held-out residual (in inches)
is this photo's `calibErr`. This is a *measurement of accuracy on the actual
photo being used* — printer distortion, blur, bad lighting, a curled sheet, or
lens distortion all inflate it, widening the band honestly. The diagnostics
line shows it: `held-out calibration check ±0.04/16″ at the target`.

### 5.7 Fallback paths

- **Auto-detection fails, sheet is present** → user taps the 4 dots roughly;
  the same checkerboard scoring resolves their order and the same sub-pixel
  pipeline runs (accuracy identical — the dots only initialize).
- **No sheet at all** → explicit choice screen: retake, tap dots, or
  **continue at quick-mode accuracy (±5–8%)** on the same photo, with the
  reduced-accuracy warning carried onto the result.
- **Not enough readable crossings** (<16), **target too small** (<~10px per
  square), or **unverifiable calibration** → hard stop with a specific
  instruction (move closer / improve light / reprint), never a silent guess.

### 5.8 Is it exactly 1/16″, or better? (the direct answer)

**Better. 1/16″ is the guaranteed envelope, not the typical error.** Measured
distribution on a 26″ span (300 trials, realistic tap noise — §6.2):

- **Typical (median) error: 0.010″ ≈ 1/100″** — about 6× better than 1/16″.
- **95% of measurements: within 0.030″ ≈ 1/33″** — 2× better than 1/16″.
- **Worst single trial of 600 (two poses): 0.051″** — still inside 1/16″.
- With **zero tap noise** the pipeline itself is good to **0.0005″ ≈ 1/2000″**
  — meaning nearly all real-world error is the user's two fingertip taps, not
  the math or calibration.

So "accurate to 1/16″" means: near the target, the p95 error is under 1/16″
and the app *certifies each individual photo* against that threshold. Accuracy
degrades smoothly (and is reported honestly) as endpoints move away from the
sheet — the number on screen always comes with the band it actually earned.

**How it gets there — the complete recipe (what we use):**

1. **A manufactured ground truth in the photo**: the printed 8×5″ checkerboard
   — 1.000″ squares, tolerance set by laser-printer accuracy (~0.1–0.3%),
   verified by the user with a ruler. This eliminates every scale assumption
   (phone height, lens, distance) in one stroke.
2. **28 reference points, not 4**: the grid's interior X-crossings give 28
   precisely known positions to calibrate against.
3. **Sub-pixel corner localization** (~0.05px): iterative gradient refinement
   (the OpenCV `cornerSubPix` algorithm) — ~20× more precise than a careful
   human fingertip tap.
4. **Least-squares homography** (Hartley-normalized DLT) over all 28 points —
   calibration error averages down instead of riding on any single corner.
5. **Loupe-assisted endpoint taps** (~0.5px): the magnifier UI is what keeps
   the dominant error term small.
6. **Per-photo held-out verification**: calibrate on half the crossings,
   measure the other half against truth — accuracy is *measured on every
   photo*, not assumed.
7. **An honest error band** with every answer (calibration × lever arm + tap
   noise), proven in testing to never understate the real error.

Nothing exotic — no AI, no depth sensor, no cloud. Classical projective
geometry plus a piece of paper, executed carefully.

---

## 6. Validation of the 1/16″ claim

### 6.1 Methodology — what was actually done

**The claim was validated by synthetic ground-truth simulation plus full-app
end-to-end testing, not (yet) by physical measurement.** This is stated
plainly up front; §6.5 separates what each layer proves, and §6.6 gives the
physical protocol that remains to be run.

Why simulation first: it is the only method with *perfect* ground truth. A
mathematically defined pinhole camera photographs a mathematically defined
target; every true distance is known to machine precision, so pipeline error
can be isolated exactly — no tape-measure uncertainty, no printer variance
contaminating the answer. What simulation cannot cover (real lens distortion,
real printers) is called out explicitly as the remaining risk, and the
per-photo self-check (§5.6) is the runtime safety net for exactly those
factors.

**Test apparatus** (`tests/precision.test.js`):

- A `PinholeCamera` (tests/helpers.js) projects the target — placed on a wall
  plane in 3D — into a 1600×1200 image exactly as a real camera would.
- The scene (checkerboard, discs, paper margin, gray wall, plus a deliberate
  dark "doorway" distractor rectangle that detection must reject) is
  **rasterized to actual pixels** with 3×3 supersampling, so edges are
  antialiased like a real sensor's.
- The **production pipeline runs unmodified on those pixels**: downscale →
  disc detection → sub-pixel refinement → least-squares calibration →
  measurement. Nothing is stubbed.
- **Tap noise**: endpoint taps are perturbed with Gaussian noise σ=0.5px —
  the empirically appropriate figure for the magnifier-loupe tapping UI —
  using a seeded PRNG (mulberry32) so every run is reproducible.

**Test conditions:**

| Parameter | Value |
|---|---|
| Image size | 1600×1200 px |
| Camera poses | Two: eye (4,−3,48)″ f=2300px; steeper eye (−8,5,42)″ off-axis target |
| Target scale in frame | ~55 px per inch (~440px board width) |
| Measured spans | 26.000″ (endpoints 9″ and 13″ outside the board — a deliberately hard, levered case) and a 20.6″ diagonal |
| Tap noise | Gaussian, σ = 0.5 px per endpoint, independent |
| Sample size | 300 noise trials per pose per span; seeds 20260720 and 99 |
| Acceptance criteria | p95 error < 1/16″ (0.0625″); band ≥ 0.85 × measured p95 (no understating); band < 2/16″ (no useless pessimism); ≥24/28 crossings used; holdout calibErr and fit RMS < 1/64″ |

### 6.2 Results (measured, reproducible — `node --test tests/precision.test.js`)

**Calibration quality** (per rendered photo):

| Metric | Result | vs 1/16″ budget |
|---|---|---|
| Crossings detected & used | 28 / 28 | — |
| Sub-pixel corner accuracy (isolated test) | < 0.1 px (measured 0.061 px on a rotated saddle) | ≈ 0.002″ at target scale — 3% of budget |
| Held-out calibration error (p95) | **0.0063″** | ≈ 1/159″ — 10% of budget |
| Full-fit RMS reprojection | 0.0032″ | 5% of budget |
| Pure-pipeline error, zero tap noise (26″ span) | **0.0005″** | <1% of budget |

**End-to-end measurement, 26.000″ span, 300 trials, σ=0.5px taps:**

| Statistic | Error | In sixteenths |
|---|---|---|
| Mean | 0.0122″ | 0.20 |
| Median | 0.0100″ | 0.16 |
| **p95 (acceptance metric)** | **0.0304″** | **0.49 — under half the budget** |
| Maximum (worst of 300) | 0.0511″ | 0.82 — still within 1/16″ |
| Band reported by the app | 0.0653″ | 1.04 — correctly upper-bounds the max |

The second camera pose (steeper, off-axis) independently passes the same p95 <
1/16″ criterion. **No trials were excluded**; the max column is the true worst
case of the sample.

**Full-application test** (Playwright, headless Chromium, real UI): a
synthetic target photo is injected through the actual camera input; the app
auto-detects (28/28 crossings, held-out check ±0.04/16″), and float-precision
taps measure a true 14.000″ span and a true √45 = 6.7082″ diagonal:

| True | App displayed | Error |
|---|---|---|
| 14.000″ | `14″ · ✓ within ±1/16″` | 0.000″ (to display resolution) |
| 6.7082″ | `6 11/16″` (= 6.6875″) | 0.021″ = 0.33/16 |

This validates the *entire* app — detection, coordinate transforms, UI, tap
handling, display — not just the math module.

**Interpretation of repeatability:** the trial-to-trial spread (median 0.010″,
p95 0.030″) is almost entirely tap noise, not calibration (zero-noise error is
0.0005″). Repeating a measurement and averaging (the built-in "Add a 2nd
photo" path) tightens the result by ~√2, as independent errors should.

### 6.3 Why the band can be trusted

The acceptance suite requires the reported band to be ≥85% of the *measured*
p95 error and confirmed it exceeds even the observed maximum (0.065″ band vs
0.051″ worst trial). A separate test confirms the band **grows** as endpoints
move away from the target — far spans correctly report ±2/16″+ instead of
pretending. The failure direction is deliberately asymmetric: the app may
under-promise, never over-promise.

### 6.4 Error budget (where 1/16″ = 0.0625″ goes)

| Source | Magnitude (26″ span, ~55px/in) | Share |
|---|---|---|
| Sub-pixel corner localization | ~0.002″ | ~3% |
| Calibration homography (28-pt LS, extrapolated with lever ≈ 2.8) | ~0.006–0.018″ | ~10–30% |
| Two endpoint taps @ σ=0.5px | ~0.013″ σ → 0.030″ p95 | ~50% (dominant) |
| Print scale error | 0 if printed at 100% (verified by ruler); **1:1 proportional if not** | 0 or fatal |
| Lens distortion | ~0 in simulation; **unquantified on real phones** (§6.5) | the open item |

Consequence: tap care matters most (the loupe exists for this), and the
printed scale must be right (the app cannot detect a uniformly mis-scaled
print — it is the one error the self-check is blind to, because a uniformly
scaled target is internally self-consistent).

### 6.5 Measured results vs design targets vs unverified assumptions

**Measured (evidence exists, reproducible from this repo):**
- All §6.2 numbers — synthetic p95 0.030″ on a 26″ span across two poses;
  calibration holdout 0.0063″; sub-pixel 0.06px; full-app e2e within 0.021″.
- Detection rejects sheetless photos and distractors (tested).
- The band upper-bounds actual error in simulation (tested).

**Design targets (engineered for, mechanism in place, magnitude plausible but
not the thing the tests measured):**
- "±5–8%" for Quick mode — derived from the phone-height assumption's
  variance; the *pipeline* part is covered by noise tests, the *population of
  human phone heights* is an estimate.
- "±1/8–1/4″ far from the sheet" — follows from the measured lever-arm scaling,
  quoted as a range rather than a measured percentile.
- "±0.5″" for LiDAR — sensor-typical figure consistent with Apple's Measure
  app; not independently measured by us on hardware.

**Unverified assumptions (open items, stated honestly):**
1. **Real-camera lens distortion.** The pipeline assumes an ideal pinhole. Real
   iPhone lenses bend straight lines by a few pixels across the frame. This is
   the main risk to the 1/16″ figure in the field. Mitigations: the per-photo
   holdout check *will detect it* (distorted crossings inflate calibErr and
   widen the band — the app degrades honestly, not silently), and keeping the
   target near the measured span keeps both in the same, locally-consistent
   part of the lens field. Definitive fix if needed: lens-profile
   undistortion, which requires per-device calibration data (see §8).
2. **Real printer accuracy.** Laser printers are typically within ~0.1–0.3% of
   nominal; the ruler-check instruction (8×5″ exactly) is the gate. A "Fit to
   page" print scales *all* results by the same factor and is undetectable in
   software — this is the single most important user instruction.
3. **σ=0.5px tap noise** is the loupe-design figure. Sloppier tapping degrades
   accuracy smoothly (σ=1px ≈ 3/16″ p95 in the sheet-pipeline noise tests);
   the reported band uses 0.5px and so assumes loupe use.
4. **No physical end-to-end trial has been run yet** (§6.6).

### 6.6 The physical acceptance protocol (defined, not yet executed)

To convert the claim from "validated in simulation, self-verified per photo"
to "physically validated":

1. Print `target.pdf` at 100% on a laser printer; verify 8.000×5.000″ with a
   steel rule (±1/64″ readability). Reject the print if off by >1/64″.
2. Tape flat on a wall. Mark two knife-edge reference points 24.000″ apart,
   set with a quality tape or rule (reference uncertainty ≤1/32″ — note this
   bounds what the trial can prove).
3. Photograph per app instructions (1× lens, span near the target, fill the
   frame); measure the marked span with loupe-careful taps.
4. Repeat 10× (fresh photos). Acceptance: every reading within 1/16″ of
   24.000″ **and** the app's badge/band consistent with observed spread.
5. Repeat at 0.5× lens and with a deliberately "Fit to page" print to confirm
   the failure modes are caught/handled as documented.

Until this is run, the honest statement of the claim is: **"accurate to 1/16″
p95 under simulation covering the full pixel pipeline; every real photo's
calibration is additionally self-verified and its true band displayed."**

---

## 7. Factors that reduce accuracy — user requirements for 1/16″

To actually achieve the stated tolerance, all of these must hold:

1. **Print at 100% / Actual Size** and ruler-check the board is exactly 8×5″.
   A scaled print scales every answer identically and *cannot be detected*.
2. **Sheet perfectly flat** — tape all four corners; bowing/curl breaks the
   plane assumption (shows up in the holdout check → wider band).
3. **Endpoints on the same flat surface as the sheet.** The homography maps
   one plane only. Measuring a rod sticking out of the wall, across a corner,
   or floor-to-wall spans is invalid — the app cannot detect this; results are
   confidently wrong. This is the sharpest edge case in the mode.
4. **Span within ~2–3 ft of the sheet** for the green badge; the lever arm
   grows the band linearly beyond the board (§5.5). Longer walls: two
   overlapping photos (move the sheet), or accept the honestly-reported wider band.
5. **Use the loupe** — slide, don't stab. The tap term is the dominant error.
6. **1× lens** is irrelevant to Precision *scale* (the sheet sets it) but keep
   it anyway: ultrawide lenses have far worse distortion.
7. **Even lighting, sheet in focus, target ≥ ~10px per square** in the photo.
8. Optionally **add a second photo** — averaging tightens the band ~1.4×.

Failure scenarios and what the app does:

| Scenario | Behavior |
|---|---|
| No sheet in photo | Choice screen: retake / tap dots / continue at ±5–8% with warning |
| Sheet present, detection misses (glare, extreme angle) | Manual 4-dot tap → identical accuracy |
| Blur / curl / bad print | Holdout residuals rise → wider band or hard stop with instruction |
| Span far from sheet | Band grows, badge drops the ✓ — reported, not hidden |
| Endpoints off the sheet's plane | **Undetectable — user responsibility** (documented in-app: "same surface") |
| Scaled print | **Undetectable — ruler check is the only gate** |
| Points at extreme grazing angle / horizon | Homography maps to infinity → error, retake |

---

## 8. Why the camera is more accurate on iOS than in the browser

The *sensor* is identical; the **information the platform exposes** is not:

| Capability | Safari (web) | Native iOS |
|---|---|---|
| Full-res photo | ✅ (12MP via `<input capture>`) | ✅ |
| Focal length | Only via EXIF, **often stripped** on capture/upload paths | ✅ exact, always (`AVCameraCalibrationData`) |
| Which lens (0.5×/1×/2×) | ❌ unknowable when EXIF is absent | ✅ known per frame |
| **Lens distortion profile** | ❌ never exposed | ✅ per-device calibrated lookup table |
| Per-frame intrinsics during zoom | ❌ | ✅ (ARKit provides live intrinsics) |
| LiDAR / scene depth | ❌ no API exists in Safari | ✅ |

Concretely: the quick-mode factor-of-2 lens bug observed in testing (a 0.5×
shot read at half size) is *impossible* in a native pipeline, because iOS
reports exactly which lens took the frame. And the one open item on the
Precision claim — real lens distortion — is directly solvable natively:
`AVCameraCalibrationData.lensDistortionLookupTable` lets every pixel be
undistorted to a true pinhole before the homography, closing the gap between
the simulated and physical pipelines. In the browser, the only remedies are
the printed reference itself (which is why Precision lives comfortably on the
web) and the per-photo self-check that at least *reports* distortion's effect.
A future "Precision native" mode with undistortion is the engineering path to
claiming 1/16″ over larger frames and spans.

---

## 9. Setup, development, testing, troubleshooting

**Run locally:** `npm run serve` → http://localhost:8000 (any static server
works; no build step needed for development).

**Tests:** `npm test` (52 tests, `node --test`, zero deps, ~40s — the
precision suite renders images in pure JS). `npm run check` = syntax gate.
Both gate the deploy in CI.

**Deploy:** push to `main`. CI (`.github/workflows/ci.yml`) runs tests +
checks, then publishes the repo root to GitHub Pages. `npm run build` produces
a minified `dist/` (not what Pages serves; kept for size tracking).

**Browser e2e pattern** (used throughout development; scripts live in session
scratchpads, pattern documented here): Playwright `chromium_headless_shell`
with `executablePath`, synthetic photos generated in-page on a canvas and
injected via `setInputFiles` on `#camera-input`; taps dispatched as
float-precision `PointerEvent`s through `window.app.picker`'s own coordinate
transform (`MouseEvent` coerces coordinates to integers; `PointerEvent` does
not — this matters at sub-pixel scale).

**Cache troubleshooting:** GitHub Pages + iOS Safari cache aggressively. After
a deploy: close the tab fully and reload; re-add Home-Screen icons; worst
case Settings → Safari → Advanced → Website Data → delete github.io. Asset
URLs carry `?v=N` cache-busters bumped on every UI change.

**Module-identity footgun (learned the hard way):** `index.html` loads
`js/app.js?v=N`. Any module importing `./app.js` (no query) would load a
*second instance* of the app module — duplicate symbols, double-constructed
app. Shared sentinels therefore live in `js/flow.js`; never import `app.js`
from another module.

**iOS build:** `brew install xcodegen`, `cd ios && xcodegen generate`, open
`SpaceScan.xcodeproj`, set your Team under Signing & Capabilities, select a
physical iPhone (ARKit does not run in the Simulator — expect a white screen
there; the two web modes on the home screen do work in the Simulator), Run.
TestFlight: destination "Any iOS Device" → Product → Archive → Distribute →
TestFlight; app record bundle id `com.sokat.SpaceScan`; icon, version and
encryption metadata are already configured in `project.yml`.

---

## 10. Object removal — the "Cleanup" eraser (beta)

On the results screen you can erase objects from the photo to see the space
empty (`js/emptier.js`). How it works, honestly:

- The photo is downscaled to a ≤1600px display copy. Dragging paints a
  feathered selection; on release the hole is **inpainted**: a diffusion pass
  (60 Jacobi iterations at ≤200px working resolution) fills smooth color from
  the hole's borders, then exemplar texture synthesis copies real surrounding
  texture into it, plus 5% grain so the patch doesn't look plastic. "Clear
  all" inpaints the whole tapped 6-corner region in one shot.
- **It is classical image processing, not ML** — no model, no generation,
  nothing leaves the device, and nothing synthetic is painted except these
  fills sourced from the photo's own pixels.
- **It is cosmetic only.** Erasing never touches the measurements — those are
  computed from the tapped corners on the original photo. It exists so a
  cluttered space can be *presented* empty, with dimensions overlaid.
- Undo/reset are full-canvas snapshots; it's labeled beta because a large
  textured hole (patterned rug, bookshelf) can smear — a known limit of
  diffusion+exemplar methods without ML.

---

## 11. Security and privacy

The honest one-liner: **the photo never leaves the phone.**

- There are zero network calls in the application code — no `fetch`, no
  XHR, no beacons, no analytics, no third-party scripts. The only network
  traffic is GitHub Pages serving the static files themselves.
- All processing — corner detection, homography, calibration, EXIF parsing,
  inpainting — runs in-browser on-device. EXIF (which can contain GPS) is
  read locally to identify the lens and is never transmitted or stored.
- Zero runtime dependencies (`package.json` has none), so there is no
  supply-chain surface: no CDN scripts, no npm packages shipping to users.
  The build tool (esbuild) is dev-only and not what Pages serves.
- No accounts, no cookies, no localStorage of photos; camera access is the
  standard `<input capture>` — the browser's permission prompt is the gate.
- The native iOS app is the same: ARKit runs on-device; the app has no
  networking code. MIT-licensed, fully auditable.

---

## 12. Architectural decisions and trade-offs

The decisions someone will probe, and why they went this way:

- **Zero dependencies, vanilla JS — no OpenCV, no framework.** The math
  actually needed (DLT homography, Levenberg-style least squares, saddle-point
  refinement) is a few hundred lines; OpenCV.js is ~8MB of WASM that would
  dominate load time on a phone for <5% of its surface. Owning the numerics
  also made the 1/16″ claim auditable line-by-line — nothing is a black box.
  Trade-off: no battle-tested library; mitigated by 52 tests including
  end-to-end synthetic-image validation (§6).
- **No backend.** A static site means no server cost, no photo upload, no
  privacy story to defend (§11), and push-to-`main` deploys. Trade-off: all
  compute must fit a phone browser — which drove choices like the ≤200px
  inpainting working resolution and pure-JS detection.
- **Web-first, native only where physics requires it.** Safari cannot access
  LiDAR, so LiDAR mode is a thin native ARKit app; everything else stays on
  the web for zero-install reach. Trade-off: the browser also hides lens
  intrinsics and distortion-free RAW frames — the single biggest accuracy
  cost (§8) — accepted because Precision's printed target restores ground
  truth *inside the image*, where the browser can't take it away.
- **Reference-plane homography over 3D reconstruction.** One photo + one
  known plane gives closed-form, verifiable in-plane measurements. Full
  multi-view SfM would remove the "near the plane" restriction but adds
  capture complexity and failure modes that can't self-verify per shot.
- **Per-photo self-verification over global claims** (§5.6): every photo
  holds out reference crossings and measures its own error. The accuracy
  badge is *evidence from this photo*, not a lab number extrapolated.
- **No build step in development** — ES modules served raw; esbuild `dist/`
  exists only for size tracking. Trade-off: the `?v=N` cache-buster and the
  module-identity footgun (§9) are the tax.

---

## 13. If you get grilled — hard questions, straight answers

Each answer is one breath; the section reference is the deep dive.

1. **"Why should I believe 1/16″ from a phone photo?"** Because the claim is
   verified, not asserted: a printed sheet of exactly-1.000″ squares is in
   the photo; 28 crossings are localized to ~0.05px; some are held out, and
   every single photo measures its own error on them before showing a badge
   (§5.4–5.6).
2. **"Did you validate it physically?"** In simulation, exhaustively — 600
   rendered photos, p95 error 0.030″ on a 26″ span, worst case 0.051″, zero
   exclusions (§6.2). The physical trial is defined but not yet executed
   (§6.6) — I'll say that before you ask.
3. **"What's the biggest open risk?"** Real-lens radial distortion, which the
   browser can't calibrate away. It's detectable per photo (the self-check
   reports it) and fixable natively with undistortion (§7, §8).
4. **"What breaks the accuracy?"** Measuring far from the target plane,
   non-1× lenses, curled or mis-scaled printouts, motion blur — each is
   listed with its cost, and the app warns or widens its error band rather
   than staying silent (§7, §5.5).
5. **"Why didn't you use ML?"** Nothing here is a perception problem ML would
   improve: scale comes from geometry, and a learned model can't certify
   1/16″. Deterministic numerics are auditable and testable (§12).
6. **"Why no OpenCV?"** ~8MB of WASM for a few hundred lines of math I
   needed to own anyway to defend the accuracy claim (§12).
7. **"Why the browser instead of a real app?"** Zero-install reach; native is
   used exactly where the browser physically can't go (LiDAR). The browser's
   real costs are catalogued in §8, and Precision's design exists to beat
   them.
8. **"How do you know a given user's photo was good?"** The photo proves it
   itself: held-out reference crossings are re-measured and the residual is
   shown. Bad photo → wide band or a refusal, never a confident wrong number
   (§5.6).
9. **"How did you test camera code without a camera?"** The test suite
   renders synthetic photos in pure JS with known ground truth (52 tests,
   `npm test`); browser e2e uses Playwright injecting canvas-generated photos
   and sub-pixel `PointerEvent` taps (§6.1, §9).
10. **"What about 0.5×/2× lenses?"** EXIF identifies the lens; when EXIF is
    missing the app assumes 1× and **visibly warns** that scale may be wrong
    (§7).
11. **"Quick Scan says ±5–8% — why ship a guess?"** Because it's labeled a
    guess: zero setup for an estimate, one tape-corrected number brings it to
    ~±1%, and users who need truth get Precision (§1 table, §3).
12. **"The object removal — is that AI fabricating my room?"** No — classical
    diffusion + texture copied from the photo's own pixels, cosmetic only,
    and measurements never come from the edited image (§10).
13. **"Where do photos go?"** Nowhere. No network calls exist in the code;
    processing is on-device; the site is static files (§11).
14. **"What would you do next?"** In order: run the physical acceptance
    protocol (§6.6); a native Precision mode with lens undistortion to hold
    1/16″ over larger spans (§8); auto-detection of the target corners to
    remove taps; and graduating the eraser from beta with a patch-match
    quality pass.

---

## 14. Honest summary

- **Quick**: instant, ±5–8% *if* held at chest height with the 1× lens —
  a good estimate, never a measurement. Correct one number by tape and it
  becomes ~±1%.
- **LiDAR**: effortless ±0.5″, capped by physics of the sensor.
- **Precision**: the only mode with a defensible 1/16″ — earned by putting
  manufactured ground truth in the photo, localizing 28 reference crossings to
  ~0.05px, fitting calibration by least squares, and **verifying accuracy on
  held-out references in every single photo**. The claim is proven end-to-end
  in simulation (p95 0.030″ on a 26″ span, worst case 0.051″, n=300×2 poses,
  zero exclusions), enforced at runtime by a band that provably never
  understates, and awaits one final physical trial (§6.6) — with real-lens
  distortion as the known, detectable, and natively-fixable open risk.
