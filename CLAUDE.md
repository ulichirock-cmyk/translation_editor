# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Electron rewrite of `translation_editor` (originally Python + single-file HTML + local HTTP server; there was also a Tauri 2 rewrite this one is ported from). Same job: edit a firmware project's `translations.xml` (multi-language string table) in a table UI, then regenerate the `multilang.h`/`multilang.c` that gets compiled into the firmware. All file I/O and generation logic lives in a Node module (`electron/xml_store.js`); the UI is a native window instead of a browser tab.

## Commands

```bash
npm install
npm start            # launch dev window (frontend has no build step — see Architecture)
npm run dist         # produce translation_editor_win-<version>.exe under dist/
```

Releases: bump `version` in `package.json`, then either push a `v*` tag or run the `release` workflow manually (`.github/workflows/release.yml`) — it builds the exe on `windows-latest` and publishes a GitHub Release. Packaged apps self-update from the latest release (see the updater note under Architecture).

Node backend tests (all logic lives in `xml_store.js`; this is the test suite that matters):

```bash
npm test             # node --test test/  — full suite
node --test test/ --test-name-pattern=import_csv   # substring filter — runs just matching tests
```

If Electron's binary download fails during install, retry with a mirror:
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`.

There is no frontend build/lint step — `src/` is plain JS/HTML/CSS loaded as-is (see below), so there's nothing to compile or bundle on that side.

## Architecture

**No frontend build pipeline.** `package.json`'s only runtime dependency is `@xmldom/xmldom` (used by `xml_store.js`); the dev deps are just `electron` + `electron-builder` — no React/Vue/bundler/TypeScript. The main process `loadFile`s `src/index.html`, which loads `src/main.js` as a plain ES module. Editing `src/main.js` and reloading the window is the entire frontend dev loop.

**Read/write asymmetry in `xml_store.js` is intentional, not an oversight.** Reading `translations.xml` uses `@xmldom/xmldom` for a proper structured parse. Writing does *not* re-serialize the DOM — it uses targeted regex substitution on the raw text so that the file's existing hand-formatted layout (multiple language columns aligned on one line, custom indentation) survives edits byte-for-byte outside the touched region. Any new write path must follow this same pattern rather than reaching for an XML serializer.

**`multilang.h`/`multilang.c` generation is a native reimplementation of `gen_multilang.py`**, not a shell-out to Python. It produces byte-identical output to the old script's format (`#define` block, `LangEntry` array, `multilang_get()`). The firmware project's output directory is located by walking up from the XML's directory looking for a `gen_multilang.py` file — that file is now just a location marker; its contents are never executed. This lookup only backs `regenMultilang` and `checkMultilangConsistency`; CSV export/import do not use it.

**Dynamic language list, no hardcoded columns.** Both the parsed data (`xml_store.js`) and the `LANGS` global (`main.js`) are populated from the `<languages>` block in whatever XML is currently open — adding/removing a language column is entirely data-driven. The one exception is `LANGUAGE_PRESETS` in `src/main.js`, a front-end-only convenience list for the "add language" dropdown; it has no bearing on what languages actually exist in the file.

**The IPC layer (`electron/main.js`) is a thin wrapper**; all real logic is in `xml_store.js`, which throws `Error` with human-readable (Chinese) text on failure. Because Electron wraps exceptions thrown inside an `ipcMain.handle` with an `"Error invoking remote method ..."` prefix, handlers instead return `{ok:true,data}` / `{ok:false,error:message}`; `preload.js`'s `invoke` wrapper unpacks that and re-throws `new Error(message)` so the frontend's `String(e)` / `e.message` sees the pure Chinese message. Any new command must go through the same `handle()` helper. The frontend has no toast system; errors surface through `setFailed()` (status dot), the persistent multi-line `#banner`, or inline `.err` divs in modals.

**`window.native` bridge (`preload.js`).** `contextBridge` exposes exactly two things: `invoke(cmd,args)` (the unpacking wrapper above) and `setDirty(bool)`. `contextIsolation` is on and `nodeIntegration` is off — the renderer never touches Node directly.

**Window-close protection lives in the main process.** The renderer syncs its dirty-cell state to the main process via `window.native.setDirty(...)` (called from `updateSaveButton`). On `win.on('close')`, if dirty, the main process `preventDefault()`s and shows a native OkCancel dialog; confirming calls `win.destroy()` (guarded by a `forceClose` flag so the re-entrant close doesn't loop). This replaces the Tauri version's `onCloseRequested`.

**The table is row-virtualized (`src/main.js`).** Only rows within ~400px of the viewport exist in the DOM; two `tr.virtual-spacer` rows carry the remaining height (per-row measured heights cached in `rowHeights`, estimate 37px until first render). Consequently edit state lives in the data model, not the DOM: `EDITS` (cellId → value, only differing values) *is* the dirty set, with `ERROR_CELLS`/`SAVED_FLASH` for transient cell classes — rows are rebuilt from these on re-entry. Anything that needs "all rows" (filter, find/replace, save) must iterate `ENTRIES`/`EDITS`, never `body.children`. Row striping uses a JS-assigned `.even` class, not `nth-child` (spacers break parity). Batch DOM reads/writes when touching many textareas (`autosizeBatch`) — interleaved `scrollHeight`/`minHeight` was the original jank source alongside full-DOM rendering.

**No auto-save, no `window.confirm()`.** Cell edits only flag `.dirty` and flush on the 保存 button / Ctrl+S / Ctrl+Enter (`saveAll`), which also triggers `regen_multilang` afterward. Destructive actions (delete entry/language) and the close/reload guards go through the `confirm_dialog` IPC command (native OS OkCancel dialog) instead of the browser's `window.confirm()`.

**Auto-update (`electron/updater.js`) is a portable-exe self-replacer ported from `ulichirock-cmyk/raywrite`**, not electron-updater (which doesn't support the portable target). Packaged builds poll the GitHub latest release, background-download the new exe next to the current one, and stage a replace manifest (`translation_editor-update.json`); the swap happens on quit via an explorer-proxied handoff to the new exe (`runUpdateHandoff()` runs at the very top of `electron/main.js`, before the single-instance lock — a handoff process must never enter normal startup). Status is pushed to the renderer over the `updater:status` channel and shown in the `#update-toast` floating bar (bottom-right, in `src/main.js`) — never a native modal. `updater_restart` deliberately goes through `mainWindow.close()` so the dirty-data close guard still applies. Dev mode (`!app.isPackaged`) never checks.

**Three independent watchdogs feed the same `#banner`**, keyed so they don't clobber each other: multilang/XML consistency check on load, duplicate-key detection on load (duplicate keys break the regex-based write path, which only ever matches the *first* same-named `<entry>`), and mtime polling every 4s for external file changes (e.g. `svn update`). All three only warn — they never auto-fix or auto-reload.

**CSV export/import** is additive-only: import updates existing keys and appends new ones, but never deletes a key that's simply absent from the CSV. Validation is two-tier: structural problems (unknown language column, duplicate/invalid key, wrong column count) are hard errors that abort the entire import with nothing written; missing translations (empty cell, a whole language column absent) are soft warnings that still let the import proceed.

**Node tests** (`test/`, run via `node --test`) write to the OS temp dir with unique filenames so they can run concurrently; follow that pattern rather than fixed filenames. (`electron/xml_store.js` and `test/` are owned by a separate porting effort — treat `xml_store.js`'s exported API as the contract and don't edit those files as part of shell work.)
