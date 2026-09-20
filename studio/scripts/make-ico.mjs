/** icon.png(物理像素可能为 384)→ 缩放到 256 → 封装 icon.ico(内嵌 PNG 条目) */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, resizeArea, encodePng } from "./png-utils.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "resources", "icons");
const png = fs.readFileSync(path.join(dir, "icon.png"));

const img = decodePng(png);
process.stdout.write(`source: ${img.width}x${img.height}\n`);
const sized = img.width === 256 ? img : resizeArea(img, 256, 256);

// 256 主条目 + 由主条目降采样的小尺寸条目(16/32/48/64),资源管理器小图标更清晰
const entries = [];
for (const size of [256, 64, 48, 32, 16]) {
  const im = size === 256 ? sized : resizeArea(sized, size, size);
  const data = encodePng(im);
  entries.push({ size, data });
}

const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(entries.length, 4);
const entryBuffers = [];
let offset = 6 + entries.length * 16;
for (const e of entries) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(e.size === 256 ? 0 : e.size, 0);
  entry.writeUInt8(e.size === 256 ? 0 : e.size, 1);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(e.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entryBuffers.push(entry);
  offset += e.data.length;
}
const ico = Buffer.concat([header, ...entryBuffers, ...entries.map((e) => e.data)]);
fs.writeFileSync(path.join(dir, "icon.ico"), ico);
process.stdout.write(`icon.ico written: ${ico.length} bytes, ${entries.length} sizes\n`);
