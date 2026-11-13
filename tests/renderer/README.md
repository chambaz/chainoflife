# Renderer fixture

This isolated fixture tests deck.gl and luma.gl behavior with a small synthetic
world. It retains its own implementation and lockfile so dependency-level failures
can be reproduced without the app, wallet, or indexer.

Its 14 unit tests cover tile selection, parent fallback, clipping, and hysteresis.
Its five Chromium probes check integer texture sampling, exact-cell decoding,
GPU resource release, digest isolation, partial-edge pixels, and controller bounds.

The app's tests cover production rendering, snapshot transitions, network failures,
wallet recovery, and responsive controls. Some tile and camera checks overlap.
The direct texture and resource-lifecycle probes remain useful independent checks;
this fixture does not establish production renderer correctness by itself.

Run from this directory:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:chromium
```

`CHROMIUM_PATH` overrides `/usr/bin/chromium`.
