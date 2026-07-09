"use strict";

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const xmlStore = require("./xml_store");
const cSync = require("./c_sync");
const newXml = require("./new_xml");
const updater = require("./updater");

const isDev = !app.isPackaged;

let mainWindow = null;
// 渲染端经 setDirty 同步过来的脏数据标记，供关窗保护判断。
let hasDirtyData = false;
// close 事件里弹确认框是异步的，确认后 destroy() 会再次触发 close；用这个标记放行第二次。
let forceClose = false;

function configFile() {
  return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), "utf8");
}

// 打包后可执行程序与 translations.xml 同目录的约定用 process.execPath；
// 开发模式没有独立 exe，退回工程根目录（app.getAppPath）。
function exeDir() {
  return isDev ? app.getAppPath() : path.dirname(process.execPath);
}

// handler 统一用 {ok,data}/{ok,error} 协议，让 xml_store 抛出的中文消息能原样
// 透到渲染端，绕开 Electron 对 ipc 异常包的那层 "Error invoking remote method" 前缀。
function ok(data) {
  return { ok: true, data };
}
function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, args) => {
    try {
      return ok(await fn(args || {}));
    } catch (e) {
      return fail(e);
    }
  });
}

function registerHandlers() {
  handle("resolve_initial_path", () => {
    const cfg = loadConfig();
    if (cfg.last_xml_path && fs.existsSync(cfg.last_xml_path) &&
        fs.statSync(cfg.last_xml_path).isFile()) {
      return cfg.last_xml_path;
    }
    const cand = path.join(exeDir(), "translations.xml");
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return cand;
    }
    return null;
  });

  handle("remember_path", ({ path: p }) => {
    const cfg = loadConfig();
    cfg.last_xml_path = p;
    saveConfig(cfg);
    return null;
  });

  handle("pick_new_xml_save_path", async () => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: "新建 translations.xml",
      defaultPath: "translations.xml",
      filters: [{ name: "translations.xml", extensions: ["xml"] }],
    });
    if (r.canceled || !r.filePath) return null;
    return r.filePath;
  });

  handle("create_new_xml", ({ path: p }) => newXml.createNewXml(p));

  handle("pick_xml_file", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: "translations.xml", extensions: ["xml"] }],
      properties: ["openFile"],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  handle("confirm_dialog", async ({ title, message }) => {
    const r = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title,
      message,
      buttons: ["确定", "取消"],
      defaultId: 0,
      cancelId: 1,
    });
    return r.response === 0;
  });

  handle("load_translations", ({ path: p }) => xmlStore.loadTranslations(p));

  handle("save_cell", ({ path: p, key, code, value }) =>
    xmlStore.updateTranslation(p, key, code, value));

  handle("save_cells", ({ path: p, edits }) => xmlStore.saveCells(p, edits));

  handle("add_entry", ({ path: p, key, values }) =>
    xmlStore.addEntry(p, key, values));

  handle("delete_entry", ({ path: p, key }) => xmlStore.deleteEntry(p, key));

  handle("add_language", ({ path: p, code, name }) =>
    xmlStore.addLanguage(p, code, name));

  handle("delete_language", ({ path: p, code }) =>
    xmlStore.deleteLanguage(p, code));

  handle("regen_multilang", ({ path: p }) => xmlStore.regenMultilang(p));

  handle("check_multilang_consistency", ({ path: p }) =>
    xmlStore.checkMultilangConsistency(p));

  handle("sync_from_c", ({ path: p }) => cSync.syncFromC(p));

  handle("get_file_mtime", ({ path: p }) => xmlStore.fileMtimeMillis(p));

  handle("pick_csv_save_path", async ({ defaultName }) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: "CSV", extensions: ["csv"] }],
      defaultPath: defaultName,
    });
    if (r.canceled || !r.filePath) return null;
    return r.filePath;
  });

  handle("pick_csv_open_path", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: "CSV", extensions: ["csv"] }],
      properties: ["openFile"],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  handle("export_csv", ({ path: p, csvPath }) => xmlStore.exportCsv(p, csvPath));

  handle("import_csv", ({ path: p, csvPath }) => xmlStore.importCsv(p, csvPath));

  // 自动更新：状态经 IPC 推给页面右下角提示条（见 src/main.js 的 update-toast 部分），
  // 不用原生 dialog——那会打断用户正在做的事。
  handle("updater_get_status", () => updater.getUpdaterStatus());
  // 手动检查（interactive=true 会额外推"检查中/已是最新/出错"这几个一次性状态）；
  // 不 await：结果经 updater:status 推送给提示条，命令本身立即返回不卡按钮
  handle("updater_check", () => {
    updater.checkForUpdate(true).catch(() => {});
    return null;
  });
  handle("updater_open_download", () => updater.openDownloadPage());
  // 「立即重启」：走 mainWindow.close() 而不是直接 app.quit()，让关窗保护照常拦截
  // 未保存的脏数据；窗口真正关掉后 window-all-closed → app.quit()，
  // updater 在 before-quit 里拉起已暂存的新版 exe 完成替换。
  handle("updater_restart", () => {
    if (mainWindow) mainWindow.close();
    else app.quit();
    return null;
  });

  ipcMain.on("set_dirty", (_event, dirty) => {
    hasDirtyData = !!dirty;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "多国语言编辑器",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));

  // devtools 快捷键仅在开发模式保留。
  if (isDev) {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      const isToggle = input.key === "F12" ||
        (input.control && input.shift && (input.key === "I" || input.key === "i"));
      if (isToggle) {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  mainWindow.on("close", (e) => {
    if (forceClose || !hasDirtyData) return;
    e.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "关闭窗口",
      message: "当前有未保存的修改，关闭窗口会丢弃这些修改，确定继续吗？",
      buttons: ["确定", "取消"],
      defaultId: 0,
      cancelId: 1,
    }).then((r) => {
      if (r.response === 0) {
        forceClose = true;
        mainWindow.destroy();
      }
    });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// 更新接力：若本进程是刚下载的新版 exe 且有替换协议，只做替换后自退，不进正常启动
// （替换完成后 updater 内部自行 app.exit()）。
if (updater.runUpdateHandoff()) {
  // 什么都不做，等 updater 完成替换并退出
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // 界面是纯浅色主题：原生窗口标题栏也强制浅色，避免系统深色模式下黑白拼接
    nativeTheme.themeSource = "light";
    registerHandlers();
    createWindow();
    // 打包形态下启动 5s 后静默检查一次更新 + 每 6h 一次（开发模式不检查）
    updater.initUpdater({ getWin: () => mainWindow });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
