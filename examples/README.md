# Manic examples

This directory is the default Workbench project when you run `npm start` or
`npm run dev` with no path. It contains the public catalogue of Manic source
examples: creator shorts, mathematics, geometry, physics, machine learning,
motion graphics, reactive explanations, systems diagrams, 2D, and 3D.

Open Workbench on these samples:

```sh
npm start
# or
npm run dev
```

The Files sidebar lists every `.manic` story here. Open one to edit, preview,
or render.

Run an example directly with the Manic Engine after installing it:

```sh
manic examples/reactive-math-notation.manic
```

Check it without opening a preview window:

```sh
manic check examples/reactive-math-notation.manic
```

Examples that reference `asset:` resources use the assets bundled with the
official Manic installation. In Workbench Settings, set `MANIC_ASSETS_DIR` if
you are using an extracted archive (auto-filled from `…/bin/manic`).

Documentation: [docs.maniclang.com](https://docs.maniclang.com/).
