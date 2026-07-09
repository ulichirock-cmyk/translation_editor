"use strict";

// 新建全新的 translations.xml 工程（开屏引导页的「新建」入口）。
// - 模板自带 zh/en 两种语言和一条示例条目：空 <entry> 列表会让生成的
//   s_lang_table 初始化列表为空（严格 C 里不合法），示例条目同时也给
//   用户演示了文件格式；后续语言/条目都可在编辑器里增删。
// - 生成 multilang.h/.c 依赖 gen_multilang.py 标记定位输出目录：全新工程
//   通常没有这个标记，就在 XML 同目录补一个（纯标记，内容不会被执行），
//   使 .h/.c 生成到 XML 旁边。若上级目录已有标记则沿用，不重复创建。
// 只使用 xml_store 导出的 API/_internal（该模块视为契约不改动）。

const fs = require("fs");
const path = require("path");
const xmlStore = require("./xml_store");

const TEMPLATE =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  "<translations>\n\n" +
  "  <languages>\n" +
  '    <lang id="0" code="zh" name="中文"/>\n' +
  '    <lang id="1" code="en" name="English"/>\n' +
  "  </languages>\n\n" +
  '  <entry key="HELLO">\n' +
  "    <zh>你好</zh>    <en>Hello</en>\n" +
  "  </entry>\n\n" +
  "</translations>\n";

const MARKER_CONTENT =
  "# translation_editor 的输出目录标记：multilang.h/.c 会生成到本文件所在目录。\n" +
  "# 本文件内容不会被执行，仅作为目录标记存在。\n";

// 创建新 XML + （必要时）目录标记，并立即生成 multilang.h/.c。
// 返回 regenMultilang 的摘要字符串。目标文件已存在时报错不覆盖——
// 覆盖一份既有的 translations.xml 属于破坏性操作，应该走「打开」而不是「新建」。
function createNewXml(xmlPath) {
  if (fs.existsSync(xmlPath)) {
    throw new Error(`文件已存在：${xmlPath}\n「新建」不会覆盖已有文件，请改用「选择 translations.xml」打开它，或换一个位置新建。`);
  }
  const dir = path.dirname(xmlPath);
  // 中途任何一步失败（典型：Windows 拒绝往 C 盘根目录/Program Files 等
  // 受保护位置写文件）都回滚已创建的文件，否则残留的半成品 XML 会让
  // 用户重试时一直撞上上面的「文件已存在」。
  const created = [];
  try {
    fs.writeFileSync(xmlPath, TEMPLATE, "utf8");
    created.push(xmlPath);

    if (!xmlStore._internal.findGenMultilang(xmlPath)) {
      const marker = path.join(dir, "gen_multilang.py");
      fs.writeFileSync(marker, MARKER_CONTENT, "utf8");
      created.push(marker);
    }
    return xmlStore.regenMultilang(xmlPath);
  } catch (err) {
    for (const f of created.reverse()) {
      try { fs.unlinkSync(f); } catch (_e) { /* 回滚尽力而为 */ }
    }
    // xml_store 的 writeFile 会把底层错误包一层（丢失 err.code），所以再兜一遍报错文本
    if (err && (err.code === "EPERM" || err.code === "EACCES" ||
        /\b(EPERM|EACCES)\b/.test(String(err.message || "")))) {
      throw new Error(
        `没有权限在该位置写入文件（${err.path || dir}）。\n` +
        "Windows 不允许普通程序直接写 C 盘根目录、Program Files 等系统目录，" +
        "请换一个有写权限的位置（如桌面、文档或你的工程目录）重新新建。"
      );
    }
    throw err;
  }
}

module.exports = { createNewXml, _internal: { TEMPLATE } };
