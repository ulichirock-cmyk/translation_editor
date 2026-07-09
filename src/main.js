"use strict";

const { invoke } = window.native;

// 内置语言预设：新增语言时优先从这里选，不用手填 code/name/中文名三行东西。
const LANGUAGE_PRESETS = [
  { code: "zh", name: "中文", zh: "中文" },
  { code: "en", name: "English", zh: "英语" },
  { code: "fr", name: "Français", zh: "法语" },
  { code: "es", name: "Español", zh: "西班牙语" },
  { code: "pt", name: "Português", zh: "葡萄牙语" },
  { code: "it", name: "Italiano", zh: "意大利语" },
  { code: "de", name: "Deutsch", zh: "德语" },
  { code: "tr", name: "Türkçe", zh: "土耳其语" },
  { code: "th", name: "ภาษาไทย", zh: "泰语" },
  { code: "ja", name: "日本語", zh: "日语" },
  { code: "ko", name: "한국어", zh: "韩语" },
  { code: "ru", name: "Русский", zh: "俄语" },
  { code: "vi", name: "Tiếng Việt", zh: "越南语" },
  { code: "id", name: "Bahasa Indonesia", zh: "印尼语" },
  { code: "ms", name: "Bahasa Melayu", zh: "马来语" },
  { code: "ar", name: "العربية", zh: "阿拉伯语" },
  { code: "pl", name: "Polski", zh: "波兰语" },
  { code: "nl", name: "Nederlands", zh: "荷兰语" },
  { code: "sv", name: "Svenska", zh: "瑞典语" },
  { code: "cs", name: "Čeština", zh: "捷克语" },
  { code: "el", name: "Ελληνικά", zh: "希腊语" },
  { code: "hu", name: "Magyar", zh: "匈牙利语" },
  { code: "ro", name: "Română", zh: "罗马尼亚语" },
  { code: "uk", name: "Українська", zh: "乌克兰语" },
  { code: "he", name: "עברית", zh: "希伯来语" },
  { code: "hi", name: "हिन्दी", zh: "印地语" },
  { code: "fa", name: "فارسی", zh: "波斯语" },
];
// 中文显示名映射（表头用）；缺失时回退到 XML 中的 name。从预设表派生，避免两份列表不同步。
const ZH_NAMES_BUILTIN = Object.fromEntries(LANGUAGE_PRESETS.map(p => [p.code, p.zh]));

const ZH_STORE_KEY = "translation_editor.zh_names";
const COL_WIDTHS_KEY = "translation_editor.col_widths";
const KEY_COL_ID = "__key__";
const DEFAULT_KEY_WIDTH = 240;
const DEFAULT_LANG_WIDTH = 220;
const MIN_COL_WIDTH = 80;

function loadColWidths() {
  try { return JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || "{}"); }
  catch (e) { return {}; }
}
function saveColWidths(map) {
  localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(map));
}

function loadZhCustom() {
  try { return JSON.parse(localStorage.getItem(ZH_STORE_KEY) || "{}"); }
  catch (e) { return {}; }
}
function saveZhCustom(map) {
  localStorage.setItem(ZH_STORE_KEY, JSON.stringify(map));
}
function zhNameFor(lang) {
  const custom = loadZhCustom();
  return custom[lang.code] || ZH_NAMES_BUILTIN[lang.code] || lang.name || lang.code;
}

function errMsg(err) {
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  try { return JSON.stringify(err); } catch (e) { return String(err); }
}

// 网页里普通的 window.confirm() 在 Tauri 的 WebView 里不可靠（不一定弹出来），
// 删除这类不可撤销操作统一走系统原生确认框。
async function confirmDialog(title, message) {
  try {
    return await invoke("confirm_dialog", { title, message });
  } catch (e) {
    return false;
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 把 text 里所有（大小写不敏感）匹配 query 的片段包一层 <mark>，其余部分照常转义。
function highlightHtml(text, query) {
  if (!query) return escapeHtml(text);
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let result = "";
  let i = 0;
  let idx;
  while ((idx = lower.indexOf(q, i)) !== -1) {
    result += escapeHtml(text.slice(i, idx));
    result += "<mark>" + escapeHtml(text.slice(idx, idx + q.length)) + "</mark>";
    i = idx + q.length;
  }
  result += escapeHtml(text.slice(i));
  return result;
}

const openScreen = document.getElementById("open-screen");
const openScreenMsg = document.getElementById("open-screen-msg");
const appRoot = document.getElementById("app-root");
const pathDisplay = document.getElementById("path-display");
const statusEl = document.getElementById("status");
const bannerEl = document.getElementById("banner");
const headRow = document.getElementById("head-row");
const body = document.getElementById("body");
const filterEl = document.getElementById("filter");
const emptyEl = document.getElementById("empty");

let LANGS = [];
let currentPath = null;
let lastKnownMtime = null;
let DUP_KEYS = new Set();

function dirtyCells() {
  return Array.from(body.querySelectorAll("textarea.cell-editor.dirty"));
}

// #status 平时是 display:none，只有 error/info class 才会显示；之前 setOk() 只把文字塞进
// 没人看的 title 属性，导致"保存成功""已导出"之类的提示实际上从来没显示给用户看过。
let _statusClearTimer = null;

function setOk(tip) {
  if (_statusClearTimer) { clearTimeout(_statusClearTimer); _statusClearTimer = null; }
  if (tip) {
    statusEl.textContent = tip;
    statusEl.className = "info";
    statusEl.title = "";
    _statusClearTimer = setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "";
      _statusClearTimer = null;
    }, 4000);
  } else {
    statusEl.textContent = "";
    statusEl.className = "";
    statusEl.title = "";
  }
}
function setFailed(tip) {
  if (_statusClearTimer) { clearTimeout(_statusClearTimer); _statusClearTimer = null; }
  statusEl.textContent = "Failed";
  statusEl.className = "error";
  statusEl.title = tip || "";
}

// ───────── 顶部告警条：不一致 / 重复 key / 外部改动，可以同时挂多条 ─────────

const bannerState = {};

function setBanner(key, info) {
  if (info) bannerState[key] = info; else delete bannerState[key];
  renderBanner();
}

function renderBanner() {
  const keys = Object.keys(bannerState);
  bannerEl.innerHTML = "";
  if (keys.length === 0) {
    bannerEl.classList.remove("visible");
    return;
  }
  for (const k of keys) {
    const info = bannerState[k];
    const line = document.createElement("div");
    line.className = "line";
    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = "⚠ " + info.text;
    line.appendChild(msg);
    if (info.actionLabel) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = info.actionLabel;
      btn.addEventListener("click", info.onAction);
      line.appendChild(btn);
    }
    bannerEl.appendChild(line);
  }
  bannerEl.classList.add("visible");
}

// 每次加载完 XML 校验一次：重新生成一遍在内存里跟磁盘上现有的 multilang.h/.c 比对，
// 提前发现"同事只提交了 .c 没同步 XML"这类历史遗留问题，而不是等手动发现。
// 只提示，不自动覆盖——具体该同步哪一边需要人判断。
async function checkConsistency() {
  let report;
  try {
    report = await invoke("check_multilang_consistency", { path: currentPath });
  } catch (e) {
    setBanner("multilangInconsistency", null); // 没找到 gen_multilang.py 时静默跳过，不是错误
    return;
  }
  if (report.consistent) {
    setBanner("multilangInconsistency", null);
  } else {
    const which = [!report.h_matches && "multilang.h", !report.c_matches && "multilang.c"]
      .filter(Boolean).join(" / ");
    setBanner("multilangInconsistency", {
      text: `${which} 与当前 translations.xml 不一致（可能有改动未同步），建议核对后再编辑。目录：${report.dir}`,
    });
  }
}

// 统一入口：写完 XML 之后调它——重新生成 multilang.h/.c、把结果（含生成过程中的
// WARNING，比如某个 key 缺翻译）展示出来，再刷新一致性横幅。新增/删除条目、新增/删除
// 语言、CSV 导入这些结构性操作以前只改 XML 不触发这一步，导致 multilang.c 长期滞后
// 于 XML、横幅也不会报警——这是工具自己在制造"文件对不上"，所以每个改 XML 的操作
// 成功之后都要走这里，而不是只有"保存"按钮才走。
async function regenAndReport(afterLabel) {
  let summary;
  try {
    summary = await invoke("regen_multilang", { path: currentPath });
  } catch (err) {
    setFailed(`${afterLabel}成功，但 multilang 重新生成失败：${errMsg(err)}`);
    await checkConsistency();
    return;
  }
  const [headline, ...warnLines] = summary.split("\n");
  setOk(`${afterLabel}，已重新生成 multilang（${headline}）`);
  if (warnLines.length) {
    showResultModal("multilang 生成警告", `${afterLabel}成功，但生成时有 ${warnLines.length} 条提示：`, warnLines);
  }
  await checkConsistency();
}

// 加载时扫一遍 key 是否有重复；重复的话文件里对同名 key 的编辑/删除只会作用到第一个，
// 后面的会被静默忽略，所以只提示、不自动合并，需要人工处理。
function updateDuplicateKeysBanner(entries) {
  const counts = new Map();
  for (const e of entries) counts.set(e.key, (counts.get(e.key) || 0) + 1);
  DUP_KEYS = new Set([...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k));
  if (DUP_KEYS.size === 0) {
    setBanner("duplicateKeys", null);
    return;
  }
  const list = [...DUP_KEYS].map(k => `"${k}"`).join("、");
  setBanner("duplicateKeys", {
    text: `发现重复 key：${list}（同名条目里，保存/删除只会作用到文件中第 1 个，其余会被忽略），建议手动合并或改名后再继续编辑。`,
  });
}

// ───────── 外部改动检测：定时对比文件 mtime，发现变化就提示重新加载 ─────────

let mtimePollTimer = null;

function startMtimePolling() {
  stopMtimePolling();
  mtimePollTimer = setInterval(async () => {
    if (!currentPath) return;
    try {
      const mtime = await invoke("get_file_mtime", { path: currentPath });
      if (lastKnownMtime !== null && mtime !== lastKnownMtime) {
        setBanner("externalChange", {
          text: "translations.xml 已被外部程序修改（比如 svn update），当前表格显示的内容可能是旧的。",
          actionLabel: "重新加载",
          onAction: reloadAfterExternalChange,
        });
      }
    } catch (e) { /* 文件暂时访问不到就跳过这一次轮询 */ }
  }, 4000);
}

function stopMtimePolling() {
  if (mtimePollTimer) { clearInterval(mtimePollTimer); mtimePollTimer = null; }
}

async function reloadAfterExternalChange() {
  if (dirtyCells().length > 0) {
    const ok = await confirmDialog("重新加载", "当前有未保存的修改，重新加载会丢弃这些修改，确定继续吗？");
    if (!ok) return;
  }
  setBanner("externalChange", null);
  try {
    await loadData();
    await checkConsistency();
  } catch (e) {
    showOpenScreen("重新加载失败：" + errMsg(e));
  }
}

// ───────── 文件选择 / 启动 ─────────

function showOpenScreen(msg) {
  openScreenMsg.textContent = msg || "尚未选择 translations.xml 文件";
  openScreen.classList.add("visible");
  appRoot.classList.remove("visible");
}

function showApp() {
  openScreen.classList.remove("visible");
  appRoot.classList.add("visible");
  pathDisplay.textContent = currentPath;
  pathDisplay.title = currentPath;
}

async function pickAndLoad() {
  let picked;
  try {
    picked = await invoke("pick_xml_file");
  } catch (err) {
    setFailed(errMsg(err));
    return;
  }
  if (!picked) return;
  currentPath = picked;
  try {
    await invoke("remember_path", { path: currentPath });
  } catch (e) { /* 记住路径失败不影响本次使用 */ }
  showApp();
  try {
    await loadData();
    await checkConsistency();
    startMtimePolling();
  } catch (e) {
    showOpenScreen("加载失败：" + errMsg(e));
  }
}

async function startup() {
  let initial = null;
  try {
    initial = await invoke("resolve_initial_path");
  } catch (e) { /* 忽略，走打开对话框 */ }

  if (!initial) {
    showOpenScreen();
    return;
  }
  currentPath = initial;
  showApp();
  try {
    await loadData();
    await checkConsistency();
    startMtimePolling();
  } catch (e) {
    showOpenScreen("加载失败：" + errMsg(e));
  }
}

// ───────── 数据加载与渲染 ─────────

async function loadData() {
  const data = await invoke("load_translations", { path: currentPath });
  LANGS = data.langs;
  lastKnownMtime = data.mtime;
  updateDuplicateKeysBanner(data.entries);
  buildColgroup();
  buildHead();
  buildBody(data.entries);
  updateSaveButton();
  setOk();
}

function buildColgroup() {
  const grid = document.getElementById("grid");
  const existing = grid.querySelector("colgroup");
  if (existing) existing.remove();
  const widths = loadColWidths();
  const cg = document.createElement("colgroup");
  const keyCol = document.createElement("col");
  keyCol.dataset.colId = KEY_COL_ID;
  keyCol.style.width = (widths[KEY_COL_ID] || DEFAULT_KEY_WIDTH) + "px";
  cg.appendChild(keyCol);
  for (const lang of LANGS) {
    const c = document.createElement("col");
    c.dataset.colId = lang.code;
    c.style.width = (widths[lang.code] || DEFAULT_LANG_WIDTH) + "px";
    cg.appendChild(c);
  }
  grid.insertBefore(cg, grid.firstChild);
}

function getCol(colId) {
  return document.querySelector(
    `#grid > colgroup > col[data-col-id="${CSS.escape(colId)}"]`);
}

function addResizer(th, colId) {
  const r = document.createElement("div");
  r.className = "col-resizer";
  r.title = "拖动调整列宽";
  r.addEventListener("pointerdown", (e) => startResize(e, r, colId));
  th.appendChild(r);
}

function startResize(e, handle, colId) {
  const col = getCol(colId);
  if (!col) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = col.getBoundingClientRect().width;
  document.body.classList.add("col-resizing");
  handle.classList.add("active");
  let pending = false;

  function move(ev) {
    const w = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX));
    col.style.width = w + "px";
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => { pending = false; autosizeVisible(); });
    }
  }
  function up() {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
    document.body.classList.remove("col-resizing");
    handle.classList.remove("active");
    const widths = loadColWidths();
    widths[colId] = Math.round(parseFloat(col.style.width));
    saveColWidths(widths);
    autosizeVisible();
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
}

function buildHead() {
  headRow.innerHTML = "";
  const th0 = document.createElement("th");
  th0.className = "key-col";
  th0.textContent = "Key";
  addResizer(th0, KEY_COL_ID);
  headRow.appendChild(th0);
  for (const lang of LANGS) {
    const th = document.createElement("th");
    th.className = "lang-col";
    const wrap = document.createElement("div");
    wrap.className = "col-head";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = zhNameFor(lang);
    name.title = `${lang.code} · ${lang.name}`;
    wrap.appendChild(name);
    const del = document.createElement("button");
    del.className = "icon-btn";
    del.type = "button";
    del.title = `删除语言 ${lang.code}`;
    del.textContent = "×";
    del.addEventListener("click", () => deleteLanguage(lang));
    wrap.appendChild(del);
    th.appendChild(wrap);
    addResizer(th, lang.code);
    headRow.appendChild(th);
  }
}

// Lazy autosize: only textareas currently on (or near) screen pay the
// scrollHeight/layout cost. This keeps initial paint cheap on big tables.
let _autosizeObserver = null;
const _visibleTAs = new Set();

function _ensureAutosizeObserver() {
  if (_autosizeObserver) return _autosizeObserver;
  const root = document.querySelector(".table-wrap");
  _autosizeObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        if (!_visibleTAs.has(e.target)) {
          _visibleTAs.add(e.target);
          autosize(e.target);
        }
      } else {
        _visibleTAs.delete(e.target);
      }
    }
  }, { root, rootMargin: "400px 0px" });
  return _autosizeObserver;
}

function _resetAutosizeObserver() {
  if (_autosizeObserver) _autosizeObserver.disconnect();
  _visibleTAs.clear();
  _autosizeObserver = null;
}

function buildRow(entry, newTAs) {
  const tr = document.createElement("tr");
  tr.dataset.key = entry.key;
  if (DUP_KEYS.has(entry.key)) tr.classList.add("dup-key");
  const tdKey = document.createElement("td");
  tdKey.className = "key-cell";
  const keyInner = document.createElement("div");
  keyInner.className = "key-cell-inner";
  const keySpan = document.createElement("span");
  keySpan.className = "key-text";
  keySpan.textContent = entry.key;
  keySpan.title = entry.key;
  keyInner.appendChild(keySpan);
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn";
  delBtn.type = "button";
  delBtn.title = `删除条目 ${entry.key}`;
  delBtn.textContent = "×";
  delBtn.addEventListener("click", () => deleteEntry(entry.key));
  keyInner.appendChild(delBtn);
  tdKey.appendChild(keyInner);
  tr.appendChild(tdKey);

  for (const lang of LANGS) {
    const td = document.createElement("td");
    td.className = "lang-cell";
    const ta = document.createElement("textarea");
    ta.className = "cell-editor";
    ta.rows = 1;
    ta.value = entry.values[lang.code] || "";
    ta.dataset.key = entry.key;
    ta.dataset.code = lang.code;
    ta.dataset.original = ta.value;
    ta.addEventListener("input", onInput);
    ta.addEventListener("blur", onBlur);
    ta.addEventListener("keydown", onKeyDown);
    td.appendChild(ta);
    tr.appendChild(td);
    newTAs.push(ta);
  }
  return tr;
}

function buildBody(entries) {
  body.innerHTML = "";
  _resetAutosizeObserver();
  const obs = _ensureAutosizeObserver();

  const CHUNK = 80;
  let i = 0;
  function renderChunk() {
    const frag = document.createDocumentFragment();
    const newTAs = [];
    const end = Math.min(i + CHUNK, entries.length);
    for (; i < end; i++) {
      frag.appendChild(buildRow(entries[i], newTAs));
    }
    body.appendChild(frag);
    for (const ta of newTAs) obs.observe(ta);
    applyFilter();
    if (i < entries.length) {
      requestAnimationFrame(renderChunk);
    }
  }
  renderChunk();
}

function autosizeVisible() {
  for (const ta of _visibleTAs) autosize(ta);
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(autosizeVisible, 80);
});

// 设 min-height 而不是 height：内容需要的高度优先保证不裁切/不出现滚动条，
// 同行如果别的语言列更长把行撑高了，CSS 里的 height:100% 会再把这一格填满，
// 两者取较大值——这样点进单元格时蓝色聚焦框才会盖满整个格子，而不是只包住文字本身。
function autosize(ta) {
  ta.style.minHeight = "0px";
  ta.style.minHeight = Math.max(36, ta.scrollHeight) + "px";
}

function onInput(e) {
  const ta = e.target;
  ta.classList.remove("saved", "error");
  if (ta.value !== ta.dataset.original) ta.classList.add("dirty");
  else ta.classList.remove("dirty");
  autosize(ta);
  updateSaveButton();

  // 编辑内容时同步刷新这一格已有的搜索高亮（比如查找替换写入新值之后）。
  const q = filterEl.value.trim().toLowerCase();
  if (q) {
    const hl = ta.closest("td.lang-cell")?.querySelector(".cell-highlight");
    if (hl) hl.innerHTML = highlightHtml(ta.value, q);
  }
}

function onKeyDown(e) {
  // Ctrl+Enter / Cmd+Enter saves all dirty cells.
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    saveAll();
    return;
  }
  // Esc reverts
  if (e.key === "Escape") {
    const ta = e.target;
    ta.value = ta.dataset.original;
    ta.classList.remove("dirty", "saved", "error");
    autosize(ta);
    updateSaveButton();
    ta.blur();
  }
}

function onBlur(e) {
  // No auto-save: changes are flushed via the 保存 button (or Ctrl+S).
}

async function saveAll() {
  const dirty = dirtyCells();
  if (dirty.length === 0) return;

  // 保存前比对 mtime：轮询间隔有 4 秒窗口期，点保存这一刻再确认一次，
  // 避免不知不觉盖掉外部程序（比如 svn update）刚落地的改动。
  try {
    const diskMtime = await invoke("get_file_mtime", { path: currentPath });
    if (lastKnownMtime !== null && diskMtime !== lastKnownMtime) {
      const ok = await confirmDialog("文件已被修改", "translations.xml 在你打开后被外部程序改动过，继续保存会覆盖那些改动，确定继续吗？");
      if (!ok) return;
    }
  } catch (e) { /* 拿不到就跳过这次检查，不阻塞保存 */ }

  const saveBtn = document.getElementById("btn-save");
  saveBtn.disabled = true;

  // 一次性批量保存，而不是每个脏格各自读全文件-改-写全文件；任意一条失败就整体不写入，
  // 不会留下"保存了一半"的文件状态。
  const edits = dirty.map(ta => ({ key: ta.dataset.key, code: ta.dataset.code, value: ta.value }));
  try {
    await invoke("save_cells", { path: currentPath, edits });
  } catch (err) {
    const msg = errMsg(err);
    const m = msg.match(/key='([^']+)'/);
    if (m) {
      for (const ta of dirty) {
        if (ta.dataset.key === m[1]) ta.classList.add("error");
      }
      setFailed(`保存失败，key "${m[1]}" 出错，本次 ${dirty.length} 处修改均未写入：${msg}`);
    } else {
      dirty.forEach(ta => ta.classList.add("error"));
      setFailed(`保存失败，本次 ${dirty.length} 处修改均未写入：${msg}`);
    }
    updateSaveButton();
    return;
  }

  for (const ta of dirty) {
    ta.dataset.original = ta.value;
    ta.classList.remove("dirty", "error");
    ta.classList.add("saved");
    setTimeout(() => ta.classList.remove("saved"), 1200);
  }

  // 更新已知 mtime，避免下一次轮询把我们自己刚写的这次保存误判成"外部改动"。
  try {
    lastKnownMtime = await invoke("get_file_mtime", { path: currentPath });
  } catch (e) { /* 拿不到就算了，下次轮询顶多多提示一次 */ }
  await regenAndReport("保存");
  updateSaveButton();
}

function updateSaveButton() {
  const count = dirtyCells().length;
  const btn = document.getElementById("btn-save");
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `保存 (${count})` : "保存";
  // 脏格数量变化时同步给主进程，供关窗保护判断（见 preload 的 setDirty）。
  window.native.setDirty(count > 0);
}

function applyFilter() {
  const q = filterEl.value.trim().toLowerCase();
  let visible = 0;
  for (const tr of body.children) {
    let match;
    if (!q) {
      match = true;
    } else {
      match = tr.dataset.key.toLowerCase().includes(q);
      if (!match) {
        for (const ta of tr.querySelectorAll("textarea")) {
          if (ta.value.toLowerCase().includes(q)) { match = true; break; }
        }
      }
    }
    tr.classList.toggle("hidden", !match);
    if (match) visible++;
    updateRowHighlight(tr, q);
  }
  emptyEl.style.display = visible === 0 ? "block" : "none";
}

// 高亮匹配文字：key 列直接改 innerHTML；语言列的 textarea 不能放富文本，
// 所以在它背后叠一层同款排版的 div，只画 <mark> 的高亮背景，textarea 本身
// 背景透明、文字仍在最上层可编辑——不影响正常输入/光标/选区。
function updateRowHighlight(tr, q) {
  const keySpan = tr.querySelector(".key-text");
  if (keySpan) keySpan.innerHTML = highlightHtml(tr.dataset.key, q);

  for (const td of tr.querySelectorAll("td.lang-cell")) {
    const ta = td.querySelector("textarea.cell-editor");
    let hl = td.querySelector(".cell-highlight");
    if (!q) {
      if (hl) hl.remove();
      continue;
    }
    if (!hl) {
      hl = document.createElement("div");
      hl.className = "cell-highlight";
      td.insertBefore(hl, ta);
    }
    hl.innerHTML = highlightHtml(ta.value, q);
  }
}

filterEl.addEventListener("input", applyFilter);

// ───────── modal helpers ─────────

function openModal(title, fields, onSubmit) {
  return new Promise(resolve => {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    const modal = document.createElement("div");
    modal.className = "modal";
    const h2 = document.createElement("h2");
    h2.textContent = title;
    modal.appendChild(h2);
    const inputs = {};
    for (const f of fields) {
      const wrap = document.createElement("div");
      wrap.className = "field";
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = document.createElement("input");
      input.type = "text";
      input.value = f.value || "";
      if (f.placeholder) input.placeholder = f.placeholder;
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); ok.click(); }
      });
      wrap.appendChild(label);
      wrap.appendChild(input);
      modal.appendChild(wrap);
      inputs[f.name] = input;
    }
    const err = document.createElement("div");
    err.className = "err";
    modal.appendChild(err);
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "primary";
    ok.textContent = "确定";
    actions.appendChild(cancel);
    actions.appendChild(ok);
    modal.appendChild(actions);
    mask.appendChild(modal);
    document.body.appendChild(mask);
    setTimeout(() => fields[0] && inputs[fields[0].name].focus(), 0);

    const close = (result) => { document.body.removeChild(mask); resolve(result); };
    cancel.addEventListener("click", () => close(null));
    mask.addEventListener("click", e => { if (e.target === mask) close(null); });
    document.addEventListener("keydown", function onKey(e) {
      if (!document.body.contains(mask)) { document.removeEventListener("keydown", onKey); return; }
      if (e.key === "Escape") { close(null); document.removeEventListener("keydown", onKey); }
    });
    let submitting = false;
    ok.addEventListener("click", async () => {
      if (submitting) return;
      submitting = true;
      ok.disabled = true;
      const values = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value.trim()]));
      const msg = await onSubmit(values);
      submitting = false;
      ok.disabled = false;
      if (msg) { err.textContent = msg; return; }
      close(values);
    });
  });
}

// ───────── operations ─────────

async function addEntry() {
  if (dirtyCells().length > 0) {
    const ok = await confirmDialog("未保存的修改", "当前有未保存的修改，新增条目会重新加载表格，未保存的修改将会丢失，确定继续吗？");
    if (!ok) return;
  }
  await openModal("新增条目", [
    { name: "key", label: "Key（唯一标识）", placeholder: "例如 NEW_LABEL" },
  ], async (vals) => {
    if (!vals.key) return "key 不能为空";
    try {
      await invoke("add_entry", { path: currentPath, key: vals.key, values: {} });
    } catch (err) {
      return errMsg(err);
    }
    await loadData();
    await regenAndReport("新增条目");
    return null;
  });
}

async function deleteEntry(key) {
  let message = `删除条目 "${key}"？\n此操作不可撤销。`;
  if (dirtyCells().length > 0) {
    message += "\n\n当前还有未保存的修改，删除后表格会重新加载，这些修改也会一并丢失。";
  }
  const ok = await confirmDialog("删除条目", message);
  if (!ok) return;
  try {
    await invoke("delete_entry", { path: currentPath, key });
  } catch (err) {
    setFailed(errMsg(err));
    return;
  }
  await loadData();
  await regenAndReport("删除条目");
}

// 新增语言：默认只需要从内置语言下拉里选一个，不用手填 code/name/中文名；
// 下拉最后留一个"自定义…"选项，选了才会展开这三个输入框，兜底预设表覆盖不到的语言。
function openAddLanguageModal() {
  return new Promise(resolve => {
    const existingCodes = new Set(LANGS.map(l => l.code));
    const presets = LANGUAGE_PRESETS.filter(p => !existingCodes.has(p.code));

    const mask = document.createElement("div");
    mask.className = "modal-mask";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `
      <h2>新增语言</h2>
      <div class="field">
        <label>选择语言</label>
        <select id="al-preset">
          ${presets.map(p => `<option value="${p.code}">${escapeHtml(p.zh)}（${p.code} · ${escapeHtml(p.name)}）</option>`).join("")}
          <option value="__custom__">自定义…</option>
        </select>
      </div>
      <div class="field" id="al-code-field">
        <label>code（语言代码，2-8 位小写字母）</label>
        <input type="text" id="al-code" placeholder="例如 ja" autocomplete="off">
      </div>
      <div class="field" id="al-name-field">
        <label>name（XML 中的语言名）</label>
        <input type="text" id="al-name" placeholder="例如 日本語" autocomplete="off">
      </div>
      <div class="field" id="al-zh-field">
        <label>中文显示名（仅前端）</label>
        <input type="text" id="al-zh" placeholder="例如 日语" autocomplete="off">
      </div>
      <div class="err"></div>
      <div class="actions">
        <button type="button" id="al-cancel">取消</button>
        <button type="button" id="al-ok" class="primary">添加</button>
      </div>
    `;
    mask.appendChild(modal);
    document.body.appendChild(mask);

    const presetSelect = modal.querySelector("#al-preset");
    const codeField = modal.querySelector("#al-code-field");
    const nameField = modal.querySelector("#al-name-field");
    const zhField = modal.querySelector("#al-zh-field");
    const codeInput = modal.querySelector("#al-code");
    const nameInput = modal.querySelector("#al-name");
    const zhInput = modal.querySelector("#al-zh");
    const errEl = modal.querySelector(".err");
    const okBtn = modal.querySelector("#al-ok");
    for (const input of [codeInput, nameInput, zhInput]) {
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); okBtn.click(); }
      });
    }

    function syncCustomFields() {
      const isCustom = presetSelect.value === "__custom__";
      codeField.style.display = isCustom ? "" : "none";
      nameField.style.display = isCustom ? "" : "none";
      zhField.style.display = isCustom ? "" : "none";
    }
    presetSelect.addEventListener("change", syncCustomFields);
    syncCustomFields();

    setTimeout(() => presetSelect.focus(), 0);

    const close = (result) => { document.body.removeChild(mask); resolve(result); };
    modal.querySelector("#al-cancel").addEventListener("click", () => close(null));
    mask.addEventListener("click", e => { if (e.target === mask) close(null); });
    document.addEventListener("keydown", function onKey(e) {
      if (!document.body.contains(mask)) { document.removeEventListener("keydown", onKey); return; }
      if (e.key === "Escape") { close(null); document.removeEventListener("keydown", onKey); }
    });

    let submitting = false;
    okBtn.addEventListener("click", async () => {
      if (submitting) return;
      submitting = true;
      okBtn.disabled = true;
      let vals;
      if (presetSelect.value === "__custom__") {
        vals = {
          code: codeInput.value.trim(),
          name: nameInput.value.trim(),
          zh: zhInput.value.trim(),
        };
        if (!vals.code) { errEl.textContent = "code 不能为空"; submitting = false; okBtn.disabled = false; return; }
        if (!vals.name) { errEl.textContent = "name 不能为空"; submitting = false; okBtn.disabled = false; return; }
      } else {
        const preset = LANGUAGE_PRESETS.find(p => p.code === presetSelect.value);
        vals = { code: preset.code, name: preset.name, zh: preset.zh };
      }
      try {
        await invoke("add_language", { path: currentPath, code: vals.code, name: vals.name });
      } catch (err) {
        errEl.textContent = errMsg(err);
        submitting = false;
        okBtn.disabled = false;
        return;
      }
      if (vals.zh) {
        const map = loadZhCustom();
        map[vals.code] = vals.zh;
        saveZhCustom(map);
      }
      close(vals);
    });
  });
}

async function addLanguage() {
  if (dirtyCells().length > 0) {
    const ok = await confirmDialog("未保存的修改", "当前有未保存的修改，新增语言会重新加载表格，未保存的修改将会丢失，确定继续吗？");
    if (!ok) return;
  }
  const result = await openAddLanguageModal();
  if (result) {
    await loadData();
    await regenAndReport("新增语言");
  }
}

async function deleteLanguage(lang) {
  let message = `删除语言 "${lang.code} · ${lang.name}"？\n所有条目里的 <${lang.code}> 标签都会被移除，且后续语言 id 会重新顺序排列。\n请记得同步更新 common_data.h 中 GetCurrentFontType() 的字体映射。`;
  if (dirtyCells().length > 0) {
    message += "\n\n当前还有未保存的修改，删除后表格会重新加载，这些修改也会一并丢失。";
  }
  const ok = await confirmDialog("删除语言", message);
  if (!ok) return;
  try {
    await invoke("delete_language", { path: currentPath, code: lang.code });
  } catch (err) {
    setFailed(errMsg(err));
    return;
  }
  const map = loadZhCustom();
  if (map[lang.code]) { delete map[lang.code]; saveZhCustom(map); }
  await loadData();
  await regenAndReport("删除语言");
}

// ───────── 查找替换（跨全表） ─────────
// 只在页面上标脏，不直接写文件——跟其它编辑操作一致，替换完之后用户看一眼哪些格变黄了，
// 确认没问题再点保存，方便手误后用 Esc 单格撤销。

function replaceAllOccurrences(text, find, replace, caseSensitive) {
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? find : find.toLowerCase();
  if (!needle) return { text, count: 0 };
  let count = 0;
  let result = "";
  let i = 0;
  let idx;
  while ((idx = hay.indexOf(needle, i)) !== -1) {
    result += text.slice(i, idx) + replace;
    i = idx + needle.length;
    count++;
  }
  result += text.slice(i);
  return { text: result, count };
}

// 查找替换用一个不带遮罩的悬浮面板（不是 modal），停在右上角——这样弹窗开着的时候
// 表格其它地方仍然能正常选中/复制（比如泰语、阿拉伯语这类不好直接打字的语言，
// 直接从表格里复制原文粘到查找框里更方便），不会像全屏遮罩那样把整张表都罩住点不了。
let _findReplacePanel = null;

function openFindReplaceModal() {
  return new Promise(resolve => {
    if (_findReplacePanel) {
      _findReplacePanel.querySelector("#fr-find")?.focus();
      resolve(null);
      return;
    }

    const modal = document.createElement("div");
    modal.className = "modal find-replace-panel";
    modal.innerHTML = `
      <h2>查找替换 <button type="button" id="fr-close" class="icon-btn" title="关闭">×</button></h2>
      <div class="field"><label>查找</label><input type="text" id="fr-find" autocomplete="off"></div>
      <div class="field"><label>替换为</label><input type="text" id="fr-replace" autocomplete="off"></div>
      <div class="field">
        <label>语言范围</label>
        <select id="fr-lang"></select>
      </div>
      <div class="field-row"><label><input type="checkbox" id="fr-filtered"> 仅当前筛选结果里的行</label></div>
      <div class="field-row"><label><input type="checkbox" id="fr-case"> 区分大小写</label></div>
      <div class="err"></div>
      <div class="actions">
        <button type="button" id="fr-cancel">取消</button>
        <button type="button" id="fr-ok" class="primary">替换</button>
      </div>
    `;
    document.body.appendChild(modal);
    _findReplacePanel = modal;

    const findInput = modal.querySelector("#fr-find");
    const replaceInput = modal.querySelector("#fr-replace");
    const langSelect = modal.querySelector("#fr-lang");
    const filteredCheck = modal.querySelector("#fr-filtered");
    const caseCheck = modal.querySelector("#fr-case");
    const errEl = modal.querySelector(".err");

    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "全部语言";
    langSelect.appendChild(allOpt);
    for (const lang of LANGS) {
      const opt = document.createElement("option");
      opt.value = lang.code;
      opt.textContent = zhNameFor(lang);
      langSelect.appendChild(opt);
    }

    setTimeout(() => findInput.focus(), 0);

    const close = (result) => {
      document.body.removeChild(modal);
      _findReplacePanel = null;
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    function onKey(e) {
      if (e.key === "Escape") close(null);
    }
    modal.querySelector("#fr-cancel").addEventListener("click", () => close(null));
    modal.querySelector("#fr-close").addEventListener("click", () => close(null));
    document.addEventListener("keydown", onKey);

    modal.querySelector("#fr-ok").addEventListener("click", () => {
      const find = findInput.value;
      if (!find) { errEl.textContent = "查找内容不能为空"; return; }
      const replace = replaceInput.value;
      const langScope = langSelect.value;
      const onlyFiltered = filteredCheck.checked;
      const caseSensitive = caseCheck.checked;

      const rows = onlyFiltered
        ? Array.from(body.children).filter(tr => !tr.classList.contains("hidden"))
        : Array.from(body.children);

      let occCount = 0;
      let cellCount = 0;
      for (const tr of rows) {
        const tas = langScope
          ? Array.from(tr.querySelectorAll(`textarea[data-code="${CSS.escape(langScope)}"]`))
          : Array.from(tr.querySelectorAll("textarea.cell-editor"));
        for (const ta of tas) {
          const { text, count } = replaceAllOccurrences(ta.value, find, replace, caseSensitive);
          if (count > 0) {
            ta.value = text;
            ta.dispatchEvent(new Event("input"));
            occCount += count;
            cellCount++;
          }
        }
      }
      if (occCount === 0) {
        errEl.textContent = "没有找到匹配内容";
        return;
      }
      close({ occCount, cellCount });
    });
  });
}

async function findReplace() {
  const result = await openFindReplaceModal();
  if (result) {
    setOk(`查找替换完成：共替换 ${result.occCount} 处（${result.cellCount} 个单元格），尚未保存，请检查后点击保存`);
  }
}

// ───────── CSV 导出 / 导入 ─────────

// 只展示结果，不接受输入：导出成功提示、导入的校验错误/警告列表都走这个。
function showResultModal(title, summary, lines) {
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  const modal = document.createElement("div");
  modal.className = "modal result-modal";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  modal.appendChild(h2);
  const p = document.createElement("p");
  p.className = "summary";
  p.textContent = summary;
  modal.appendChild(p);
  if (lines && lines.length) {
    const list = document.createElement("ul");
    list.className = "issue-list";
    for (const line of lines) {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    }
    modal.appendChild(list);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "primary";
  ok.textContent = "知道了";
  actions.appendChild(ok);
  modal.appendChild(actions);
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const close = () => document.body.removeChild(mask);
  ok.addEventListener("click", close);
  mask.addEventListener("click", e => { if (e.target === mask) close(); });
  document.addEventListener("keydown", function onKey(e) {
    if (!document.body.contains(mask)) { document.removeEventListener("keydown", onKey); return; }
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  });
}

function defaultCsvName() {
  const base = currentPath.replace(/\\/g, "/").split("/").pop() || "translations.xml";
  return base.replace(/\.xml$/i, "") + ".csv";
}

async function exportCsv() {
  let target;
  try {
    target = await invoke("pick_csv_save_path", { defaultName: defaultCsvName() });
  } catch (err) {
    setFailed(errMsg(err));
    return;
  }
  if (!target) return;
  try {
    await invoke("export_csv", { path: currentPath, csvPath: target });
    setOk(`已导出到 ${target}`);
  } catch (err) {
    setFailed(errMsg(err));
  }
}

// 导入会直接改磁盘上的 XML（新增+更新，不删除 CSV 里没出现的 key），所以先跟保存
// 一样提醒一下未保存的修改会丢失；校验没通过则整份 CSV 都不会生效，弹窗列出问题。
async function importCsv() {
  let picked;
  try {
    picked = await invoke("pick_csv_open_path");
  } catch (err) {
    setFailed(errMsg(err));
    return;
  }
  if (!picked) return;

  if (dirtyCells().length > 0) {
    const ok = await confirmDialog("导入 CSV", "当前有未保存的修改，导入 CSV 会重新加载表格，未保存的修改将会丢失，确定继续吗？");
    if (!ok) return;
  }

  let report;
  try {
    report = await invoke("import_csv", { path: currentPath, csvPath: picked });
  } catch (err) {
    const parts = errMsg(err).split("\n");
    showResultModal("导入失败", parts[0], parts.slice(1));
    return;
  }

  await loadData();

  const summary = `导入完成：新增 ${report.added} 条，更新 ${report.updated} 条` +
    (report.warnings.length ? `，${report.warnings.length} 条提示` : "");
  if (report.warnings.length) {
    showResultModal("导入完成", summary, report.warnings);
  }
  await regenAndReport(summary);
}

document.getElementById("btn-add-entry").addEventListener("click", addEntry);
document.getElementById("btn-add-lang").addEventListener("click", addLanguage);
document.getElementById("btn-find-replace").addEventListener("click", findReplace);
document.getElementById("btn-save").addEventListener("click", saveAll);
document.getElementById("btn-open").addEventListener("click", pickAndLoad);
document.getElementById("btn-open-initial").addEventListener("click", pickAndLoad);
document.getElementById("btn-export-csv").addEventListener("click", exportCsv);
document.getElementById("btn-import-csv").addEventListener("click", importCsv);

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    saveAll();
  }
});

// 关窗保护由主进程负责：脏格状态经 window.native.setDirty 同步给主进程，
// 主进程在 win.on('close') 里若有脏数据则拦下并弹原生确认框（见 electron/main.js）。

// ---- 自动更新提示条（右下角悬浮，移植自 raywrite 的 UpdateBanner.vue）----
// 状态全部来自主进程 IPC 推送（electron/updater.js 的 broadcast），这里只负责展示：
// 发现新版自动后台下载并显示进度；下载就绪后给「立即重启」按钮；「稍后」只隐藏提示，
// 已下载好的更新仍会在下次退出应用时自动落地。
(function initUpdateToast() {
  const updater = window.native.updater;
  if (!updater) return;
  const toastEl = document.getElementById("update-toast");
  let restarting = false;
  let lastVersion = "";

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function render(status) {
    const phase = (status && status.phase) || "idle";
    toastEl.className = phase === "idle" ? "" : "visible " + phase;
    if (phase === "idle") { toastEl.innerHTML = ""; return; }
    const v = esc(status.version || "");
    let html = "";
    if (phase === "checking") {
      html = `<span class="update-spinner"></span><span class="update-text">正在检查更新…</span>`;
    } else if (phase === "downloading") {
      const pct = status.progress != null ? Math.round(status.progress * 100) : null;
      html = `<span class="update-spinner"></span>` +
        `<span class="update-text">正在下载更新 v${v}` +
        (pct != null ? `<span class="update-pct">${pct}%</span>` : "") + `</span>` +
        `<span class="update-bar"><span class="update-bar-fill" style="width:${(status.progress || 0) * 100}%"></span></span>`;
    } else if (phase === "ready") {
      html = `<span class="update-dot"></span><span class="update-text">新版本 v${v} 已就绪</span>` +
        `<button type="button" class="update-action" data-act="restart"${restarting ? " disabled" : ""}>${restarting ? "重启中…" : "立即重启"}</button>` +
        `<button type="button" class="update-close" data-act="dismiss" title="稍后">×</button>`;
    } else if (phase === "manual") {
      html = `<span class="update-dot"></span><span class="update-text">新版本 v${v} 可用</span>` +
        `<button type="button" class="update-action" data-act="download">打开下载页</button>` +
        `<button type="button" class="update-close" data-act="dismiss" title="稍后">×</button>`;
    } else if (phase === "up-to-date") {
      html = `<span class="update-dot ok"></span><span class="update-text">已是最新版本</span>`;
    } else if (phase === "error") {
      html = `<span class="update-dot err"></span><span class="update-text">${esc(status.message || "更新出错")}</span>` +
        `<button type="button" class="update-close" data-act="dismiss" title="关闭">×</button>`;
    }
    toastEl.innerHTML = html;
  }

  toastEl.addEventListener("click", e => {
    const act = e.target && e.target.dataset ? e.target.dataset.act : null;
    if (!act) return;
    if (act === "dismiss") {
      // 「稍后」：仅隐藏本地提示，已下载好的更新仍会在下次退出应用时自动落地
      render({ phase: "idle" });
    } else if (act === "download") {
      updater.openDownloadPage().catch(() => {});
    } else if (act === "restart") {
      if (restarting) return;
      restarting = true;
      render({ phase: "ready", version: lastVersion });
      updater.restart().catch(() => {});
      // 关窗保护可能拦下重启（用户在确认框点了取消）：几秒后恢复按钮可再点
      setTimeout(() => {
        if (restarting) { restarting = false; render({ phase: "ready", version: lastVersion }); }
      }, 4000);
    }
  });

  const onStatus = s => { if (s && s.version) lastVersion = s.version; render(s); };
  updater.getStatus().then(s => { if (s) onStatus(s); }).catch(() => {});
  updater.onStatus(onStatus);
})();

startup().catch(console.error);
