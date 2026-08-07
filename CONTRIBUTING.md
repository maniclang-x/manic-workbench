# Contributing to Manic Workbench

Manic Workbench is the public interface around the separately installed Manic
Engine. Changes must preserve that boundary: do not copy private engine code,
bypass engine licensing, or reimplement export accounting in this repository.

## Local checks

Use Node.js 22 or newer, then run:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run pack:check
```

Keep the server bound to loopback, constrain all file operations to the chosen
workspace, avoid shell command construction, and never expose provider secrets
to browser state or project files.

## Scope

Prefer small changes that complete one product contract at a time. New Engine
integrations should consume stable structured CLI output rather than parsing
human-readable terminal text.

The repository licence is still awaiting selection. Contributions should not
be published or redistributed until that licence is added.
