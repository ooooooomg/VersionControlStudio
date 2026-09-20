/** 渲染 icon.html → resources/icons/icon.png(256×256)
 *  策略:短暂显示无边框小窗口,load 完成后 capturePage;任何一步 8s 无进展即报错退出。 */
import { app, BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const timeout = setTimeout(() => {
  process.stderr.write("render timeout\n");
  app.exit(1);
}, 8000);

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 256,
      height: 256,
      show: true,
      frame: false,
      resizable: false,
      useContentSize: true,
      backgroundColor: "#00000000",
    });
    await win.loadFile(path.join(here, "icon.html"));
    await new Promise((r) => setTimeout(r, 500));
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    const out = path.join(here, "..", "resources", "icons");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "icon.png"), png);
    clearTimeout(timeout);
    process.stdout.write(`icon.png written: ${png.length} bytes\n`);
    app.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    process.stderr.write(`fatal: ${err}\n`);
    app.exit(1);
  }
});
