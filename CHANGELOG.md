# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-08

Final release of the Legacy implementation line, published at
[legacy.vinyl.riyo.me](https://legacy.vinyl.riyo.me/).

This release is a single root commit. The development history that preceded it
was collapsed, so the entries below describe the shipped tree as a whole rather
than a diff against an earlier tag. There is no `0.x` series to compare against.

### Turntable and interaction

- Interactive 3D turntable rendered with React Three Fiber and Three.js, loaded
  from a single GLB with a node manifest as the reference for scene lookups.
- 33⅓ RPM and 45 RPM speed selection, start/stop motor control, pitch control,
  and independent per-speed trimmers.
- Manual record handling: holding, slowing, releasing, and reverse rotation.
- Tonearm yaw and lift interaction with stylus contact and groove-region
  tracking.
- Pointer and drag interaction layer for the modelled controls.

### Audio engine

- Groove-position playback model: disc angle drives a cursor over a virtual
  groove, and the cursor's speed — not a playback rate — produces the output
  voltage. Reverse play, stops, scratching, pitch change, and inner-groove
  distortion follow from that single rule.
- `AudioWorkletProcessor` as the source of truth. Angular velocity, disc angle,
  and groove cursor are integrated on the audio clock; the main thread only
  sends input and the render layer only draws telemetry.
- Virtual groove cutting with RIAA recording and playback curves, cut layout,
  cutter-head and manufacturing models, and resampling.
- Cartridge, stylus, stylus-tip, and contact models; disc shape and eccentricity;
  surface noise; structure-borne rumble; mains hum; level metering and a safety
  limiter.
- Local audio loading with metadata and embedded artwork, processed entirely in
  the browser.

### Physics

- Pure, deterministic platter motor, pitch mapping, groove geometry, and tonearm
  models, kept free of rendering and audio concerns.
- Motor wow, flutter, and commutation ripple, with wow and flutter as functions
  of time and ripple as a function of angle.

### Record condition

- Condition presets — clean, used, dusty, worn stylus, warped, and poor
  grounding — where clean is a bit-exact bypass.
- Per-file deterministic disc seeding, so the same file always yields the same
  defects and a different file does not.
- Click-free switching between conditions during playback.

### Application and delivery

- Application shell with an info panel, track loader, and scene error boundary.
- PWA install support with offline precaching of the application and the
  turntable model.
- Favicon, install icons, Apple touch icon, and Open Graph/social preview
  metadata.
- Canonical URL and social metadata pointing at `legacy.vinyl.riyo.me`.

### Verification

- Deterministic self-checks for the physics (`npm run check:physics`) and the
  DSP core (`npm run check:dsp`), compiled with `tsc` and run on Node without a
  test framework.
- Offline load measurement for the DSP core, recorded separately from the audio
  path so that measuring never altered the models.
- `typecheck`, `lint`, `build`, `check:physics`, and `check:dsp` all pass on this
  release.

### Licensing

- Source code released under the MIT License.
- 3D models, textures, images, icons, and other visual assets excluded from the
  MIT grant and reserved, with per-directory notices in `assets/LICENSE` and
  `blender/LICENSE`.

[1.0.0]: https://github.com/riyoway/vinyl-simulator/releases/tag/v1.0.0
