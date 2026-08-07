import { describe, expect, it } from "vitest";
import { runEngineCheck } from "./engineCheck.js";
import { defaultSettings } from "./settings.js";

describe("native Manic checking", () => {
  it("returns the Engine output and exit code without a shell", async () => {
    const result = await runEngineCheck(process.cwd(), "story.manic", defaultSettings, process.execPath);
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });
});
