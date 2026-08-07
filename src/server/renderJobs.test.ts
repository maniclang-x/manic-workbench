import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreviewArguments, buildRenderArguments, parseProgressLine, RenderJobManager } from "./renderJobs.js";

describe("Manic process arguments", () => {
  it("builds preview arguments without creating an export", () => {
    expect(buildPreviewArguments("/safe/story.manic", { fps: 60, scale: 1, canvas: "portrait", cpuShaders: true }))
      .toEqual(["/safe/story.manic", "--fps", "60", "--scale", "1", "--canvas", "portrait", "--cpu-shaders"]);
  });

  it("builds a viewable GIF export without a shell command", () => {
    expect(buildRenderArguments("/safe/story.manic", "/safe/out", {
      format: "gif", fps: 30, scale: 0.75, canvas: "auto", cpuShaders: false, branded: false,
    })).toEqual(["/safe/story.manic", "--record", "/safe/out", "--fps", "30", "--scale", "0.75", "--gif", "--no-brand"]);
  });

  it("parses the Engine progress protocol without exposing it as a log", () => {
    expect(parseProgressLine('{"type":"manic.render.progress","phase":"rendering","frames_rendered":42,"total_frames":100,"percent":42}'))
      .toEqual({ phase: "rendering", framesRendered: 42, totalFrames: 100, percent: 42 });
    expect(parseProgressLine("ordinary Manic output")).toBeNull();
  });

  it("restores completed render history from the selected project", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-workbench-history-"));
    const id = "11111111-1111-4111-8111-111111111111";
    const directory = join(workspace, ".manic-output", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "out.mp4"), "video");
    await writeFile(join(directory, "job.json"), JSON.stringify({
      id, file: "story.manic", format: "mp4",
      options: { format: "mp4", fps: 60, scale: 1, canvas: "auto", cpuShaders: false, branded: true },
      status: "completed", startedAt: 1000, finishedAt: 2000, log: "ready", outputName: "out.mp4", frameCount: 60,
      progress: { phase: "complete", percent: 100, framesRendered: 60, totalFrames: 60, elapsedMs: 1000 },
    }));
    const history = await new RenderJobManager().history(workspace);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id, file: "story.manic", status: "completed", outputName: "out.mp4" });
  });
});
