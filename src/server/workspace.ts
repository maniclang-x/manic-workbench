import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

export interface WorkspaceFileSummary {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  version: string;
}

export interface WorkspaceFile extends WorkspaceFileSummary {
  content: string;
}

export class WorkspaceConflictError extends Error {}

export async function resolveWorkspace(input: string): Promise<string> {
  const requested = resolve(input);
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    throw new Error(`Workspace does not exist: ${requested}`, { cause: error });
  }
  const information = await stat(canonical);
  if (!information.isDirectory()) throw new Error(`Workspace is not a directory: ${canonical}`);
  return canonical;
}

export async function listManicFiles(workspace: string): Promise<WorkspaceFileSummary[]> {
  const files: WorkspaceFileSummary[] = [];
  await walk(workspace, "", files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function readManicFile(workspace: string, requestedPath: string): Promise<WorkspaceFile> {
  const { absolute, path } = await resolveExistingManicFile(workspace, requestedPath);
  const [content, information] = await Promise.all([readFile(absolute, "utf8"), stat(absolute)]);
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    size: information.size,
    modifiedAt: information.mtimeMs,
    version: versionOf(content),
    content,
  };
}

export async function saveManicFile(
  workspace: string,
  requestedPath: string,
  content: string,
  expectedVersion: string,
): Promise<WorkspaceFile> {
  if (typeof content !== "string") throw new Error("File content must be text.");
  if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) throw new Error("A Manic file cannot exceed 5 MB in Workbench.");
  if (!expectedVersion) throw new Error("An expected file version is required.");

  const current = await readManicFile(workspace, requestedPath);
  if (current.version !== expectedVersion) {
    throw new WorkspaceConflictError("The file changed outside Workbench. Reload it before saving your edits.");
  }

  const { absolute } = await resolveExistingManicFile(workspace, requestedPath);
  const information = await stat(absolute);
  const temporary = join(dirname(absolute), `.manic-workbench-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: information.mode });
    await chmod(temporary, information.mode);
    await rename(temporary, absolute);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return readManicFile(workspace, requestedPath);
}

export async function createManicFile(workspace: string, requestedPath: string, content: string): Promise<WorkspaceFile> {
  validateContent(content);
  const { absolute, path } = await resolveNewManicFile(workspace, requestedPath);
  await writeFile(absolute, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
  return readManicFile(workspace, path);
}

export async function renameManicFile(
  workspace: string,
  requestedPath: string,
  requestedNewPath: string,
  expectedVersion: string,
): Promise<WorkspaceFile> {
  const source = await requireVersion(workspace, requestedPath, expectedVersion);
  const from = await resolveExistingManicFile(workspace, source.path);
  const target = await resolveNewManicFile(workspace, requestedNewPath);
  await rename(from.absolute, target.absolute);
  return readManicFile(workspace, target.path);
}

export async function duplicateManicFile(
  workspace: string,
  requestedPath: string,
  requestedNewPath: string,
  expectedVersion: string,
  content?: string,
): Promise<WorkspaceFile> {
  const source = await requireVersion(workspace, requestedPath, expectedVersion);
  return createManicFile(workspace, requestedNewPath, content ?? source.content);
}

export async function trashManicFile(
  workspace: string,
  requestedPath: string,
  expectedVersion: string,
): Promise<{ path: string; trashedPath: string }> {
  const source = await requireVersion(workspace, requestedPath, expectedVersion);
  const existing = await resolveExistingManicFile(workspace, source.path);
  const canonicalWorkspace = await realpath(workspace);
  const trashDirectory = join(canonicalWorkspace, ".manic-trash");
  await mkdir(trashDirectory, { mode: 0o700, recursive: true });
  const trashInformation = await lstat(trashDirectory);
  const canonicalTrash = await realpath(trashDirectory);
  if (!trashInformation.isDirectory() || trashInformation.isSymbolicLink() || canonicalTrash !== trashDirectory) {
    throw new Error("The project trash directory is not safe to use.");
  }
  const safeName = source.path.replaceAll("/", "__");
  const trashName = `${Date.now()}-${randomUUID()}-${safeName}`;
  await rename(existing.absolute, join(trashDirectory, trashName));
  return { path: source.path, trashedPath: `.manic-trash/${trashName}` };
}

async function walk(workspace: string, directory: string, files: WorkspaceFileSummary[]): Promise<void> {
  const absoluteDirectory = join(workspace, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".manic-trash" || entry.name === ".manic-output" || entry.name === "node_modules" || entry.name.startsWith(".manic-workbench-")) continue;
    const localPath = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(workspace, localPath, files);
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".manic") {
      const file = await readManicFile(workspace, localPath);
      const { content: _content, ...summary } = file;
      files.push(summary);
    }
  }
}

async function resolveNewManicFile(workspace: string, requestedPath: string): Promise<{ absolute: string; path: string }> {
  const path = normalizeManicPath(requestedPath);
  const canonicalWorkspace = await realpath(workspace);
  const candidate = join(canonicalWorkspace, ...path.split("/"));
  const canonicalParent = await realpath(dirname(candidate)).catch(() => null);
  if (!canonicalParent) throw new Error("The destination folder does not exist.");
  if (canonicalParent !== dirname(candidate)) throw new Error("File destinations cannot use symbolic-link folders.");
  const parentLocal = relative(canonicalWorkspace, canonicalParent);
  if (parentLocal === ".." || parentLocal.startsWith(`..${sep}`)) throw new Error("File access escaped the selected workspace.");
  if (await lstat(candidate).catch(() => null)) throw new WorkspaceConflictError(`A file already exists at ${path}.`);
  return { absolute: candidate, path };
}

async function requireVersion(workspace: string, requestedPath: string, expectedVersion: string): Promise<WorkspaceFile> {
  if (!expectedVersion) throw new Error("An expected file version is required.");
  const file = await readManicFile(workspace, requestedPath);
  if (file.version !== expectedVersion) throw new WorkspaceConflictError("The file changed outside Workbench. Reload it before continuing.");
  return file;
}

function validateContent(content: string): void {
  if (typeof content !== "string") throw new Error("File content must be text.");
  if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) throw new Error("A Manic file cannot exceed 5 MB in Workbench.");
}

export async function resolveExistingManicFile(workspace: string, requestedPath: string): Promise<{ absolute: string; path: string }> {
  const path = normalizeManicPath(requestedPath);
  const canonicalWorkspace = await realpath(workspace);
  const candidate = join(canonicalWorkspace, ...path.split("/"));
  const linkInformation = await lstat(candidate).catch(() => null);
  if (!linkInformation?.isFile() || linkInformation.isSymbolicLink()) throw new Error(`Manic file does not exist: ${path}`);
  const absolute = await realpath(candidate);
  const local = relative(canonicalWorkspace, absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || resolve(canonicalWorkspace, local) !== absolute) {
    throw new Error("File access escaped the selected workspace.");
  }
  return { absolute, path: local.split(sep).join("/") };
}

function normalizeManicPath(input: string): string {
  if (typeof input !== "string" || !input || input.includes("\0")) throw new Error("A relative Manic file path is required.");
  const normalized = input.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("File paths must stay inside the selected workspace.");
  }
  if (extname(normalized).toLowerCase() !== ".manic") throw new Error("Workbench can edit only .manic files.");
  return normalized;
}

function versionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
