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

## Publishing to npm

Maintainers release `@maniclang/workbench` with:

```bash
npm version patch   # skip if package.json already has an unpublished version
npm run release -- --otp=XXXXXX
```

`npm run release` refuses to overwrite an existing version, runs typecheck /
tests / build / pack, then `npm publish --access public`. Pass the 2FA code via
`--otp=` or `NPM_OTP`.
