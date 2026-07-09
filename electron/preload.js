"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 按主进程约定的 {ok,data}/{ok,error} 协议解包：失败时把纯中文消息重新抛成 Error，
// 保证前端 catch(e) 里 e.message / String(e) 拿到的就是中文消息本身，
// 不带 Electron ipc 的 "Error invoking remote method" 前缀。
async function invoke(cmd, args) {
  const res = await ipcRenderer.invoke(cmd, args);
  if (res && res.ok) return res.data;
  throw new Error(res ? res.error : "IPC 无返回");
}

contextBridge.exposeInMainWorld("native", {
  invoke,
  setDirty(dirty) {
    ipcRenderer.send("set_dirty", dirty);
  },
  // 自动更新桥：状态由主进程 updater 主动推送（updater:status），
  // getStatus 供页面挂载时补拉一次快照（见 src/main.js 的 update-toast 部分）。
  updater: {
    getStatus: () => invoke("updater_get_status"),
    restart: () => invoke("updater_restart"),
    openDownloadPage: () => invoke("updater_open_download"),
    onStatus(cb) {
      const handler = (_e, status) => cb(status);
      ipcRenderer.on("updater:status", handler);
      return () => ipcRenderer.removeListener("updater:status", handler);
    },
  },
});
