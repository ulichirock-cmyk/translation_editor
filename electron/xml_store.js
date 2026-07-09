// 移植自 translation_editor/server.py（经 Rust 版 xml_store.rs 中转）：
// 读取用完整 XML 解析，写入用正则文本替换以保留原始缩进/多列同行格式。
'use strict';

const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .\-/:]*$/;
const CODE_RE = /^[a-z]{2,8}$/;

// 等价于 Rust regex::escape：转义所有正则元字符
function regexEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlAttrEscape(s) {
  return xmlEscape(s).replace(/"/g, '&quot;');
}

// 把常见的 IO 报错翻译成能直接照着做的中文提示，而不是甩一句原始系统错误。
// Windows 上的 EACCES/EPERM/EBUSY(os error 5/32/33) 是最常见的"这个文件我碰不了"场景。
function friendlyIoError(action, filePath, e) {
  let detail;
  switch (e && e.code) {
    case 'EACCES':
    case 'EPERM':
      detail =
        '没有写入权限——文件可能是只读属性（比如 SVN 里未 checkout / 需要先解除只读），请检查文件属性或版本控制状态后重试';
      break;
    case 'EBUSY':
      detail =
        '文件正被其他程序占用（比如已经用记事本/Excel 等打开，或杀毒软件正在扫描），请关闭后重试';
      break;
    case 'ENOENT':
      detail = '文件不存在，可能已被移动或删除';
      break;
    default:
      detail = e && e.message ? e.message : String(e);
  }
  return `${action}失败：${detail}（${filePath}）`;
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(friendlyIoError('读取', filePath, e));
  }
}

// 先写同目录下的临时文件再 rename 过去，避免写到一半崩溃/断电导致文件损坏。
// rename 失败（比如目标文件正被其它程序独占打开）时 fallback 回直接覆盖写，
// 不能因为原子写的路径失败就让保存彻底不可用。
function writeFile(filePath, text) {
  const dir = path.dirname(filePath);
  if (dir && dir !== '') {
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp${process.pid}`);
    let wroteTmp = false;
    try {
      fs.writeFileSync(tmp, text);
      wroteTmp = true;
    } catch (_e) {
      /* 落到下面的直接覆盖写 */
    }
    if (wroteTmp) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (_e) {
        try {
          fs.unlinkSync(tmp);
        } catch (_e2) {
          /* ignore */
        }
      }
    }
  }
  try {
    fs.writeFileSync(filePath, text);
  } catch (e) {
    throw new Error(friendlyIoError('写入', filePath, e));
  }
}

// 返回文件最后修改时间（Unix 毫秒），供前端轮询检测"文件被外部程序改动"用。
function fileMtimeMillis(filePath) {
  let meta;
  try {
    meta = fs.statSync(filePath);
  } catch (e) {
    throw new Error(friendlyIoError('读取', filePath, e));
  }
  return Math.floor(meta.mtimeMs);
}

function languagesRe() {
  return /(^ {2}<languages>)([\s\S]*?)(^ {2}<\/languages>)/m;
}

function entryBlockRe(key) {
  return new RegExp(
    `(^ {2}<entry\\s+key="${regexEscape(key)}"\\s*>)([\\s\\S]*?)(^ {2}</entry>)`,
    'm'
  );
}

function anyEntryReGlobal() {
  return /(^ {2}<entry\s+key="[^"]+"\s*>)([\s\S]*?)(^ {2}<\/entry>)/gm;
}

// 写入路径的正则严格要求两空格缩进；缩进不同的文件能正常打开显示，但保存/删除会报
// "not found"。用一个不带缩进锚点的宽松正则二次确认标签其实存在，命中就补一句提示。
function indentHint(text, lenientPattern) {
  let matched = false;
  try {
    matched = new RegExp(lenientPattern).test(text);
  } catch (_e) {
    matched = false;
  }
  return matched
    ? '（该标签存在，但缩进与本工具要求的两个空格不一致，请检查文件格式后重试）'
    : '';
}

function currentLangCodes(text) {
  const codes = [];
  const caps = languagesRe().exec(text);
  if (caps) {
    const inner = caps[2];
    const codeRe = /<lang\s+[^>]*code="([^"]+)"/g;
    let m;
    while ((m = codeRe.exec(inner)) !== null) {
      codes.push(m[1]);
    }
  }
  return codes;
}

function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function elementText(el) {
  // 对齐 roxmltree 取文本：拼接直接子文本/CDATA 节点内容
  let t = '';
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3 || c.nodeType === 4) {
      t += c.data;
    }
  }
  return t;
}

function childElements(node, name) {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (name === undefined || c.nodeName === name)) {
      out.push(c);
    }
  }
  return out;
}

function loadTranslations(xmlPath) {
  const text = readFile(xmlPath);
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const root = doc.documentElement;
  if (!root) {
    throw new Error('XML 解析失败');
  }

  const languagesNode = childElements(root, 'languages')[0];
  if (!languagesNode) {
    throw new Error('<languages> not found');
  }

  const langs = childElements(languagesNode, 'lang').map((n) => ({
    id: parseInt(n.getAttribute('id') || '0', 10) || 0,
    code: n.getAttribute('code') || '',
    name: n.getAttribute('name') || '',
  }));
  langs.sort((a, b) => a.id - b.id);

  const entries = [];
  for (const entryNode of childElements(root, 'entry')) {
    const key = entryNode.getAttribute('key') || '';
    const values = {};
    for (const lang of langs) {
      const el = childElements(entryNode, lang.code)[0];
      values[lang.code] = el ? elementText(el) : '';
    }
    entries.push({ key, values });
  }

  const mtime = fileMtimeMillis(xmlPath);

  return { langs, entries, xml_path: xmlPath, mtime };
}

// 在整段 XML 文本里原地替换某个 entry 下某个语言标签的文本，返回新文本（不落盘）。
function patchEntryLang(text, key, code, value) {
  const re = entryBlockRe(key);
  const caps = re.exec(text);
  if (!caps) {
    const hint = indentHint(text, `<entry\\s+key="${regexEscape(key)}"\\s*>`);
    throw new Error(`entry key='${key}' not found${hint}`);
  }
  const mStart = caps.index;
  const mEnd = caps.index + caps[0].length;
  const head = caps[1];
  const body = caps[2];
  const tail = caps[3];

  const newInner = xmlEscape(value);
  // 自闭合标签（<en/>）匹配不到 open/close 正则，必须单独处理，否则会落入"追加新标签"
  // 分支，在条目里留下两个同名标签，读取时又永远拿第一个（空的自闭合）。
  const selfClosingRe = new RegExp(`<${regexEscape(code)}(?:\\s[^>]*)?/>`);
  const tagRe = new RegExp(
    `(<${regexEscape(code)}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${regexEscape(code)}>)`
  );

  let newBody;
  const sc = selfClosingRe.exec(body);
  if (sc) {
    const insert = `<${code}>${newInner}</${code}>`;
    newBody = body.slice(0, sc.index) + insert + body.slice(sc.index + sc[0].length);
  } else {
    const tc = tagRe.exec(body);
    if (tc) {
      const open = tc[1];
      const close = tc[3];
      const tmStart = tc.index;
      const tmEnd = tc.index + tc[0].length;
      newBody = body.slice(0, tmStart) + open + newInner + close + body.slice(tmEnd);
    } else {
      const insert = `<${code}>${newInner}</${code}>`;
      if (body.endsWith('\n') || body.endsWith('  ')) {
        newBody = `${body.replace(/\s+$/, '')}\n    ${insert}\n  `;
      } else {
        newBody = `${body}${insert}`;
      }
    }
  }

  return text.slice(0, mStart) + head + newBody + tail + text.slice(mEnd);
}

function updateTranslation(xmlPath, key, code, value) {
  const text = readFile(xmlPath);
  const newText = patchEntryLang(text, key, code, value);
  writeFile(xmlPath, newText);
}

// 批量保存多个脏格：只读一次、只写一次文件。任意一条 patch 失败就整体不写入。
function saveCells(xmlPath, edits) {
  let text = readFile(xmlPath);
  for (const edit of edits) {
    text = patchEntryLang(text, edit.key, edit.code, edit.value);
  }
  writeFile(xmlPath, text);
}

// 在 `</translations>` 前追加一个新 entry 块，返回新文本（不落盘）。
function appendEntryBlock(text, key, codes, values) {
  const nl = detectNewline(text);
  const lines = [`  <entry key="${xmlAttrEscape(key)}">`];
  for (const code of codes) {
    const v = values[code] !== undefined ? values[code] : '';
    lines.push(`    <${code}>${xmlEscape(v)}</${code}>`);
  }
  lines.push('  </entry>');
  const block = lines.join(nl) + nl + nl;

  const idx = text.lastIndexOf('</translations>');
  if (idx === -1) {
    throw new Error('</translations> not found');
  }
  let head = text.slice(0, idx);
  if (!head.endsWith(nl)) {
    head += nl;
  }
  return head + block + text.slice(idx);
}

function addEntry(xmlPath, key, values) {
  if (!key || !KEY_RE.test(key)) {
    throw new Error('invalid key');
  }
  const text = readFile(xmlPath);
  if (entryBlockRe(key).test(text)) {
    throw new Error(`key '${key}' already exists`);
  }
  const codes = currentLangCodes(text);
  if (codes.length === 0) {
    throw new Error('no languages defined');
  }
  const newText = appendEntryBlock(text, key, codes, values);
  writeFile(xmlPath, newText);
}

function deleteEntry(xmlPath, key) {
  const text = readFile(xmlPath);
  const re = new RegExp(
    `^ {2}<entry\\s+key="${regexEscape(key)}"\\s*>[\\s\\S]*?^ {2}</entry>[ \\t]*\\r?\\n(?:[ \\t]*\\r?\\n)?`,
    'm'
  );
  const m = re.exec(text);
  if (!m) {
    const hint = indentHint(text, `<entry\\s+key="${regexEscape(key)}"\\s*>`);
    throw new Error(`entry key='${key}' not found${hint}`);
  }
  const newText = text.slice(0, m.index) + text.slice(m.index + m[0].length);
  writeFile(xmlPath, newText);
}

function addLanguage(xmlPath, code, name) {
  if (!code || !CODE_RE.test(code)) {
    throw new Error('invalid code (lowercase letters, 2-8 chars)');
  }
  if (!name) {
    throw new Error('name required');
  }
  const text = readFile(xmlPath);
  const codes = currentLangCodes(text);
  if (codes.includes(code)) {
    throw new Error(`code '${code}' already exists`);
  }
  const caps = languagesRe().exec(text);
  if (!caps) {
    throw new Error(`<languages> block not found${indentHint(text, '<languages>')}`);
  }
  const mStart = caps.index;
  const mEnd = caps.index + caps[0].length;
  const head = caps[1];
  const inner = caps[2];
  const tail = caps[3];

  const idRe = /<lang\s+id="(\d+)"/g;
  let maxId = null;
  let idm;
  while ((idm = idRe.exec(inner)) !== null) {
    const v = parseInt(idm[1], 10);
    if (!Number.isNaN(v) && (maxId === null || v > maxId)) {
      maxId = v;
    }
  }
  const nextId = maxId === null ? 0 : maxId + 1;

  const newLang = `    <lang id="${nextId}" code="${code}" name="${xmlAttrEscape(name)}"/>\n`;
  const newInner = `${inner.replace(/[\n ]+$/, '')}\n${newLang}`;
  let newText = text.slice(0, mStart) + head + newInner + tail + text.slice(mEnd);

  const hasTagRe = new RegExp(`<${regexEscape(code)}(?:\\s[^>]*)?>`);
  newText = newText.replace(anyEntryReGlobal(), (_match, h, b, t) => {
    let body = b;
    if (hasTagRe.test(body)) {
      return `${h}${body}${t}`;
    }
    if (!body.endsWith('\n')) {
      body += '\n';
    }
    body += `    <${code}></${code}>\n`;
    return `${h}${body}${t}`;
  });

  writeFile(xmlPath, newText);
}

function deleteLanguage(xmlPath, code) {
  if (!code) {
    throw new Error('code required');
  }
  let text = readFile(xmlPath);
  const codes = currentLangCodes(text);
  if (!codes.includes(code)) {
    // codes 为空往往是 <languages> 缩进不匹配导致整体解析失败，而不是这个语言真的不存在
    const hint = codes.length === 0 ? indentHint(text, '<languages>') : '';
    throw new Error(`code '${code}' not found${hint}`);
  }
  if (codes.length <= 1) {
    throw new Error('cannot remove last language');
  }

  const caps = languagesRe().exec(text);
  if (caps) {
    const mStart = caps.index;
    const mEnd = caps.index + caps[0].length;
    const head = caps[1];
    let inner = caps[2];
    const tail = caps[3];

    const removeRe = new RegExp(
      `[ \\t]*<lang\\s+[^>]*code="${regexEscape(code)}"[^>]*/>[ \\t]*\\n?`
    );
    inner = inner.replace(removeRe, '');

    const idRe = /(<lang\s+id=")\d+("[^>]*\/>)/g;
    let counter = 0;
    inner = inner.replace(idRe, (_m, p1, p2) => {
      const s = `${p1}${counter}${p2}`;
      counter += 1;
      return s;
    });

    text = text.slice(0, mStart) + head + inner + tail + text.slice(mEnd);
  }

  const tagBlock = new RegExp(
    `[ \\t]*<${regexEscape(code)}(?:\\s[^>]*)?>[\\s\\S]*?</${regexEscape(code)}>[ \\t]*\\n`,
    'g'
  );
  const tagInline = new RegExp(
    `<${regexEscape(code)}(?:\\s[^>]*)?>[\\s\\S]*?</${regexEscape(code)}>[ \\t]*`,
    'g'
  );

  text = text.replace(anyEntryReGlobal(), (_match, h, b, t) => {
    let body = b;
    body = body.replace(tagBlock, '');
    body = body.replace(tagInline, '');
    return `${h}${body}${t}`;
  });

  writeFile(xmlPath, text);
}

// ───────── CSV 导出 / 导入 ─────────

function csvEscape(s) {
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    let out = '"';
    for (const ch of s) {
      if (ch === '"') {
        out += '"';
      }
      out += ch;
    }
    out += '"';
    return out;
  }
  return s;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// 手写的最小 CSV 解析：支持引号包裹字段（内嵌逗号/换行，`""` 表示转义引号），
// 兼容 `\r\n` 和 `\n`。整行空白的行会被跳过。
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const chars = Array.from(text);

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (inQuotes) {
      if (ch === '"') {
        if (chars[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (chars[i + 1] === '\n') {
        i += 1;
      }
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length !== 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

// 导出当前 XML 里的全部翻译为 CSV，带 UTF-8 BOM 避免 Excel 打开中文乱码。
function exportCsv(xmlPath, csvPath) {
  const data = loadTranslations(xmlPath);
  let out = '﻿';
  out += 'key';
  for (const l of data.langs) {
    out += ',';
    out += csvEscape(l.code);
  }
  out += '\r\n';
  for (const e of data.entries) {
    out += csvEscape(e.key);
    for (const l of data.langs) {
      out += ',';
      const v = e.values[l.code] !== undefined ? e.values[l.code] : '';
      out += csvEscape(v);
    }
    out += '\r\n';
  }
  writeFile(csvPath, out);
}

// 导入 CSV：只做"新增 + 更新"，不做删除。校验分两层：格式错误（key 非法/重复、列数
// 不对、未知语言列）一律硬错误，一次汇总、不写入任何改动；单元格内容缺失只算警告。
function importCsv(xmlPath, csvPath) {
  const csvRaw = readFile(csvPath);
  const rows = parseCsv(stripBom(csvRaw));

  if (rows.length === 0) {
    throw new Error('CSV 文件为空');
  }
  const header = rows[0];
  if (header.length === 0 || header[0].trim().toLowerCase() !== 'key') {
    throw new Error('CSV 第一列表头必须是 "key"');
  }
  const csvCodes = header.slice(1).map((c) => c.trim());
  const csvCodeSet = new Set(csvCodes);

  const data = loadTranslations(xmlPath);
  const xmlCodes = data.langs.map((l) => l.code);
  const xmlCodeSet = new Set(xmlCodes);
  const existingKeys = new Set(data.entries.map((e) => e.key));

  const unknownCodes = csvCodes.filter((c) => !xmlCodeSet.has(c));
  if (unknownCodes.length !== 0) {
    throw new Error(
      `CSV 中存在当前 XML 未定义的语言列：${unknownCodes.join(
        '、'
      )}（请先用“新增语言”添加该语言，或从 CSV 中删掉这一列后再导入）`
    );
  }

  const errors = [];
  const warnings = [];
  const seenKeys = new Map();
  const parsedRows = [];

  for (let i = 0; i < rows.length - 1; i++) {
    const row = rows[i + 1];
    const lineNo = i + 2; // 1-based，且跳过表头行
    if (row.length !== header.length) {
      errors.push(`第 ${lineNo} 行：列数（${row.length}）与表头（${header.length}）不一致`);
      continue;
    }
    const key = row[0].trim();
    if (key === '') {
      errors.push(`第 ${lineNo} 行：key 不能为空`);
      continue;
    }
    if (!KEY_RE.test(key)) {
      errors.push(`第 ${lineNo} 行：key "${key}" 含非法字符`);
      continue;
    }
    if (seenKeys.has(key)) {
      errors.push(`第 ${lineNo} 行：key "${key}" 与第 ${seenKeys.get(key)} 行重复`);
      continue;
    }
    seenKeys.set(key, lineNo);

    const values = {};
    for (let ci = 0; ci < csvCodes.length; ci++) {
      const code = csvCodes[ci];
      const v = row[ci + 1].trim();
      if (v === '') {
        if (existingKeys.has(key)) {
          warnings.push(`第 ${lineNo} 行：key "${key}" 的 ${code} 列为空，保留原有翻译不变`);
        } else {
          warnings.push(`第 ${lineNo} 行：key "${key}" 是新增条目，${code} 翻译为空`);
        }
      }
      values[code] = v;
    }
    parsedRows.push({ key, values });
  }

  if (errors.length !== 0) {
    throw new Error(
      `CSV 校验未通过，共 ${errors.length} 处问题，未做任何修改：\n${errors.join('\n')}`
    );
  }
  if (parsedRows.length === 0) {
    throw new Error('CSV 中没有数据行');
  }

  const missingCodes = xmlCodes.filter((c) => !csvCodeSet.has(c));
  if (missingCodes.length !== 0) {
    warnings.unshift(
      `CSV 未包含语言列：${missingCodes.join('、')}，这些语言的翻译在导入后保持不变`
    );
  }

  let text = readFile(xmlPath);
  let added = 0;
  let updated = 0;

  for (const { key, values } of parsedRows) {
    if (existingKeys.has(key)) {
      for (const code of csvCodes) {
        const v = values[code] !== undefined ? values[code] : '';
        // 空单元格不覆盖已有翻译
        if (v === '') {
          continue;
        }
        text = patchEntryLang(text, key, code, v);
      }
      updated += 1;
    } else {
      text = appendEntryBlock(text, key, xmlCodes, values);
      added += 1;
    }
  }

  writeFile(xmlPath, text);
  return { added, updated, warnings };
}

// 定位生成目标目录：仍以 `gen_multilang.py` 的存在作为"这是固件工程目录"的标记，
// 但脚本本身不再被执行——直接原生生成 multilang.h/.c，写到该脚本所在目录。
function findGenMultilang(xmlPath) {
  let dir = path.dirname(xmlPath);
  for (;;) {
    const cand = path.join(dir, 'gen_multilang.py');
    try {
      if (fs.statSync(cand).isFile()) {
        return cand;
      }
    } catch (_e) {
      /* not here, walk up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

const MULTILANG_BANNER =
  '/* AUTO-GENERATED — DO NOT EDIT. Source: translations.xml  Run: python gen_multilang.py */';

function cEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// 左对齐补空格至指定最小宽度（等价 Rust 的 {:<width$}）
function padRight(s, width) {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// 原生移植自 gen_multilang.py：逐字节对齐原脚本产物。只算内容，不落盘。
function buildMultilang(xmlPath) {
  const data = loadTranslations(xmlPath);
  const langCount = data.langs.length;

  let h = MULTILANG_BANNER;
  h += '\n\n#ifndef MULTILANG_H\n#define MULTILANG_H\n\n';
  for (const l of data.langs) {
    h += `#define LANG_${padRight(l.code.toUpperCase(), 4)} ${l.id}\n`;
  }
  h += `#define LANG_COUNT ${langCount}\n\n`;
  h += 'const char *multilang_get(const char *key);\n#define tr(key) multilang_get(key)\n\n#endif\n';

  let keyWidth = 0;
  for (const e of data.entries) {
    const len = Buffer.byteLength(e.key, 'utf8');
    if (len > keyWidth) {
      keyWidth = len;
    }
  }
  keyWidth += 4;

  const warnings = [];

  let c = MULTILANG_BANNER;
  c += '\n\n#include <string.h>\n#include "multilang.h"\n#include "common_data.h"\n\n';
  c += 'typedef struct { const char *key; const char *trans[LANG_COUNT]; } LangEntry;\n\n';
  c += '/* clang-format off */\nstatic const LangEntry s_lang_table[] = {\n';
  for (const e of data.entries) {
    const transLits = [];
    for (const l of data.langs) {
      const rawVal = e.values[l.code] !== undefined ? e.values[l.code].trim() : '';
      let value;
      if (rawVal === '') {
        warnings.push(
          `WARNING: key='${e.key}' missing lang '${l.code}', using key as fallback`
        );
        value = e.key;
      } else {
        value = rawVal;
      }
      transLits.push(`"${cEscape(value)}"`);
    }
    const keyLit = `"${cEscape(e.key)}"`;
    c += `    { ${padRight(keyLit, keyWidth)}, { ${transLits.join(', ')} } },\n`;
  }
  c += '};\n/* clang-format on */\n\n';
  c += 'const char *multilang_get(const char *key)\n{\n';
  // 越界兜底用数字字面量而不是 LANG_EN 宏：XML 不一定定义了 code="en"，引用不存在的宏会编译不过
  const enLang = data.langs.find((l) => l.code === 'en');
  const fallbackId = enLang ? enLang.id : 0;
  c += '    int lang = g_com_data.cur_language;\n    int i, count;\n';
  c += `    if (lang < 0 || lang >= LANG_COUNT) lang = ${fallbackId};\n`;
  c += '    count = (int)(sizeof(s_lang_table) / sizeof(s_lang_table[0]));\n';
  c +=
    '    for (i = 0; i < count; i++)\n        if (strcmp(s_lang_table[i].key, key) == 0)\n            return s_lang_table[i].trans[lang];\n';
  c += '    return key;\n}\n';

  return { h, c, langCount, keyCount: data.entries.length, warnings };
}

function regenMultilang(xmlPath) {
  const script = findGenMultilang(xmlPath);
  if (!script) {
    throw new Error('未找到 gen_multilang.py（用于定位固件工程输出目录）');
  }
  const outDir = path.dirname(script);
  const gen = buildMultilang(xmlPath);

  writeFile(path.join(outDir, 'multilang.h'), gen.h);
  writeFile(path.join(outDir, 'multilang.c'), gen.c);

  let summary = `OK  multilang.h  multilang.c  (${gen.langCount} langs, ${gen.keyCount} keys)`;
  if (gen.warnings.length !== 0) {
    summary += '\n';
    summary += gen.warnings.join('\n');
  }
  return summary;
}

// 校验当前 XML 重新生成一遍是否和磁盘上现有的 multilang.h/.c 完全一致，不写文件。
function checkMultilangConsistency(xmlPath) {
  const script = findGenMultilang(xmlPath);
  if (!script) {
    throw new Error('未找到 gen_multilang.py（用于定位固件工程输出目录）');
  }
  const outDir = path.dirname(script);
  const gen = buildMultilang(xmlPath);

  let diskH = '';
  let diskC = '';
  try {
    diskH = fs.readFileSync(path.join(outDir, 'multilang.h'), 'utf8');
  } catch (_e) {
    diskH = '';
  }
  try {
    diskC = fs.readFileSync(path.join(outDir, 'multilang.c'), 'utf8');
  } catch (_e) {
    diskC = '';
  }
  const hMatches = gen.h === diskH;
  const cMatches = gen.c === diskC;

  return {
    consistent: hMatches && cMatches,
    h_matches: hMatches,
    c_matches: cMatches,
    dir: outDir,
  };
}

module.exports = {
  loadTranslations,
  updateTranslation,
  saveCells,
  addEntry,
  deleteEntry,
  addLanguage,
  deleteLanguage,
  regenMultilang,
  checkMultilangConsistency,
  fileMtimeMillis,
  exportCsv,
  importCsv,
  // 以下为内部函数，导出供测试使用（对齐 Rust 的 mod tests 直接调用私有函数）
  _internal: {
    csvEscape,
    parseCsv,
    stripBom,
    findGenMultilang,
    readFile,
    patchEntryLang,
    buildMultilang,
  },
};
