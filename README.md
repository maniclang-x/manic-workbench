# Manic Workbench

Manic Workbench is the public, local-first interface for creating with an
installed Manic Engine.

It will provide a Monaco-based editor, multi-file projects, Manic settings,
native preview controls, licensed export controls, version and update
information, and bring-your-own-key OpenAI or Anthropic assistance.

The Workbench does not contain, reproduce, or bypass the private Manic Engine.
It invokes the installed `manic` command through a stable machine-readable CLI
contract. Engine licensing, preview accounting, and export authorization remain
owned by the Manic executable.

## Intended distribution

```bash
npx @maniclang/workbench
```

The package starts a loopback-only local server, opens the user's browser, and
works within an explicitly selected project directory.

## Product boundary

| Product | Responsibility |
|---|---|
| Manic Engine | Private compiled language, renderer, CLI, and licensing enforcement |
| Manic Workbench | Public local editor and Engine controller |
| Manic Studio | Future managed cloud creation platform |
| Manic AI | Future managed generation and repair service |

The detailed implementation plan is in [PLAN.md](PLAN.md).

