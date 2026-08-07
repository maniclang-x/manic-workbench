export type DiffLine = {
  type: "equal" | "add" | "remove";
  text: string;
};

/** Myers-inspired LCS line diff for reviewable Manic proposals. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const left = splitLines(before);
  const right = splitLines(after);
  if (left.length === 0 && right.length === 0) return [];
  if (left.length === 0) return right.map((text) => ({ type: "add" as const, text }));
  if (right.length === 0) return left.map((text) => ({ type: "remove" as const, text }));
  if (left.length * right.length > 2_000_000) {
    return [
      ...left.map((text) => ({ type: "remove" as const, text })),
      ...right.map((text) => ({ type: "add" as const, text })),
    ];
  }

  const n = left.length;
  const m = right.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = left[i] === right[j]
        ? (dp[i + 1]![j + 1]! + 1)
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      lines.push({ type: "equal", text: left[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ type: "remove", text: left[i]! });
      i += 1;
    } else {
      lines.push({ type: "add", text: right[j]! });
      j += 1;
    }
  }
  while (i < n) {
    lines.push({ type: "remove", text: left[i]! });
    i += 1;
  }
  while (j < m) {
    lines.push({ type: "add", text: right[j]! });
    j += 1;
  }
  return lines;
}

function splitLines(value: string): string[] {
  if (!value) return [];
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
}
