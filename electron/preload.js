"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("native", {
  // 按主进程约定的 {ok,data}/{ok,error} 协议解包：失败时把纯中文消息重新抛成 Error，
  // 保证前端 catch(e) 里 e.message / String(e) 拿到的就是中文消息本身，
  // 不带 Electron ipc 的 "Error invoking remote method" 前缀。
  async invoke(cmd, args) {
    const res = await ipcRenderer.invoke(cmd, args);
    if (res && res.ok) return res.data;
    throw new Error(res ? res.error : "IPC 无返回");
  },
  setDirty(dirty) {
    ipcRenderer.send("set_dirty", dirty);
  },
});
