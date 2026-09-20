/** 自实现 unified diff 解析(零依赖):文件列表 + 彩色行渲染数据 */

export interface ULine {
  t: "+" | "-" | " " | "?";
  text: string;
}

export interface UHunk {
  header: string;
  lines: ULine[];
}

export interface UFile {
  oldPath: string;
  newPath: string;
  hunks: UHunk[];
}

export function parseUnified(text: string): UFile[] {
  const files: UFile[] = [];
  let cur: UFile | null = null;
  let hunk: UHunk | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { oldPath: "", newPath: "", hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("--- ")) cur.oldPath = line.slice(4).trim();
    else if (line.startsWith("+++ ")) cur.newPath = line.slice(4).trim();
    else if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
    } else if (
      hunk &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
    ) {
      hunk.lines.push({ t: line[0] as ULine["t"], text: line.slice(1) });
    }
  }
  return files;
}

export interface StatFile {
  path: string;
  changes: number | null; // null = 二进制
  adds: number;
  dels: number;
}

/** 解析 `git diff --stat` 输出 */
export function parseStat(text: string): StatFile[] {
  const out: StatFile[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.includes("|")) continue;
    if (line.endsWith("changed") || line.includes("file") && /changed$/.test(line.trim())) continue;
    const m = /^(.+?)\s+\|\s+(?:(\d+)\s*([+\-]*)|Bin\s*(?:\d+)?\s*(?:->\s*(\d+))?)$/.exec(
      line.trim(),
    );
    if (!m) continue;
    const path = m[1]!.trim();
    if (m[2] !== undefined) {
      const marks = m[3] ?? "";
      out.push({
        path,
        changes: Number(m[2]),
        adds: (marks.match(/\+/g) ?? []).length,
        dels: (marks.match(/-/g) ?? []).length,
      });
    } else {
      out.push({ path, changes: null, adds: 0, dels: 0 });
    }
  }
  return out;
}
