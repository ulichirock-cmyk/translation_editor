# translation_editor_electron

`translation_editor`（Python + 单文件 HTML）的 Electron 重构版：同一张 `translations.xml` 编辑表格 UI，改为原生桌面应用，后端逻辑由 Node 实现（`electron/xml_store.js`），不再需要跑本地 HTTP 服务器。

## 开发

```bash
npm install
npm start            # 启动开发窗口（前端无构建步骤）
npm run dist         # 产出单文件可执行程序 translation_editor_win-<版本号>.exe（dist/）
```

Node 后端单元测试（覆盖 XML 改写、语言/条目增删、multilang.h/.c 生成、CSV 导入导出）：

```bash
npm test             # 等价于 node --test test/
```

> 若 `npm install` 时 Electron 二进制下载失败，可用镜像重试：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## 发版与自动更新

发新版：把 `package.json` 的 `version` 改好，然后二选一触发 `.github/workflows/release.yml`：

1. 推 tag：`git tag vX.Y.Z && git push origin vX.Y.Z`
2. 手动运行：GitHub 网页/App 的 Actions → release → Run workflow（手机也能点），版本号自动取 `package.json` 推导成 `v<version>`

工作流在 `windows-latest` 上跑 `npm test` + `electron-builder`，把 exe 发布成 GitHub Release（自动生成 release notes）。

已打包的应用启动后会自动检查 GitHub latest release（`electron/updater.js`，移植自 [raywrite](https://github.com/ulichirock-cmyk/raywrite)）：发现新版直接后台下载，右下角悬浮条展示进度，下载就绪后可点「立即重启」立即升级；不理会的话，更新也会在下次退出应用时自动落地。替换始终写回原 exe 路径，快捷方式不受影响。开发模式（`npm start`）不检查更新。

## 架构

- `electron/xml_store.js` — 全部核心逻辑：读取用 `@xmldom/xmldom` 做结构化解析，写入（`updateTranslation`/`addEntry`/`deleteEntry`/`addLanguage`/`deleteLanguage`）仍用正则文本替换，保留 `translations.xml` 原有缩进和多列同行格式。`regenMultilang` 原生复刻 `gen_multilang.py` 的输出格式（同样的 `#define` / `LangEntry` 数组 / `multilang_get()`）。仍沿用"从 `translations.xml` 所在目录向上查找 `gen_multilang.py`"的方式定位固件工程输出目录——这个文件现在只是个目录标记，内容不再被执行。失败时抛出带中文消息的 `Error`。
- `electron/main.js` — 主进程：注册所有 `ipcMain.handle`（对应原来的 `#[tauri::command]` / `/api/*` 路由）、原生对话框、配置持久化与关窗保护。启动时优先用上次记住的路径（`app.getPath('userData')/config.json`），否则退回"exe 同目录下的 translations.xml"，都找不到则前端展示打开文件引导页。IPC 统一用 `{ok,data}` / `{ok,error}` 协议，让 `xml_store.js` 抛出的中文错误消息原样透到渲染端。
- `electron/preload.js` — `contextBridge` 桥，暴露 `window.native.invoke(cmd,args)` 与 `window.native.setDirty(bool)`；`invoke` 内部按上述协议解包，失败时重新抛出纯中文消息的 `Error`。
- `src/` — 纯 JS/HTML/CSS 前端，无构建步骤，直接照搬原表格渲染/列宽拖拽/过滤/弹窗逻辑；仅把 `window.__TAURI__.core.invoke` 换成 `window.native.invoke`，关窗保护改为经 `setDirty` 同步脏状态给主进程。保存模型不变：单元格失焦不自动保存，只有点"保存" / `Ctrl+S` / `Ctrl+Enter` 才写入全部脏单元格并触发 multilang 重新生成。

## 与 Tauri 版的差异

- 后端由 Rust（`xml_store.rs`）改为 Node（`xml_store.js`），依赖 `@xmldom/xmldom`；测试由 `cargo test` 改为 `node --test`。
- 打包由 `tauri build` 改为 `electron-builder --win portable`，产物仍为单文件 `translation_editor_win.exe`。
- 前端无构建步骤这一点保持不变。
