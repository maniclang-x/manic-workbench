import { describe, expect, it } from "vitest";
import { lineDiff } from "./lineDiff";

describe("lineDiff", () => {
  it("marks a create proposal as pure additions", () => {
    expect(lineDiff("", 'title("Hi");\n')).toEqual([
      { type: "add", text: 'title("Hi");' },
      { type: "add", text: "" },
    ]);
  });

  it("shows changed lines for a refine proposal", () => {
    const diff = lineDiff('title("Old");\nstage {}\n', 'title("New");\nstage {}\n');
    expect(diff).toEqual([
      { type: "remove", text: 'title("Old");' },
      { type: "add", text: 'title("New");' },
      { type: "equal", text: "stage {}" },
      { type: "equal", text: "" },
    ]);
  });
});
