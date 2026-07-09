'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../electron/xml_store');
const cSync = require('../electron/c_sync');
const { parseLangColumns, parseCStringLiterals, parseLangTable } = cSync._internal;

const FIXTURE =
  '<?xml version="1.0" encoding="UTF-8"?>\n<translations>\n\n  <languages>\n    <lang id="0" code="zh" name="中文"/>\n    <lang id="1" code="en" name="English"/>\n  </languages>\n\n  <entry key="ODO">\n    <zh>总里程</zh>    <en>ODO trip</en>\n  </entry>\n\n  <entry key="EMPTY_EN">\n    <zh>空英文</zh>    <en/>\n  </entry>\n\n</translations>\n';

let COUNTER = 0;
function tempProject(xml) {
  COUNTER += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c_sync_test_${process.pid}_${COUNTER}_`));
  fs.writeFileSync(path.join(dir, 'gen_multilang.py'), '# marker\n');
  const xmlPath = path.join(dir, 'translations.xml');
  fs.writeFileSync(xmlPath, xml);
  return { dir, xmlPath };
}

test('parseCStringLiterals handles escapes', () => {
  assert.deepStrictEqual(
    parseCStringLiterals('    { "K\\"1",  { "a, b", "c\\\\d\\ne" } },'),
    ['K"1', 'a, b', 'c\\d\ne']
  );
});

test('parseLangColumns reads macros in id order, skips LANG_COUNT', () => {
  const h = '#define LANG_EN   1\n#define LANG_ZH   0\n#define LANG_COUNT 2\n';
  assert.deepStrictEqual(parseLangColumns(h), [
    { code: 'zh', id: 0 },
    { code: 'en', id: 1 },
  ]);
});

test('parseLangTable rejects wrong column count', () => {
  const c = 'static const LangEntry s_lang_table[] = {\n    { "K", { "only-one" } },\n};\n';
  assert.throws(() => parseLangTable(c, 2), /列数不对/);
});

test('sync_from_c updates cells, adds keys, keeps xml-only keys and fallbacks', () => {
  const { dir, xmlPath } = tempProject(FIXTURE);
  store.regenMultilang(xmlPath);

  // 模拟同事直接改 .c：改一个翻译、加一个新 key（含一个"值==key"的空翻译兜底列）、删掉 EMPTY_EN
  let c = fs.readFileSync(path.join(dir, 'multilang.c'), 'utf8');
  c = c.replace('"ODO trip"', '"ODO trip EDITED"');
  c = c.replace(
    /(static const LangEntry s_lang_table\[\] = \{\n)/,
    '$1    { "NEW_KEY", { "新键", "NEW_KEY" } },\n'
  );
  c = c.split('\n').filter((l) => !l.includes('"EMPTY_EN"')).join('\n');
  fs.writeFileSync(path.join(dir, 'multilang.c'), c);

  const report = cSync.syncFromC(xmlPath);
  assert.strictEqual(report.updated, 1);
  assert.strictEqual(report.added, 1);
  // EMPTY_EN 只在 XML 里 → 保持不变的提示
  assert.ok(report.warnings.some((w) => w.includes('XML 独有')));

  const data = store.loadTranslations(xmlPath);
  const byKey = Object.fromEntries(data.entries.map((e) => [e.key, e.values]));
  assert.strictEqual(byKey.ODO.en, 'ODO trip EDITED');
  assert.strictEqual(byKey.ODO.zh, '总里程');
  assert.strictEqual(byKey.NEW_KEY.zh, '新键');
  // "NEW_KEY"（值==key）按空翻译兜底处理，不回写
  assert.ok(!byKey.NEW_KEY.en);
  assert.ok(byKey.EMPTY_EN, 'xml-only key survives');

  // 同步后以 XML 重新生成即恢复一致
  store.regenMultilang(xmlPath);
  assert.strictEqual(store.checkMultilangConsistency(xmlPath).consistent, true);
});

test('sync_from_c: existing empty cell + key-fallback in .c stays empty (warning)', () => {
  const { dir, xmlPath } = tempProject(FIXTURE);
  store.regenMultilang(xmlPath); // EMPTY_EN 的 en 列生成为 "EMPTY_EN" 兜底

  const report = cSync.syncFromC(xmlPath);
  assert.strictEqual(report.updated, 0);
  assert.strictEqual(report.added, 0);
  assert.ok(report.warnings.some((w) => w.includes('EMPTY_EN')));
  const data = store.loadTranslations(xmlPath);
  const empty = data.entries.find((e) => e.key === 'EMPTY_EN');
  assert.strictEqual((empty.values.en || '').trim(), '');
});

test('sync_from_c rejects unknown language column', () => {
  const { dir, xmlPath } = tempProject(FIXTURE);
  store.regenMultilang(xmlPath);
  let h = fs.readFileSync(path.join(dir, 'multilang.h'), 'utf8');
  h = h.replace('#define LANG_EN   1', '#define LANG_FR   1');
  fs.writeFileSync(path.join(dir, 'multilang.h'), h);
  assert.throws(() => cSync.syncFromC(xmlPath), /不存在的语言/);
});

test('sync_from_c errors when multilang.c missing', () => {
  const { dir, xmlPath } = tempProject(FIXTURE);
  store.regenMultilang(xmlPath);
  fs.rmSync(path.join(dir, 'multilang.c'));
  assert.throws(() => cSync.syncFromC(xmlPath), /multilang\.c/);
});
