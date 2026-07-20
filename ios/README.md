# SpaceScan iOS (LiDAR)

Native Swift companion to the web app. Same zero-input idea, but the
LiDAR sensor replaces the photo pipeline: aim the crosshair, tap **+**
four times (floor → ceiling, left edge → right edge), read the answer.
Accuracy is about ±0.5″ with LiDAR versus the web app's ±8% band.

```
crosshair raycast (60 fps, against the LiDAR scene mesh)
  → mark floor, mark ceiling  = height
  → mark left,  mark right    = width
  → result card (inches + cm), undo at any step
```

## Build & run

Requires Xcode and a real device (ARKit does not run in the simulator).
LiDAR iPhones (12 Pro and later Pro models) get mesh-raycast accuracy;
other iPhones still work via estimated planes with a reduced-accuracy
banner.

```sh
brew install xcodegen   # once
cd ios
xcodegen generate
open SpaceScan.xcodeproj
```

In Xcode: select your team under Signing & Capabilities, pick your
iPhone as the destination, and Run.

The `.xcodeproj` is generated from `project.yml` and not committed;
source lives in `Sources/`.
