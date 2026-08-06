# Manic Workbench plan

## Product contract

Manic Workbench is a public, local-first client. It edits `.manic` projects and
orchestrates the separately installed Manic Engine. It is not the future Manic
Studio cloud product.

Repository: `maniclang-x/manic-workbench`

npm package: `@maniclang/workbench`

Launch command:

```bash
npx @maniclang/workbench [project-directory]
```

## Architecture

```text
browser UI
  -> loopback-only Workbench server
       -> selected project files
       -> installed manic executable
       -> OpenAI or Anthropic, only when configured by the user
```

Recommended stack:

- TypeScript;
- Vite and React;
- Monaco Editor;
- Hono running on Node.js;
- provider adapters for OpenAI and Anthropic;
- local JSON configuration, with no database in V1.

## V1 capabilities

### Projects and editing

- open one explicit workspace directory;
- browse, create, rename, duplicate, and delete `.manic` files;
- edit several files in Monaco tabs;
- autosave, dirty markers, and external-change detection;
- Manic syntax highlighting and catalogue-driven completion;
- inline diagnostics from structured `manic check` output;
- stage and entity outline where supported by the Engine.

### Manic settings

- installed executable path;
- canvas and template defaults;
- preview FPS, scale, stage, and CPU-shader options;
- export FPS, format, output, canvas, scale, stage, and time range;
- branded or unbranded export selection, subject to Engine entitlement;
- update channel and update-check preference;
- AI provider, model, base URL, and context policy.

Settings precedence:

```text
explicit run/export options
  -> project settings
  -> user settings
  -> Manic defaults
```

Secrets never belong in project settings or `.manic` source.

### Preview and export

V1 launches the native Manic preview. It must not create a temporary licensed
video merely to show an animation inside the browser.

Exports are jobs with progress, cancellation, output validation, and an
open-output action. Workbench passes typed arguments to Manic with `shell:
false`; Manic remains the sole licensing and metering authority.

An embedded browser preview is a later capability that requires a supported
Engine preview-server protocol.

### AI assistance

- bring-your-own OpenAI or Anthropic key;
- send only user-approved files and context;
- show proposed changes as a diff;
- require approval before applying changes;
- run `manic check` after accepted edits;
- return structured diagnostics for bounded repair attempts;
- never export or delete files without explicit approval.

Provider credentials stay in the local server process and are never delivered
to browser JavaScript.

### Versions and updates

Display separately:

- Manic Workbench version;
- installed Manic Engine version;
- configured release channel;
- latest available Engine version;
- Engine installation method;
- FFmpeg availability and version;
- asset installation status;
- Manic account/licence status.

Update notifications are cached, non-blocking, optional, and never consume a
preview or export allowance.

## Required Engine CLI contract

Workbench should consume stable JSON rather than parse human-readable output:

```bash
manic version --json
manic status --json
manic capabilities --json
manic check FILE.manic --json
manic stages FILE.manic --json
manic render FILE.manic --json-progress
```

`manic capabilities --json` lets Workbench hide controls unsupported by an
older Engine instead of failing or guessing.

## Local security boundary

- bind only to `127.0.0.1` on a random available port;
- generate a fresh session token for the browser URL;
- validate Origin and session token on every mutation;
- canonicalize and constrain paths to the selected workspace;
- reject traversal and escaping symlinks;
- spawn only known Manic commands using argument arrays and `shell: false`;
- require confirmation for deletion and other destructive operations;
- keep API keys out of browser state, logs, projects, and source files;
- disable telemetry by default.

## Delivery phases

1. **Foundation** — npm launcher, loopback server, browser shell, settings,
   Engine discovery, and version display.
2. **Editor** — project tree, Monaco tabs, syntax support, completion, checking,
   and diagnostics.
3. **Preview and export** — typed controls, native preview, export jobs,
   progress, cancellation, branding, and output handling.
4. **AI** — OpenAI and Anthropic adapters with diff, approval, check, and bounded
   repair workflow.
5. **Polish** — templates, recent projects, update notifications, recovery, and
   the future embedded-preview protocol.

## Repository bootstrap

After attaching the standalone public Git repository, implementation should
add its licence, contribution policy, package metadata, tests, and CI before
publishing the npm package name.

