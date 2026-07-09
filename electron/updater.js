"use strict";

// 更新检查 + portable exe 自替换（从 raywrite 的 electron/updater.mjs 移植）。
// electron-updater 不支持 portable 目标，这里是它的轻量替代：
// GitHub API 查 latest release → 自动下载新 exe 到当前 exe 旁（.part 后缀）
// → 退出时 spawn 一个隐藏 explorer 等 portable launcher 释放旧 exe → 覆盖 → 重启。
// 全程不弹原生模态对话框——状态通过 IPC 推给渲染进程，由页面右下角的悬浮提示条展示
// （见 src/main.js 的 update-toast 部分），不阻塞用户正在做的事；用户不理会的话，
// 更新会在下次退出应用时自动落地。
// 替换始终写回原 exe 路径，用户的快捷方式/摆放位置不受影响（文件名里的旧版本号只是初始下载名）。
const { app, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const REPO = "ulichirock-cmyk/translation_editor"; // GitHub Release 来源，仓库迁移时改这里
const UA = { "User-Agent": "translation-editor-updater" };
const MANIFEST = "translation_editor-update.json"; // 替换协议文件名（与旧 exe 同目录）
const ULOG = "translation_editor-update.log";

let ctx = null; // { getWin, quitApp }，由 initUpdater 注入
let pending = null; // { src, version }：已暂存的新版 exe，等退出时由 explorer 拉起接力替换
let manualUrl = null; // 不支持自替换时的下载页地址，openDownloadPage() 用
let relaunchSpawned = false;
let promptedVersion = null; // 本次会话已尝试过的版本，避免后台轮询对同一版本反复触发
let busy = false;
let lastStatus = { phase: "idle" };

function initUpdater(options) {
  ctx = options;
  // 无论「立即重启」还是用户直接关窗退出：用 explorer 代理启动已暂存的新版 exe
  // （等价用户双击，父进程是 shell），真正的替换由新版进程的 runUpdateHandoff 完成。
  // 不直接 spawn 新 exe——app 的子进程会随进程树被连坐杀掉（raywrite 实测 .part 残留的根因）；
  // 也不走 PowerShell/WMI/cmd——系统脚本工具链会被安全软件选择性拦截（实测「存取被拒」）。
  app.on("before-quit", (e) => {
    if (!pending || relaunchSpawned) return;
    relaunchSpawned = true;
    e.preventDefault(); // 暂缓退出，给 explorer 转发启动请求留时间
    shellLaunch(pending.src);
    setTimeout(() => app.quit(), 500); // relaunchSpawned 已置位，这次不再拦截
  });
  if (app.isPackaged) {
    autoCheckSoon();
    // 应用可能常驻数小时，定期再看一眼
    setInterval(() => checkForUpdate(false).catch(() => {}), 6 * 60 * 60 * 1000);
  }
}

// 冷启动那一下网络/DNS 常常还没就绪：单次 5s 检查一旦联网失败，就要等 6h 才重试、
// 且全程静默无感。这里对「没连上 GitHub」做几次递增退避重试，直到查到结果为止，
// 保证新版提示条能自动浮出来。
function autoCheckSoon() {
  const delays = [5000, 20000, 60000, 180000];
  let i = 0;
  const tick = async () => {
    // checkForUpdate 返回 false 表示这次没连上 GitHub（值得再试）；其余情况（查到了、
    // 已是最新、已在下载/就绪）都算有结果，不再重试，交给 6h 定时器兜后续
    const reached = await checkForUpdate(false).catch(() => true);
    if (reached === false && i < delays.length - 1) setTimeout(tick, delays[++i]);
  };
  setTimeout(tick, delays[0]);
}

// 当前状态快照，供渲染进程挂载时主动拉取一次（补上挂载前错过的推送）
function getUpdaterStatus() {
  return lastStatus;
}

// 「不支持自替换」场景下，用户点提示条里的按钮才打开外部下载页
function openDownloadPage() {
  if (manualUrl) shell.openExternal(manualUrl);
}

// 返回值：true = 已从 GitHub 查到结果（或已在下载/就绪）；false = 没连上 GitHub，
// 值得稍后重试（autoCheckSoon 据此决定要不要退避再试）。
async function checkForUpdate(interactive = false) {
  if (busy || !ctx) return true;
  busy = true;
  try {
    if (pending) {
      broadcast({ phase: "ready", version: pending.version });
      return true;
    }
    if (interactive) broadcast({ phase: "checking" });

    const cur = app.getVersion();
    let rel;
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { ...UA, Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      rel = await res.json();
    } catch (err) {
      if (interactive) broadcastTransient({ phase: "error", message: "检查更新失败：" + String(err && err.message || err) });
      return false; // 没连上，交给退避重试
    }

    const latest = String(rel.tag_name || "").replace(/^v/, "");
    if (!latest || !newer(latest, cur)) {
      if (interactive) broadcastTransient({ phase: "up-to-date", version: cur });
      return true;
    }
    if (!interactive && promptedVersion === latest) return true;
    promptedVersion = latest;

    const asset = (rel.assets || []).find((a) => a.name && a.name.endsWith(".exe"));
    // 只有 electron-builder portable launcher 会设这个 env，天然限定 Windows 打包形态
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE;
    const canSelfUpdate = Boolean(exePath && asset);

    if (!canSelfUpdate) {
      manualUrl = rel.html_url || `https://github.com/${REPO}/releases/latest`;
      broadcast({ phase: "manual", version: latest, url: manualUrl });
      return true;
    }

    // 无需确认，发现新版本直接后台下载——提示条只展示进度，不打断使用
    broadcast({ phase: "downloading", version: latest, progress: 0 });
    const win = ctx.getWin();

    // 优先下到 exe 同目录（替换时同卷操作最快），目录不可写则兜底到临时目录
    let part = path.join(path.dirname(exePath), asset.name + ".part");
    try {
      await download(asset, part, win, latest);
    } catch {
      part = path.join(os.tmpdir(), asset.name + ".part");
      try {
        await download(asset, part, win, latest);
      } catch (err) {
        promptedVersion = null; // 允许下次自动检查重试
        broadcastTransient({ phase: "error", message: "下载更新失败：" + String(err && err.message || err) });
        return true; // 已连上 GitHub，只是下载失败，不必走联网重试
      }
    }
    // 下载完成：.part 转正为新版 exe（与旧 exe 并存），写替换协议文件。
    // 真正的替换由新版进程启动时的 runUpdateHandoff 执行。
    const stageDir = path.dirname(part);
    let staged = path.join(stageDir, asset.name);
    if (normPath(staged) === normPath(exePath)) staged = path.join(stageDir, "new-" + asset.name);
    try {
      fs.rmSync(staged, { force: true });
      fs.renameSync(part, staged);
      fs.writeFileSync(
        path.join(stageDir, MANIFEST),
        JSON.stringify({ phase: "replace", src: staged, dst: exePath, version: latest })
      );
    } catch (err) {
      promptedVersion = null;
      broadcastTransient({ phase: "error", message: "更新暂存失败：" + String(err && err.message || err) });
      return true;
    }
    pending = { src: staged, version: latest };
    broadcast({ phase: "ready", version: latest });
    return true;
  } finally {
    busy = false;
  }
}

// a > b ?（简单三段数值比较，够用于 X.Y.Z）
function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function download(asset, dest, win, version) {
  const res = await fetch(asset.browser_download_url, { headers: UA });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  let got = 0;
  let lastSent = 0;
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      if (total && win && !win.isDestroyed()) win.setProgressBar(got / total);
      const now = Date.now();
      if (total && now - lastSent > 150) {
        lastSent = now;
        broadcast({ phase: "downloading", version, progress: got / total });
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), progress, fs.createWriteStream(dest));
    if (asset.size && fs.statSync(dest).size !== asset.size) throw new Error("文件大小校验不符");
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  } finally {
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
  }
}

// 推送状态给渲染进程；lastStatus 保存快照供新挂载的页面拉取
function broadcast(status) {
  lastStatus = status;
  const win = ctx && ctx.getWin ? ctx.getWin() : null;
  if (win && !win.isDestroyed()) win.webContents.send("updater:status", status);
}

// 一次性提示（检查中/已是最新/出错），展示几秒后自动收起，回落到当前持久状态。
// 期间若已有更新的状态推送（比如退避重试进入 downloading），就不再回落去盖掉它
function broadcastTransient(status, revertMs = 4000) {
  broadcast(status);
  setTimeout(() => {
    if (lastStatus !== status) return;
    broadcast(pending ? { phase: "ready", version: pending.version } : { phase: "idle" });
  }, revertMs);
}

// ---- 自举替换（update handoff）----
// 协议：下载完成后新版 exe 与旧 exe 并存，同目录 translation_editor-update.json 记
// { phase:'replace', src:新exe, dst:旧exe }。退出时 explorer 拉起 src；src 进程启动
// 最前沿（拿单实例锁之前）读到协议 → 等旧 exe 解锁 → 删旧 → 把自身文件复制回旧路径
// （保住用户的快捷方式）→ 把协议改成 { phase:'cleanup', temp:src } → explorer 启动
// 旧路径上的新版 → 自退。接力实例启动时看到 cleanup 就后台删掉临时 exe。
// 全程只有本应用和 explorer 参与——不依赖 PowerShell/WMI/cmd（会被安全软件拦截）。

const normPath = (p) => String(p || "").replace(/\//g, "\\").toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// explorer 代理启动（等价用户双击）。spawn 的失败是异步 error 事件，try/catch
// 兜不住，必须挂空 handler，否则会把进程整个崩掉
function shellLaunch(target) {
  try {
    const child = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), [target], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

function ulog(dir, line) {
  try {
    fs.appendFileSync(path.join(dir, ULOG), `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

// main.js 启动最前调用。返回 true 表示本进程是替换接力，调用方不得继续正常启动
// （替换完成后这里自行退出）；返回 false 则正常启动（可能顺带触发后台清理）。
function runUpdateHandoff() {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!exe) return false;
  const dir = path.dirname(exe);
  const manifestPath = path.join(dir, MANIFEST);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return false;
  }
  const me = normPath(exe);
  if (m.phase === "replace" && normPath(m.src) === me) {
    replaceAndRelaunch(m, manifestPath, dir);
    return true;
  }
  if (m.phase === "replace" && normPath(m.dst) === me) {
    // 接力没发生（explorer 启动失败或用户直接开了旧版）：归零，updater 之后会重新提示
    ulog(dir, "stale replace manifest on old exe, resetting");
    try {
      fs.rmSync(m.src, { force: true });
    } catch {}
    fs.rmSync(manifestPath, { force: true });
    return false;
  }
  if (m.phase === "cleanup") cleanupTemp(m, manifestPath, dir);
  return false;
}

async function replaceAndRelaunch(m, manifestPath, dir) {
  ulog(dir, `replace start: ${m.src} -> ${m.dst}`);
  // 等旧 exe 的 portable launcher 退出释放文件锁，然后删掉旧 exe
  for (let i = 0; i < 120 && fs.existsSync(m.dst); i++) {
    try {
      fs.rmSync(m.dst);
    } catch (e) {
      if (i % 20 === 0) ulog(dir, `waiting for old exe unlock (${e.code || e.message})`);
      await sleep(500);
    }
  }
  if (fs.existsSync(m.dst)) {
    // 旧 exe 一直解不了锁：放弃替换，以新文件名重启继续用（协议归零）
    ulog(dir, "old exe still locked, give up replacing, run from new file");
    fs.rmSync(manifestPath, { force: true });
    relaunchAndExit(m.src);
    return;
  }
  try {
    fs.copyFileSync(m.src, m.dst); // 把自己复制回旧路径，快捷方式照旧可用
    fs.writeFileSync(manifestPath, JSON.stringify({ phase: "cleanup", temp: m.src }));
    ulog(dir, "replaced ok, relaunching new exe at old path");
    relaunchAndExit(m.dst);
  } catch (e) {
    ulog(dir, `copy back failed (${e.message}), run from new file`);
    fs.rmSync(manifestPath, { force: true });
    relaunchAndExit(m.src);
  }
}

function relaunchAndExit(target) {
  shellLaunch(target);
  setTimeout(() => app.exit(0), 500);
}

function cleanupTemp(m, manifestPath, dir) {
  let tries = 0;
  const timer = setInterval(() => {
    try {
      fs.rmSync(m.temp, { force: true });
    } catch {}
    if (!fs.existsSync(m.temp)) {
      clearInterval(timer);
      fs.rmSync(manifestPath, { force: true });
      ulog(dir, "cleanup done");
    } else if (++tries >= 120) {
      clearInterval(timer); // 删不掉就留着协议文件，下次启动再试
      ulog(dir, "cleanup still pending, will retry next launch");
    }
  }, 1000);
}

module.exports = {
  initUpdater,
  checkForUpdate,
  runUpdateHandoff,
  getUpdaterStatus,
  openDownloadPage,
};
