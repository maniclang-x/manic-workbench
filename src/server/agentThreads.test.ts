import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentThread, ThreadTurn } from "./agentProtocol.js";
import {
  appendTurn,
  buildConversation,
  createThread,
  getThread,
  listThreads,
  recordApply,
  removeThread,
  ThreadNotFoundError,
} from "./agentThreads.js";

describe("agent thread store", () => {
  it("creates, reads, lists, and removes threads as JSON sidecars", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-threads-"));
    const created = await createThread(workspace, { kind: "draft", draftName: "story.manic" });
    expect(created.threadId).toMatch(/^thread_[a-f0-9]{32}$/u);
    expect(created.turns).toEqual([]);
    expect(created.lastAppliedRevision).toBeNull();

    const loaded = await getThread(workspace, created.threadId);
    expect(loaded).toEqual(created);

    const listed = await listThreads(workspace);
    expect(listed.map((thread) => thread.threadId)).toEqual([created.threadId]);

    const raw = await readFile(join(workspace, ".manic-workbench-threads", `${created.threadId}.json`), "utf8");
    expect(JSON.parse(raw).threadId).toBe(created.threadId);

    await removeThread(workspace, created.threadId);
    await expect(getThread(workspace, created.threadId)).rejects.toBeInstanceOf(ThreadNotFoundError);
  });

  it("rejects traversal in thread ids and targets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-threads-"));
    await expect(getThread(workspace, "../escape")).rejects.toBeInstanceOf(ThreadNotFoundError);
    await expect(createThread(workspace, { kind: "file", path: "../outside.manic" })).rejects.toThrow(/relative \.manic/u);
    await expect(createThread(workspace, { kind: "draft", draftName: "not-manic.txt" })).rejects.toThrow(/relative \.manic/u);
  });

  it("records turns and never leaves a partially written file behind", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-threads-"));
    const thread = await createThread(workspace, { kind: "file", path: "a.manic" });
    await appendTurn(workspace, thread.threadId, turn("run_1", "make it blue", "Recolored the title."));
    const updated = await appendTurn(workspace, thread.threadId, turn("run_2", "bigger title", "Enlarged the title."));
    expect(updated.turns).toHaveLength(2);
    const entries = await readdir(join(workspace, ".manic-workbench-threads"));
    expect(entries).toEqual([`${thread.threadId}.json`]);
  });

  it("applies a ready turn, records the revision, and rebinds a draft to its created file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-threads-"));
    const thread = await createThread(workspace, { kind: "draft", draftName: "new.manic" });
    await appendTurn(workspace, thread.threadId, turn("run_1", "create it", "Created the story."));
    const applied = await recordApply(workspace, thread.threadId, "run_1", "new.manic", "rev-abc");
    expect(applied.target).toEqual({ kind: "file", path: "new.manic" });
    expect(applied.lastAppliedRevision).toBe("rev-abc");
    expect(applied.turns[0]?.appliedRevision).toBe("rev-abc");
  });

  it("refuses to apply unknown or unvalidated turns", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-threads-"));
    const thread = await createThread(workspace, { kind: "file", path: "a.manic" });
    await expect(recordApply(workspace, thread.threadId, "missing", "a.manic", "rev")).rejects.toThrow(/not a turn/u);
    await appendTurn(workspace, thread.threadId, { ...turn("run_f", "try", "Still broken."), status: "failed" });
    await expect(recordApply(workspace, thread.threadId, "run_f", "a.manic", "rev")).rejects.toThrow(/Manic-validated/u);
  });

  it("ignores unreadable or foreign files in the threads directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-threads-"));
    const thread = await createThread(workspace, { kind: "file", path: "a.manic" });
    await writeFile(join(workspace, ".manic-workbench-threads", "junk.json"), "not json");
    await writeFile(join(workspace, ".manic-workbench-threads", "notes.txt"), "hello");
    const listed = await listThreads(workspace);
    expect(listed.map((item) => item.threadId)).toEqual([thread.threadId]);
  });
});

describe("buildConversation", () => {
  it("is empty for a fresh thread with a matching document", () => {
    expect(buildConversation(thread([]), null)).toBe("");
    expect(buildConversation({ ...thread([]), lastAppliedRevision: "rev-1" }, "rev-1")).toBe("");
  });

  it("marks external edits when the disk revision differs from the last applied one", () => {
    const conversation = buildConversation({ ...thread([turn("r1", "a", "b")]), lastAppliedRevision: "rev-1" }, "rev-2");
    expect(conversation).toContain("edited outside this conversation");
    expect(conversation).toContain("current document source is authoritative");
  });

  it("omits the external-edit marker when disk matches the applied revision", () => {
    const conversation = buildConversation({ ...thread([turn("r1", "a", "b")]), lastAppliedRevision: "rev-1" }, "rev-1");
    expect(conversation).not.toContain("edited outside");
  });

  it("keeps recent turns verbatim and compresses older ones to summary lines", () => {
    const turns = [1, 2, 3, 4, 5].map((index) => turn(`r${index}`, `request ${index}`, `summary ${index}`));
    const conversation = buildConversation(thread(turns), null);
    expect(conversation).toContain("Earlier turns (summarized):");
    expect(conversation).toContain('- [ready] "request 1" → summary 1');
    expect(conversation).toContain('- [ready] "request 2" → summary 2');
    expect(conversation).toContain("User: request 3");
    expect(conversation).toContain("User: request 5");
    expect(conversation).not.toContain("User: request 2");
  });

  it("labels applied and unapplied turns and bounds total size", () => {
    const applied: ThreadTurn = { ...turn("r1", "make it", "Made it."), appliedRevision: "rev-1" };
    const conversation = buildConversation(thread([applied, turn("r2", "tweak it", "Tweaked it.")]), null);
    expect(conversation).toContain("Agent (ready, applied): Made it.");
    expect(conversation).toContain("Agent (ready, not applied): Tweaked it.");

    const huge = buildConversation(thread([turn("r1", "x".repeat(50_000), "y".repeat(50_000))]), null);
    expect(huge.length).toBeLessThanOrEqual(12_000);
  });
});

function thread(turns: ThreadTurn[]): AgentThread {
  return {
    protocolVersion: 1,
    threadId: "thread_0123456789abcdef0123456789abcdef",
    target: { kind: "file", path: "story.manic" },
    turns,
    lastAppliedRevision: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function turn(runId: string, userMessage: string, proposalSummary: string): ThreadTurn {
  return { runId, userMessage, proposalSummary, status: "ready", appliedRevision: null, at: 1 };
}
