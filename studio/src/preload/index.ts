import { contextBridge, ipcRenderer } from "electron";

const ctx = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(channel, payload),
  onChanged: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on("pvc:v1:changed", listener);
    return () => ipcRenderer.removeListener("pvc:v1:changed", listener);
  },
};

contextBridge.exposeInMainWorld("pvc", ctx);
