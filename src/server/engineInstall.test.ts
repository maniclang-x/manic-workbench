import { describe, expect, it } from "vitest";
import { getEngineInstallPlan } from "./engineInstall.js";
import { candidateManicPaths, defaultBinaryPath } from "./enginePaths.js";

describe("engine install plan", () => {
  it("exposes a platform-appropriate installer and docs", async () => {
    const plan = await getEngineInstallPlan("latest");
    expect(plan.docsUrl).toContain("INSTALL.md");
    expect(plan.releasesUrl).toContain("releases");
    expect(plan.manualCommand.length).toBeGreaterThan(10);
    expect(plan.defaultBinaryHint).toBe(defaultBinaryPath());
    expect(plan.methods.length).toBeGreaterThan(0);
    expect(plan.methods.some((method) => method.id === "script")).toBe(true);
  });

  it("lists well-known Manic binary locations for discovery", () => {
    const paths = candidateManicPaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((path) => path.includes("manic"))).toBe(true);
  });
});
