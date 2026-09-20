/** 行级 LCS diff:返回两侧各行是否"变更"(不在公共子序列中) */
export interface LineDiffResult {
  aChanged: boolean[];
  bChanged: boolean[];
  skipped: boolean;
}

const MAX_CELLS = 6_000_000;

export function diffLines(a: string[], b: string[]): LineDiffResult {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    return {
      aChanged: a.map(() => true),
      bChanged: b.map(() => true),
      skipped: true,
    };
  }
  // LCS 动态规划(滚动行)
  const dp = new Int32Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const aChanged = a.map(() => true);
  const bChanged = b.map(() => true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aChanged[i] = false;
      bChanged[j] = false;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { aChanged, bChanged, skipped: false };
}
