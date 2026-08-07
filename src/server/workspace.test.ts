import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createManicFile, duplicateManicFile, listManicFiles, readManicFile, renameManicFile,
  saveManicFile, trashManicFile, WorkspaceConflictError,
} from "./workspace.js";

describe("Workbench file boundary", () => {
  it("lists only regular .manic files and skips symlinks", async () => {
    const workspace = await fixture();
    await symlink(join(workspace, "story.manic"), join(workspace, "linked.manic"));
    const files = await listManicFiles(workspace);
    expect(files.map((file) => file.path)).toEqual(["lessons/nested.manic", "story.manic"]);
  });

  it("rejects traversal and non-Manic files", async () => {
    const workspace = await fixture();
    await expect(readManicFile(workspace, "../secret.manic")).rejects.toThrow("inside the selected workspace");
    await expect(readManicFile(workspace, "notes.txt")).rejects.toThrow("only .manic files");
  });

  it("saves atomically when the expected version matches", async () => {
    const workspace = await fixture();
    const before = await readManicFile(workspace, "story.manic");
    const after = await saveManicFile(workspace, "story.manic", "title(\"Changed\");\n", before.version);
    expect(after.content).toBe("title(\"Changed\");\n");
    expect(after.version).not.toBe(before.version);
    expect(await readFile(join(workspace, "story.manic"), "utf8")).toBe(after.content);
  });

  it("does not overwrite an externally changed file", async () => {
    const workspace = await fixture();
    const opened = await readManicFile(workspace, "story.manic");
    await writeFile(join(workspace, "story.manic"), "title(\"External\");\n");
    await expect(saveManicFile(workspace, "story.manic", "title(\"Local\");\n", opened.version))
      .rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  it("creates, renames, and duplicates Manic files without overwriting", async () => {
    const workspace = await fixture();
    const created = await createManicFile(workspace, "new-story.manic", "title(\"New\");\n");
    const renamed = await renameManicFile(workspace, created.path, "renamed.manic", created.version);
    const duplicate = await duplicateManicFile(workspace, renamed.path, "copy.manic", renamed.version);
    expect(renamed.path).toBe("renamed.manic");
    expect(duplicate.content).toBe(renamed.content);
    await expect(createManicFile(workspace, "copy.manic", "duplicate"))
      .rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  it("moves deleted files to recoverable project trash and hides them from the tree", async () => {
    const workspace = await fixture();
    const source = await readManicFile(workspace, "story.manic");
    const result = await trashManicFile(workspace, source.path, source.version);
    expect(result.trashedPath).toMatch(/^\.manic-trash\//u);
    expect(await readFile(join(workspace, result.trashedPath), "utf8")).toBe(source.content);
    expect((await listManicFiles(workspace)).map((file) => file.path)).not.toContain("story.manic");
  });
});

async function fixture(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "manic-workbench-files-"));
  await mkdir(join(workspace, "lessons"));
  await writeFile(join(workspace, "story.manic"), "title(\"Story\");\n");
  await writeFile(join(workspace, "lessons", "nested.manic"), "title(\"Nested\");\n");
  await writeFile(join(workspace, "notes.txt"), "not editable");
  return workspace;
}
