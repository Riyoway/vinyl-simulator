# Vinyl Simulator — Legacy v1.0.0

Vinyl Simulator is an interactive 3D turntable that plays local audio through a
virtual vinyl record. The platter, record, tonearm, stylus, groove position,
and audio engine share the same physical state so the visual motion and sound
stay synchronized.

Live site: **[legacy.vinyl.riyo.me](https://legacy.vinyl.riyo.me/)**

> **This repository is the Legacy release line.**
> `v1.0.0` is the final feature release of this implementation line, and its
> history was collapsed into a single root commit. The code is kept as a working
> reference rather than an active project: new features go to the successor, and
> this repository stays maintenance only — fixes and corrections to what already
> shipped.
>
> `main` may therefore sit ahead of the `v1.0.0` tag. The tag is the release; use
> it if you want the tree exactly as it shipped.

## Features

- Interactive 3D turntable built with React Three Fiber and Three.js
- 33⅓ RPM and 45 RPM speed selection
- Start/stop motor control, pitch control, and independent speed trimmers
- Manual record handling, including stopping and reverse rotation
- Tonearm yaw and lift interaction
- Stylus contact and groove-region tracking
- Local audio loading with metadata and embedded artwork support
- Virtual groove generation with RIAA recording/playback curves
- Deterministic platter, groove, stylus, cartridge, surface, eccentricity,
  tonearm, motor wow/flutter, structure-borne rumble, mains hum, and stylus
  tracing models
- Record condition presets, wear, and manufacturing defect models, selectable
  from the info panel as cut, pressing, wear, output level, and condition
- PWA install support with offline caching of the application and turntable
  model
- Favicon, install icons, and Open Graph/social preview artwork

Audio files are processed locally in the browser. They are not uploaded to a
server.

## Development

Requirements: Node.js and npm.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Load an audio file with the file picker or
drag and drop it onto the page.

## Commands

```bash
npm run dev             # Start the Vite development server
npm run build           # Type-check and create the production/PWA build
npm run typecheck       # Type-check only, no emit
npm run lint            # Run Oxlint
npm run preview         # Preview the production build locally
npm run check:physics   # Deterministic self-check for the pure physics
npm run check:dsp       # Deterministic self-check for the DSP core
```

The production build generates a web app manifest and service worker through
`vite-plugin-pwa`. The turntable model and generated branding assets are
included in the precache so the app can be opened offline after the first
successful load.

### Verification

The physics and DSP models carry their own deterministic self-checks instead of
a test framework. `check:physics` covers the platter motor, pitch mapping, and
tonearm; `check:dsp` covers the groove cursor, RIAA round-trip, cartridge,
contact model, record conditions, and audio-clock parity. Both compile the pure
modules with `tsc` and run them on Node, so they assert on real numbers rather
than on mocks. Both pass on this release, along with `typecheck`, `lint`, and
`build`.

## Project structure

```text
src/
  app/                  Application shell, info panel, and track loading
  audio/                Audio context, deck bridge, and DSP engine
  components/deck/      Three.js turntable scene and controls
  interaction/          Pointer and drag interaction handling
  model/                GLB manifest and scene-node resolution
  physics/              Pure platter, pitch, groove, and tonearm models
  store/                Deck state store
  styles/               Global styles
public/
  models/               Turntable GLB and node manifest
  *.png                 Favicon, PWA, and Apple touch icons
blender/                Turntable model sources, references, and textures
```

The audio engine keeps the rotation and playback position on the audio clock.
The React/Three.js layer receives telemetry for interaction and rendering.

## Scope

The turntable interaction and the audio engine described above are implemented
and shipped in `v1.0.0`. Work that was once planned for this line — additional
record defects, airborne motor noise, record libraries, persistence, and
accessibility improvements — is not part of this release and will not be added
here. See [CHANGELOG.md](CHANGELOG.md) for what `v1.0.0` contains.

## License

The source code in this repository is licensed under the MIT License. See
[LICENSE](LICENSE).

The following assets are not covered by the MIT License:

- 3D models
- Textures
- Images, icons, and logos
- Other visual assets

These assets are Copyright © 2026 Riyoway.
All rights reserved. They may not be copied, modified, redistributed,
or used commercially without explicit permission. See `assets/LICENSE` and
`blender/LICENSE`.
