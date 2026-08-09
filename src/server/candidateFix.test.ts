import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCandidateFixer, createWasmFix, type CandidateFixArgs } from "./candidateFix.js";
import { defaultSettings } from "./settings.js";

// The real bundled WASM language service, loaded in Node the same way the
// server does at runtime (clientRoot/wasm/manic_lang.js).
const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "public");

function fixArgs(content: string): CandidateFixArgs {
  return { workspace: "/unused", content, settings: defaultSettings };
}

describe("candidate autofix", () => {
  it("fixes a bare-LaTeX slip through the bundled WASM autofixer", async () => {
    const wasmFix = createWasmFix(clientRoot);
    const broken = 'title("Test");\ncanvas("16:9");\nequation(q,(100,200),\\frac{1}{2});\n';
    const result = await wasmFix(broken);
    expect(result).not.toBeNull();
    expect(result?.via).toBe("wasm");
    expect(result?.fixed).toBeGreaterThan(0);
    expect(result?.code).toContain("`\\frac{1}{2}`");
  });

  it("leaves clean source untouched", async () => {
    const wasmFix = createWasmFix(clientRoot);
    const clean = 'title("Ok");\ncanvas("16:9");\n';
    const result = await wasmFix(clean);
    expect(result?.code).toBe(clean);
    expect(result?.fixed).toBe(0);
  });

  it("prefers the engine binary and falls back to WASM when it is unavailable", async () => {
    const viaEngine = createCandidateFixer(clientRoot, async (args) => ({ code: args.content, fixed: 0, via: "engine" }));
    const engineResult = await viaEngine(fixArgs("anything"));
    expect(engineResult?.via).toBe("engine");

    const engineMissing = createCandidateFixer(clientRoot, async () => null);
    const fallback = await engineMissing(fixArgs('title("Ok");\ncanvas("16:9");\n'));
    expect(fallback?.via).toBe("wasm");
  });
});
