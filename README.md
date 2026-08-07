# Manic Workbench

Manic Workbench is the local companion for creating with an installed
[Manic Engine](https://github.com/maniclang-x/manic). It gives you a focused
browser UI for editing `.manic` files, previewing, rendering, and optional AI
drafting — while the engine, licensing, and export accounting stay inside the
native `manic` executable.

## Requirements

- Node.js 22 or newer
- Manic Engine (install from Workbench **Settings**, or see [INSTALL.md](https://github.com/maniclang-x/manic/blob/main/INSTALL.md))
- FFmpeg on `PATH` for MP4/GIF export (Homebrew’s Manic cask installs it on macOS)

## Run

When the npm package is published:

```bash
npx @maniclang/workbench
```

Until then, from this repository:

```bash
npm install
npm run build
npm start
```

With no project path, Workbench opens the bundled `examples/` catalogue (all
sample `.manic` stories). Pass another folder to work on your own project:

```bash
npm start -- /path/to/your/manic-project
npm run dev -- /path/to/your/manic-project
```

Development (rebuilds the UI while the server runs):

```bash
npm install
npm run dev
```

Use a specific Manic binary when it is not on `PATH`:

```bash
npm start -- --manic /path/to/manic
```

Workbench opens a loopback-only local URL (with a session token). Use
**Open folder…** to switch projects without restarting.

## What you can do

- **Files** — browse, create, rename, duplicate, and delete `.manic` stories;
  edit in Monaco with syntax help, diagnostics, and autosave
- **Preview** — launch the native Manic preview for the active file
- **Render** — MP4, animated GIF, or PNG frames with live progress, history,
  and playback under the project’s `.manic-output` folder
- **Settings** — Manic executable path, `MANIC_*` environment variables
  (for example `MANIC_ASSETS_DIR` for archive installs), install Manic when
  missing (official installer or Homebrew), release channel, preview defaults,
  AI providers
- **AI** — optional OpenAI or Anthropic drafting with local API keys, live
  progress, cancel, diff-before-apply, `manic check`, and document-centric
  create/refine threads

Nothing leaves your machine unless you configure an AI provider. Preview and
render never start from AI automatically.

## AI setup (optional)

1. Open **Settings**
2. Enable OpenAI or Anthropic, pick a model (and reasoning for OpenAI)
3. Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the key/value table (or export
   the matching environment variable before launch)
4. Open **AI**, describe a story, review the diff, then Apply

Connectivity smoke tests (do not commit keys):

```bash
OPENAI_API_KEY=… node scripts/smoke-openai.mjs gpt-5.6-sol none
ANTHROPIC_API_KEY=… node scripts/smoke-anthropic.mjs claude-sonnet-5
```

## Product boundary

| Product | Responsibility |
|---|---|
| Manic Engine | Language, renderer, CLI, licensing |
| Manic Workbench | Local editor and Engine controller |
| Manic Studio | Future managed cloud creation |
| Manic AI | Future managed generation service |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Before a PR:

```bash
npm run typecheck
npm test
npm run build
npm run pack:check
```

## Publishing

`@maniclang/workbench` is not published until a public licence is added to this
repository.

## Community

- X: [@anish2good](https://x.com/anish2good)
- Reddit: [r/maniclang](https://www.reddit.com/r/maniclang/)
