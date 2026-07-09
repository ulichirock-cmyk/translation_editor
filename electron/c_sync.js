"use strict";

// 反向同步：multilang.c → translations.xml。
// 场景：同事直接改了固件里的 multilang.c 没同步 XML（一致性横幅报警的常见原因），
// 与其人工逐条对回去，这里把 .c 里的字符串表解析出来写回 XML。
// 只依赖 xml_store 导出的 API（该模块归另一条移植线维护，视为契约不改动）：
// checkMultilangConsistency 定位输出目录，addEntry/saveCells 落盘写 XML。
//
// 语言列的对应关系不看当前 XML 的语言顺序，而是解析磁盘上 multilang.h 的
// `#define LANG_XX <id>` ——.h/.c 是同一次生成的产物，列序只有它说了算；
// 若 .c 里有 XML 没有的语言列，直接报错让用户先补语言，避免错位串列。
//
// 与 CSV 导入同样的"只增改不删除"语义：.c 里没有的 XML key 保持不变。
// 生成器对空翻译会用 key 本身兜底（见 xml_store.buildMultilang），因此
// "值 == key 且 XML 对应格为空"的格视为兜底产物跳过，不把 key 回写成翻译。

const fs = require("fs");
const path = require("path");
const xmlStore = require("./xml_store");

// 从 multilang.h 文本解析语言列顺序：[{code, id}]，按 id 升序（即 .c 数组列序）
function parseLangColumns(hText) {
  const langs = [];
  for (const m of hText.matchAll(/^#define LANG_([A-Za-z0-9_]+)[ \t]+(\d+)[ \t]*$/gm)) {
    if (m[1] === "COUNT") continue;
    langs.push({ code: m[1].toLowerCase(), id: Number(m[2]) });
  }
  langs.sort((a, b) => a.id - b.id);
  return langs;
}

// 解析一行里的全部 C 字符串字面量（处理 \\ \" \n 转义）
function parseCStringLiterals(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') { i++; continue; }
    i++;
    let s = "";
    while (i < line.length && line[i] !== '"') {
      if (line[i] === "\\" && i + 1 < line.length) {
        const n = line[i + 1];
        if (n === "n") s += "\n";
        else if (n === "\\") s += "\\";
        else if (n === '"') s += '"';
        else s += n; // 其它转义原样保留字符本身
        i += 2;
      } else {
        s += line[i];
        i++;
      }
    }
    i++; // 收尾引号
    out.push(s);
  }
  return out;
}

// 从 multilang.c 文本解析字符串表：[{key, values:[...]}]（values 与语言列序对齐）
function parseLangTable(cText, langCount) {
  const lines = cText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.includes("s_lang_table[] = {"));
  if (startIdx === -1) {
    throw new Error("multilang.c 中未找到 s_lang_table 字符串表，无法解析");
  }
  const entries = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("};")) break;
    if (!line.trim().startsWith("{")) continue;
    const lits = parseCStringLiterals(line);
    if (lits.length === 0) continue;
    if (lits.length !== langCount + 1) {
      throw new Error(
        `multilang.c 第 ${i + 1} 行的列数不对：期望 1 个 key + ${langCount} 个翻译，实际解析出 ${lits.length} 个字符串`);
    }
    entries.push({ key: lits[0], values: lits.slice(1) });
  }
  if (entries.length === 0) {
    throw new Error("multilang.c 的 s_lang_table 里没有解析到任何条目");
  }
  return entries;
}

// 主入口：把 multilang.c 的内容同步回 translations.xml。
// 返回 { added, updated, warnings }；结构性问题（缺文件/语言对不上/列数不对）直接抛错，
// 此时 XML 未被改动。
function syncFromC(xmlPath) {
  // 借一致性检查定位输出目录（找不到 gen_multilang.py 标记时它会抛中文错误）
  const check = xmlStore.checkMultilangConsistency(xmlPath);
  const dir = check.dir;

  let hText, cText;
  try {
    hText = fs.readFileSync(path.join(dir, "multilang.h"), "utf8");
  } catch (e) {
    throw new Error(`读取 multilang.h 失败（${dir}）：${e.message}`);
  }
  try {
    cText = fs.readFileSync(path.join(dir, "multilang.c"), "utf8");
  } catch (e) {
    throw new Error(`读取 multilang.c 失败（${dir}）：${e.message}`);
  }

  const cLangs = parseLangColumns(hText);
  if (cLangs.length === 0) {
    throw new Error("multilang.h 中未解析到任何 #define LANG_XX 语言宏，无法确定 .c 的列对应关系");
  }

  const data = xmlStore.loadTranslations(xmlPath);
  const xmlCodes = new Set(data.langs.map((l) => l.code));
  const unknown = cLangs.filter((l) => !xmlCodes.has(l.code));
  if (unknown.length > 0) {
    throw new Error(
      `multilang.h/.c 含 XML 中不存在的语言：${unknown.map((l) => l.code).join("、")}，` +
      "请先在编辑器中添加对应语言列再同步");
  }

  const warnings = [];
  const missingInC = data.langs.filter((l) => !cLangs.some((c) => c.code === l.code));
  if (missingInC.length > 0) {
    warnings.push(
      `XML 中的语言 ${missingInC.map((l) => l.code).join("、")} 在 multilang.c 里没有对应列，这些列保持不变`);
  }

  const cEntries = parseLangTable(cText, cLangs.length);

  // 重复 key 时正则写入路径只作用于第一个同名条目，这里对齐该行为：只跟第一个比对
  const xmlByKey = new Map();
  for (const e of data.entries) {
    if (!xmlByKey.has(e.key)) xmlByKey.set(e.key, e);
  }

  const edits = [];
  const toAdd = [];
  for (const ce of cEntries) {
    const cur = xmlByKey.get(ce.key);
    if (!cur) {
      const vals = {};
      for (let i = 0; i < cLangs.length; i++) {
        // 新 key 上"值 == key"按生成器的空翻译兜底处理，保持空着
        if (ce.values[i] !== ce.key) vals[cLangs[i].code] = ce.values[i];
      }
      toAdd.push({ key: ce.key, vals });
      continue;
    }
    for (let i = 0; i < cLangs.length; i++) {
      const code = cLangs[i].code;
      const cVal = ce.values[i];
      const xmlVal = (cur.values[code] || "").trim(); // 生成时做过 trim，比对口径一致
      if (cVal === xmlVal) continue;
      if (cVal === ce.key && xmlVal === "") {
        warnings.push(`key='${ce.key}' 语言 '${code}'：.c 中的值等于 key（生成器的空翻译兜底），XML 保持为空`);
        continue;
      }
      edits.push({ key: ce.key, code, value: cVal });
    }
  }

  const cKeys = new Set(cEntries.map((e) => e.key));
  const onlyXml = data.entries.filter((e) => !cKeys.has(e.key));
  if (onlyXml.length > 0) {
    warnings.push(`XML 独有的 ${onlyXml.length} 个 key 在 multilang.c 里不存在，保持不变（同步不做删除）`);
  }

  for (const a of toAdd) {
    xmlStore.addEntry(xmlPath, a.key, a.vals);
  }
  if (edits.length > 0) {
    xmlStore.saveCells(xmlPath, edits);
  }

  return { added: toAdd.length, updated: edits.length, warnings };
}

module.exports = {
  syncFromC,
  _internal: { parseLangColumns, parseCStringLiterals, parseLangTable },
};
