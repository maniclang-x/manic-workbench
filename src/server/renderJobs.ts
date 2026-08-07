import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WorkbenchSettings } from "./settings.js";
import { buildManicEnv } from "./manicEnv.js";

export type RenderFormat = "mp4" | "gif" | "png";
export type RenderStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RenderOptions {
  format: RenderFormat;
  fps: number;
  scale: number;
  canvas: WorkbenchSettings["preview"]["canvas"];
  cpuShaders: boolean;
  branded: boolean;
}

export interface RenderProgress {
  phase: "preparing" | "rendering" | "encoding" | "complete" | "failed" | "cancelled";
  percent: number | null;
  framesRendered: number | null;
  totalFrames: number | null;
  elapsedMs: number;
}

export interface RenderJobView {
  id: string;
  file: string;
  format: RenderFormat;
  options: RenderOptions;
  status: RenderStatus;
  startedAt: number;
  finishedAt: number | null;
  log: string;
  outputName: string | null;
  frameCount: number | null;
  progress: RenderProgress;
}

interface RenderJob extends RenderJobView {
  workspace: string;
  outputDirectory: string;
  outputPath: string | null;
  process: ChildProcess | null;
  progressBuffer: string;
}

export class RenderJobManager {
  private readonly jobs = new Map<string, RenderJob>();
  private readonly restoredWorkspaces = new Set<string>();

  constructor(private readonly engineOverride = "") {}

  async launchPreview(workspace: string, file: string, settings: WorkbenchSettings): Promise<void> {
    const command = this.engineOverride || settings.enginePath || process.env.MANIC_BIN || "manic";
    const child = spawn(command, buildPreviewArguments(file, settings.preview), {
      shell: false, detached: false, stdio: "ignore", cwd: workspace,
      env: buildManicEnv(settings),
    });
    await new Promise<void>((resolveStarted, rejectStarted) => {
      child.once("spawn", () => { child.unref(); resolveStarted(); });
      child.once("error", rejectStarted);
    });
  }

  async start(workspace: string, file: string, displayPath: string, settings: WorkbenchSettings, input: unknown): Promise<RenderJobView> {
    await this.restore(workspace);
    if ([...this.jobs.values()].some((job) => job.workspace === workspace && (job.status === "running" || job.status === "queued"))) {
      throw new Error("Finish or cancel the current render before starting another one.");
    }
    const options = validateRenderOptions(input, settings);
    const id = randomUUID();
    const outputDirectory = join(workspace, ".manic-output", id);
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const job: RenderJob = {
      id, file: displayPath, format: options.format, options, status: "queued", startedAt: Date.now(), finishedAt: null,
      log: "Preparing render…", outputName: null, frameCount: null,
      progress: { phase: "preparing", percent: 0, framesRendered: 0, totalFrames: null, elapsedMs: 0 },
      workspace, outputDirectory, outputPath: null, process: null, progressBuffer: "",
    };
    this.jobs.set(id, job);
    await this.persist(job);

    const command = this.engineOverride || settings.enginePath || process.env.MANIC_BIN || "manic";
    const child = spawn(command, buildRenderArguments(file, outputDirectory, options), {
      shell: false, stdio: ["ignore", "pipe", "pipe"], cwd: workspace,
      env: buildManicEnv(settings, { MANIC_PROGRESS: "json" }),
    });
    job.process = child;
    job.status = "running";
    job.progress.phase = "rendering";
    job.log = "Rendering with Manic…";
    child.stdout.on("data", (chunk: Buffer) => consumeOutput(job, chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => consumeOutput(job, chunk.toString("utf8")));
    child.once("error", (error) => {
      job.status = "failed"; job.finishedAt = Date.now(); job.progress.phase = "failed"; appendLog(job, error.message); void this.persist(job);
    });
    child.once("close", (code, signal) => void this.finish(job, code, signal));
    return publicJob(job);
  }

  async history(workspace: string): Promise<RenderJobView[]> {
    await this.restore(workspace);
    return [...this.jobs.values()].filter((job) => job.workspace === workspace)
      .sort((left, right) => right.startedAt - left.startedAt).map(publicJob);
  }

  async get(workspace: string, id: string): Promise<RenderJobView> {
    await this.restore(workspace);
    return publicJob(this.require(workspace, id));
  }

  async output(workspace: string, id: string): Promise<{ path: string; name: string; format: RenderFormat }> {
    await this.restore(workspace);
    const job = this.require(workspace, id);
    if (job.status !== "completed" || !job.outputPath || !job.outputName) throw new Error("The render output is not ready.");
    return { path: job.outputPath, name: job.outputName, format: job.format };
  }

  async cancel(workspace: string, id: string): Promise<RenderJobView> {
    await this.restore(workspace);
    const job = this.require(workspace, id);
    if (job.status === "running" || job.status === "queued") {
      job.status = "cancelled"; job.finishedAt = Date.now(); job.progress.phase = "cancelled"; appendLog(job, "Render cancelled.");
      job.process?.kill("SIGTERM");
      await this.persist(job);
    }
    return publicJob(job);
  }

  private require(workspace: string, id: string): RenderJob {
    const job = this.jobs.get(id);
    if (!job || job.workspace !== workspace) throw new Error("Render job was not found.");
    return job;
  }

  private async finish(job: RenderJob, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    job.process = null;
    flushOutput(job);
    if (job.status === "cancelled") return;
    job.finishedAt = Date.now();
    if (code !== 0) {
      job.status = "failed"; job.progress.phase = "failed";
      appendLog(job, `Manic exited ${signal ? `after ${signal}` : `with code ${code ?? "unknown"}`}.`);
      await this.persist(job); return;
    }
    const entries = await readdir(job.outputDirectory).catch(() => [] as string[]);
    const preferred = job.format === "mp4" ? "out.mp4" : job.format === "gif" ? "out.gif" : entries.filter((name) => /^frame_\d+\.png$/u.test(name)).sort()[0];
    if (!preferred) {
      job.status = "failed"; job.progress.phase = "failed"; appendLog(job, "Manic completed but no expected output was found."); await this.persist(job); return;
    }
    const outputPath = join(job.outputDirectory, preferred);
    if (!(await stat(outputPath).catch(() => null))?.isFile()) {
      job.status = "failed"; job.progress.phase = "failed"; appendLog(job, "The render output could not be opened."); await this.persist(job); return;
    }
    job.status = "completed"; job.outputName = preferred; job.outputPath = outputPath;
    job.frameCount = job.format === "png" ? entries.filter((name) => /^frame_\d+\.png$/u.test(name)).length : job.progress.totalFrames;
    job.progress.phase = "complete"; job.progress.percent = 100;
    if (job.progress.totalFrames !== null) job.progress.framesRendered = job.progress.totalFrames;
    appendLog(job, job.format === "png" ? `${job.frameCount} PNG frames are ready.` : `${preferred} is ready.`);
    await this.persist(job);
  }

  private async persist(job: RenderJob): Promise<void> {
    job.progress.elapsedMs = (job.finishedAt ?? Date.now()) - job.startedAt;
    const target = join(job.outputDirectory, "job.json");
    const temporary = join(job.outputDirectory, `.job-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(publicJob(job), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private async restore(workspace: string): Promise<void> {
    if (this.restoredWorkspaces.has(workspace)) return;
    this.restoredWorkspaces.add(workspace);
    const root = join(workspace, ".manic-output");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/u.test(entry.name)) continue;
      const outputDirectory = join(root, entry.name);
      try {
        const raw = JSON.parse(await readFile(join(outputDirectory, "job.json"), "utf8")) as unknown;
        const view = validateStoredJob(raw, entry.name);
        const restoredStatus = view.status;
        if (view.status === "running" || view.status === "queued") {
          view.status = "failed"; view.finishedAt = Date.now(); view.progress.phase = "failed";
          view.log = `${view.log}\nWorkbench restarted before this render completed.`.trim();
        }
        const outputPath = view.outputName ? join(outputDirectory, view.outputName) : null;
        if (view.status === "completed" && (!outputPath || !(await stat(outputPath).catch(() => null))?.isFile())) {
          view.status = "failed"; view.progress.phase = "failed";
          view.log = `${view.log}\nThe recorded output is no longer present.`.trim();
        }
        const job: RenderJob = { ...view, workspace, outputDirectory, outputPath, process: null, progressBuffer: "" };
        this.jobs.set(job.id, job);
        if (restoredStatus !== view.status) await this.persist(job);
      } catch { /* Ignore incomplete or user-created output folders. */ }
    }
  }
}

export function buildPreviewArguments(file: string, preview: WorkbenchSettings["preview"]): string[] {
  const arguments_ = [file, "--fps", String(preview.fps), "--scale", String(preview.scale)];
  if (preview.canvas !== "auto") arguments_.push("--canvas", preview.canvas);
  if (preview.cpuShaders) arguments_.push("--cpu-shaders");
  return arguments_;
}

export function buildRenderArguments(file: string, outputDirectory: string, options: RenderOptions): string[] {
  const arguments_ = [file, "--record", outputDirectory, "--fps", String(options.fps), "--scale", String(options.scale)];
  if (options.canvas !== "auto") arguments_.push("--canvas", options.canvas);
  if (options.format === "gif") arguments_.push("--gif");
  if (options.format === "png") arguments_.push("--png");
  if (options.cpuShaders) arguments_.push("--cpu-shaders");
  if (!options.branded) arguments_.push("--no-brand");
  return arguments_;
}

function validateRenderOptions(input: unknown, settings: WorkbenchSettings): RenderOptions {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const format = value.format ?? "mp4";
  if (format !== "mp4" && format !== "gif" && format !== "png") throw new Error("format must be mp4, gif, or png.");
  const fps = value.fps ?? settings.preview.fps;
  const scale = value.scale ?? settings.preview.scale;
  const canvas = value.canvas ?? settings.preview.canvas;
  if (typeof fps !== "number" || !Number.isInteger(fps) || fps < 1 || fps > 240) throw new Error("fps must be between 1 and 240.");
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.1 || scale > 8) throw new Error("scale must be between 0.1 and 8.");
  if (!["auto", "portrait", "feed", "square", "landscape"].includes(String(canvas))) throw new Error("canvas is not supported.");
  return { format, fps, scale, canvas: canvas as RenderOptions["canvas"], cpuShaders: value.cpuShaders === true, branded: value.branded !== false };
}

function consumeOutput(job: RenderJob, value: string): void {
  job.progressBuffer += value;
  const lines = job.progressBuffer.split(/\r?\n/u);
  job.progressBuffer = lines.pop() ?? "";
  for (const line of lines) consumeLine(job, line);
}

function flushOutput(job: RenderJob): void {
  if (job.progressBuffer) consumeLine(job, job.progressBuffer);
  job.progressBuffer = "";
}

function consumeLine(job: RenderJob, line: string): void {
  const progress = parseProgressLine(line);
  if (!progress) { if (line.trim()) appendLog(job, line); return; }
  job.progress.phase = progress.phase;
  job.progress.percent = progress.percent;
  job.progress.framesRendered = progress.framesRendered;
  job.progress.totalFrames = progress.totalFrames;
  job.progress.elapsedMs = Date.now() - job.startedAt;
}

export function parseProgressLine(line: string): Omit<RenderProgress, "elapsedMs"> | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type !== "manic.render.progress") return null;
    const phase = value.phase;
    if (phase !== "rendering" && phase !== "encoding" && phase !== "complete") return null;
    if (typeof value.frames_rendered !== "number" || typeof value.total_frames !== "number" || typeof value.percent !== "number") return null;
    return { phase, framesRendered: value.frames_rendered, totalFrames: value.total_frames, percent: Math.max(0, Math.min(100, value.percent)) };
  } catch { return null; }
}

function appendLog(job: RenderJob, value: string): void {
  job.log = `${job.log}\n${value}`.trim().slice(-64 * 1024);
}

function publicJob(job: RenderJob): RenderJobView {
  const { workspace: _workspace, outputDirectory: _directory, outputPath: _path, process: _process, progressBuffer: _buffer, ...view } = job;
  return { ...view, progress: { ...view.progress, elapsedMs: (view.finishedAt ?? Date.now()) - view.startedAt } };
}

function validateStoredJob(input: unknown, expectedId: string): RenderJobView {
  if (!input || typeof input !== "object") throw new Error("Invalid render metadata.");
  const value = input as Partial<RenderJobView>;
  if (value.id !== expectedId || typeof value.file !== "string" || !value.file || value.file.includes("\0") || value.file.startsWith("/") || value.file.split(/[\\/]/u).some((part) => part === "..")) throw new Error("Invalid render identity.");
  if (value.format !== "mp4" && value.format !== "gif" && value.format !== "png") throw new Error("Invalid render format.");
  const options = value.options;
  if (!options || options.format !== value.format || !Number.isInteger(options.fps) || options.fps < 1 || options.fps > 240 || !Number.isFinite(options.scale) || options.scale < 0.1 || options.scale > 8 || !["auto", "portrait", "feed", "square", "landscape"].includes(options.canvas) || typeof options.cpuShaders !== "boolean" || typeof options.branded !== "boolean") throw new Error("Invalid render options.");
  const progress = value.progress;
  if (!progress || !["preparing", "rendering", "encoding", "complete", "failed", "cancelled"].includes(progress.phase) || (progress.percent !== null && (!Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent > 100)) || (progress.framesRendered !== null && (!Number.isInteger(progress.framesRendered) || progress.framesRendered < 0)) || (progress.totalFrames !== null && (!Number.isInteger(progress.totalFrames) || progress.totalFrames < 0)) || !Number.isFinite(progress.elapsedMs) || progress.elapsedMs < 0) throw new Error("Invalid render progress.");
  if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || (value.finishedAt !== null && (typeof value.finishedAt !== "number" || !Number.isFinite(value.finishedAt)))) throw new Error("Invalid render time.");
  if (!["queued", "running", "completed", "failed", "cancelled"].includes(String(value.status))) throw new Error("Invalid render status.");
  if (typeof value.log !== "string" || value.log.length > 64 * 1024 || (value.frameCount !== null && (typeof value.frameCount !== "number" || !Number.isInteger(value.frameCount) || value.frameCount < 0))) throw new Error("Invalid render details.");
  if (value.outputName !== null && (typeof value.outputName !== "string" || basename(value.outputName) !== value.outputName)) throw new Error("Invalid output name.");
  return value as RenderJobView;
}
