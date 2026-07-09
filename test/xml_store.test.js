'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../electron/xml_store');
const {
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
} = store;
const { csvEscape, parseCsv, stripBom, findGenMultilang, readFile } = store._internal;

const FIXTURE =
  '<?xml version="1.0" encoding="UTF-8"?>\n<translations>\n\n  <languages>\n    <lang id="0" code="zh" name="中文"/>\n    <lang id="1" code="en" name="English"/>\n  </languages>\n\n  <entry key="ODO">\n    <zh>总里程</zh>    <en>ODO</en>\n  </entry>\n\n</translations>\n';

let COUNTER = 0;
function nextN() {
  COUNTER += 1;
  return `${process.pid}_${COUNTER}`;
}

function tmp(name, ext) {
  return path.join(os.tmpdir(), `xml_store_test_${name}_${nextN()}.${ext}`);
}

function tempXml(name) {
  const p = tmp(name, 'xml');
  fs.writeFileSync(p, FIXTURE);
  return p;
}

function tempCsv(name, content) {
  const p = tmp(name, 'csv');
  fs.writeFileSync(p, content);
  return p;
}

function rm(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch (_e) {
    /* ignore */
  }
}

function rmDir(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
}

test('test_load_translations', () => {
  const p = tempXml('load');
  const data = loadTranslations(p);
  assert.strictEqual(data.langs.length, 2);
  assert.strictEqual(data.langs[0].code, 'zh');
  assert.strictEqual(data.langs[1].code, 'en');
  assert.strictEqual(data.entries.length, 1);
  assert.strictEqual(data.entries[0].values.en, 'ODO');
  rm(p);
});

test('test_update_translation_preserves_formatting', () => {
  const p = tempXml('update');
  updateTranslation(p, 'ODO', 'en', 'Total');
  const text = readFile(p);
  assert.ok(text.includes('<en>Total</en>'));
  assert.ok(text.includes('<zh>总里程</zh>    <en>Total</en>'));
  rm(p);
});

test('test_update_translation_replaces_self_closing_tag', () => {
  const p = tmp('selfclosing', 'xml');
  const fixture =
    '<?xml version="1.0" encoding="UTF-8"?>\n<translations>\n\n  <languages>\n    <lang id="0" code="zh" name="中文"/>\n    <lang id="1" code="en" name="English"/>\n  </languages>\n\n  <entry key="ODO">\n    <zh>总里程</zh>    <en/>\n  </entry>\n\n</translations>\n';
  fs.writeFileSync(p, fixture);

  updateTranslation(p, 'ODO', 'en', 'Total');
  const text = readFile(p);
  assert.ok(text.includes('<en>Total</en>'), `应替换成显式开闭标签，实际：${text}`);
  assert.ok(!text.includes('<en/>'), '自闭合标签不应残留');
  assert.strictEqual((text.match(/<en>/g) || []).length, 1, '不应出现重复的 en 开标签');

  const data = loadTranslations(p);
  const odo = data.entries.find((e) => e.key === 'ODO');
  assert.strictEqual(odo.values.en, 'Total');
  rm(p);
});

test('test_save_cells_batches_multiple_edits', () => {
  const p = tempXml('save_cells');
  saveCells(p, [
    { key: 'ODO', code: 'en', value: 'Total' },
    { key: 'ODO', code: 'zh', value: '累计' },
  ]);
  const data = loadTranslations(p);
  const odo = data.entries.find((e) => e.key === 'ODO');
  assert.strictEqual(odo.values.en, 'Total');
  assert.strictEqual(odo.values.zh, '累计');
  rm(p);
});

test('test_save_cells_writes_nothing_if_any_edit_fails', () => {
  const p = tempXml('save_cells_fail');
  const before = fs.readFileSync(p, 'utf8');
  assert.throws(
    () =>
      saveCells(p, [
        { key: 'ODO', code: 'en', value: 'Total' },
        { key: 'NO_SUCH_KEY', code: 'en', value: 'x' },
      ]),
    (err) => err.message.includes('NO_SUCH_KEY')
  );
  const after = fs.readFileSync(p, 'utf8');
  assert.strictEqual(before, after, '任意一条失败就不应写入任何改动');
  rm(p);
});

test('test_add_and_delete_entry', () => {
  const p = tempXml('entry');
  const values = { en: 'Trip' };
  addEntry(p, 'TRIP', values);
  let data = loadTranslations(p);
  assert.ok(data.entries.some((e) => e.key === 'TRIP'));

  assert.throws(() => addEntry(p, 'TRIP', values), undefined, 'duplicate key must fail');
  assert.throws(() => addEntry(p, 'bad key!', values), undefined, 'invalid key must fail');

  deleteEntry(p, 'TRIP');
  data = loadTranslations(p);
  assert.ok(!data.entries.some((e) => e.key === 'TRIP'));
  rm(p);
});

test('test_add_and_delete_language', () => {
  const p = tempXml('lang');
  addLanguage(p, 'fr', 'Français');
  let data = loadTranslations(p);
  assert.strictEqual(data.langs.length, 3);
  const fr = data.langs.find((l) => l.code === 'fr');
  assert.strictEqual(fr.id, 2);
  assert.strictEqual(data.entries[0].values.fr, '');

  assert.throws(() => addLanguage(p, 'fr', 'dup'), undefined, 'duplicate code must fail');
  assert.throws(() => addLanguage(p, 'F', 'bad'), undefined, 'invalid code must fail');

  deleteLanguage(p, 'zh');
  data = loadTranslations(p);
  assert.strictEqual(data.langs.length, 2);
  const ids = data.langs.map((l) => l.id);
  assert.deepStrictEqual(ids, [0, 1]);
  assert.ok(!Object.prototype.hasOwnProperty.call(data.entries[0].values, 'zh'));

  assert.throws(() => deleteLanguage(p, 'does-not-exist'));
  rm(p);
});

test('test_cannot_delete_last_language', () => {
  const p = tempXml('last_lang');
  deleteLanguage(p, 'zh');
  assert.throws(() => deleteLanguage(p, 'en'), undefined, 'cannot remove last language');
  rm(p);
});

test('test_find_gen_multilang_walks_up_directories', () => {
  const root = path.join(os.tmpdir(), `xml_store_test_walkup_${nextN()}`);
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, 'gen_multilang.py'), '# stub\n');
  const xmlPath = path.join(nested, 'translations.xml');
  fs.writeFileSync(xmlPath, FIXTURE);

  const found = findGenMultilang(xmlPath);
  assert.strictEqual(found, path.join(root, 'gen_multilang.py'));
  rmDir(root);
});

test('test_regen_multilang_generates_expected_output', () => {
  const dir = path.join(os.tmpdir(), `xml_store_test_regen_${nextN()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen_multilang.py'), '# marker only, no longer executed\n');
  const xmlPath = path.join(dir, 'translations.xml');
  fs.writeFileSync(xmlPath, FIXTURE);

  const summary = regenMultilang(xmlPath);
  assert.ok(summary.includes('2 langs'));
  assert.ok(summary.includes('1 keys'));
  assert.ok(!summary.includes('WARNING'), 'fixture has no missing translations');

  const h = fs.readFileSync(path.join(dir, 'multilang.h'), 'utf8');
  assert.ok(h.includes('#define LANG_ZH   0'));
  assert.ok(h.includes('#define LANG_EN   1'));
  assert.ok(h.includes('#define LANG_COUNT 2'));

  const c = fs.readFileSync(path.join(dir, 'multilang.c'), 'utf8');
  assert.ok(c.includes('"ODO"'));
  assert.ok(c.includes('总里程'));
  assert.ok(c.includes('const char *multilang_get(const char *key)'));
  assert.ok(c.includes('lang = 1;'), `应兜底到 en 的 id，实际：${c}`);

  rmDir(dir);
});

test('test_regen_multilang_fallback_without_en_language_uses_id_zero', () => {
  const dir = path.join(os.tmpdir(), `xml_store_test_regen_noen_${nextN()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen_multilang.py'), '# marker only\n');
  const xmlPath = path.join(dir, 'translations.xml');
  const fixture =
    '<?xml version="1.0" encoding="UTF-8"?>\n<translations>\n\n  <languages>\n    <lang id="0" code="zh" name="中文"/>\n    <lang id="1" code="fr" name="Français"/>\n  </languages>\n\n  <entry key="ODO">\n    <zh>总里程</zh>    <fr>ODO</fr>\n  </entry>\n\n</translations>\n';
  fs.writeFileSync(xmlPath, fixture);

  regenMultilang(xmlPath);
  const c = fs.readFileSync(path.join(dir, 'multilang.c'), 'utf8');
  assert.ok(c.includes('lang = 0;'), `没有 en 语言时应兜底到 id 0，实际：${c}`);
  assert.ok(!c.includes('LANG_EN'), `不应再引用可能不存在的 LANG_EN 宏，实际：${c}`);

  rmDir(dir);
});

test('test_regen_multilang_falls_back_to_key_when_translation_missing', () => {
  const dir = path.join(os.tmpdir(), `xml_store_test_regen_missing_${nextN()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen_multilang.py'), '# marker only\n');
  const xmlPath = path.join(dir, 'translations.xml');
  fs.writeFileSync(xmlPath, FIXTURE);

  addEntry(xmlPath, 'NEW_LABEL', { zh: '', en: 'New Label' });

  const summary = regenMultilang(xmlPath);
  assert.ok(summary.includes("WARNING: key='NEW_LABEL' missing lang 'zh'"));

  const c = fs.readFileSync(path.join(dir, 'multilang.c'), 'utf8');
  assert.ok(c.includes('{ "NEW_LABEL"'));
  const newLabelLine = c.split('\n').find((l) => l.includes('"NEW_LABEL"'));
  assert.ok(newLabelLine.includes('"NEW_LABEL", "New Label"'));

  rmDir(dir);
});

test('test_regen_multilang_errors_without_marker_file', () => {
  const dir = path.join(os.tmpdir(), `xml_store_test_regen_nomarker_${nextN()}`);
  fs.mkdirSync(dir, { recursive: true });
  const xmlPath = path.join(dir, 'translations.xml');
  fs.writeFileSync(xmlPath, FIXTURE);

  assert.throws(() => regenMultilang(xmlPath));
  rmDir(dir);
});

test('test_check_consistency_after_regen_is_consistent', () => {
  const dir = path.join(os.tmpdir(), `xml_store_test_consistency_ok_${nextN()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen_multilang.py'), '# marker\n');
  const xmlPath = path.join(dir, 'translations.xml');
  fs.writeFileSync(xmlPath, FIXTURE);

  regenMultilang(xmlPath);
  const report = checkMultilangConsistency(xmlPath);
  assert.ok(report.consistent);
  assert.ok(report.h_matches);
  assert.ok(report.c_matches);

  rmDir(dir);
});

test('test_check_consistency_detects_xml_edited_after_regen', () => {
  const dir = path.join(os.tmpdir(), `xml_store_test_consistency_bad_${nextN()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen_multilang.py'), '# marker\n');
  const xmlPath = path.join(dir, 'translations.xml');
  fs.writeFileSync(xmlPath, FIXTURE);

  regenMultilang(xmlPath);
  updateTranslation(xmlPath, 'ODO', 'en', 'Total');

  const report = checkMultilangConsistency(xmlPath);
  assert.ok(!report.consistent);
  assert.ok(report.h_matches, '.h 不受影响，应仍然一致');
  assert.ok(!report.c_matches, '.c 应检测出不一致');

  rmDir(dir);
});

test('test_check_consistency_errors_without_marker_file', () => {
  const dir = path.join(os.tmpdir(), `xml_store_test_consistency_nomarker_${nextN()}`);
  fs.mkdirSync(dir, { recursive: true });
  const xmlPath = path.join(dir, 'translations.xml');
  fs.writeFileSync(xmlPath, FIXTURE);

  assert.throws(() => checkMultilangConsistency(xmlPath));
  rmDir(dir);
});

test('test_file_mtime_and_friendly_missing_file_error', () => {
  const p = tempXml('mtime');
  const mtime = fileMtimeMillis(p);
  assert.ok(mtime > 0);
  rm(p);

  const missing = path.join(os.tmpdir(), 'xml_store_definitely_missing_12345.xml');
  assert.throws(
    () => loadTranslations(missing),
    (err) => err.message.includes('不存在')
  );
});

test('test_load_translations_reports_mtime', () => {
  const p = tempXml('mtime_field');
  const data = loadTranslations(p);
  assert.ok(data.mtime > 0);
  rm(p);
});

test('test_regen_scoped_to_each_project_independently', () => {
  const root = path.join(os.tmpdir(), `xml_store_test_two_projects_${nextN()}`);
  const a = path.join(root, 'ProjectA');
  const b = path.join(root, 'ProjectB');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'gen_multilang.py'), '# marker A\n');
  fs.writeFileSync(path.join(b, 'gen_multilang.py'), '# marker B\n');
  fs.writeFileSync(path.join(a, 'translations.xml'), FIXTURE.replace(/ODO/g, 'ODO_A'));
  fs.writeFileSync(path.join(b, 'translations.xml'), FIXTURE.replace(/ODO/g, 'ODO_B'));

  regenMultilang(path.join(a, 'translations.xml'));
  regenMultilang(path.join(b, 'translations.xml'));

  const aC = fs.readFileSync(path.join(a, 'multilang.c'), 'utf8');
  const bC = fs.readFileSync(path.join(b, 'multilang.c'), 'utf8');
  assert.ok(aC.includes('ODO_A') && !aC.includes('ODO_B'));
  assert.ok(bC.includes('ODO_B') && !bC.includes('ODO_A'));

  rmDir(root);
});

test('test_csv_escape_and_parse_roundtrip_with_special_chars', () => {
  const value = 'Say "hi", please\nnewline';
  const escaped = csvEscape(value);
  const line = `k,${escaped}`;
  const rows = parseCsv(line);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][1], value);
});

test('test_export_csv_writes_header_and_rows', () => {
  const xmlPath = tempXml('export');
  const csvPath = tmp('export_out', 'csv');

  exportCsv(xmlPath, csvPath);
  let content = fs.readFileSync(csvPath, 'utf8');
  content = stripBom(content);
  assert.ok(content.startsWith('key,zh,en\r\n'));
  assert.ok(content.includes('ODO,总里程,ODO\r\n'));

  rm(xmlPath);
  rm(csvPath);
});

test('test_import_csv_updates_existing_and_adds_new', () => {
  const xmlPath = tempXml('import_ok');
  const csvPath = tempCsv('import_ok', 'key,zh,en\nODO,总里程2,Total\nTRIP,单次里程,Trip\n');

  const report = importCsv(xmlPath, csvPath);
  assert.strictEqual(report.updated, 1);
  assert.strictEqual(report.added, 1);
  assert.strictEqual(report.warnings.length, 0);

  const data = loadTranslations(xmlPath);
  const odo = data.entries.find((e) => e.key === 'ODO');
  assert.strictEqual(odo.values.en, 'Total');
  const trip = data.entries.find((e) => e.key === 'TRIP');
  assert.strictEqual(trip.values.en, 'Trip');

  rm(xmlPath);
  rm(csvPath);
});

test('test_import_csv_rejects_duplicate_key_and_writes_nothing', () => {
  const xmlPath = tempXml('import_dup');
  const before = fs.readFileSync(xmlPath, 'utf8');
  const csvPath = tempCsv('import_dup', 'key,zh,en\nTRIP,A,Trip\nTRIP,B,Trip2\n');

  assert.throws(
    () => importCsv(xmlPath, csvPath),
    (err) => err.message.includes('重复')
  );

  const after = fs.readFileSync(xmlPath, 'utf8');
  assert.strictEqual(before, after, '校验失败时不应写入任何改动');

  rm(xmlPath);
  rm(csvPath);
});

test('test_import_csv_rejects_unknown_language_column', () => {
  const xmlPath = tempXml('import_unknown_col');
  const csvPath = tempCsv('import_unknown_col', 'key,zh,en,fr\nTRIP,A,Trip,Trajet\n');

  assert.throws(
    () => importCsv(xmlPath, csvPath),
    (err) => err.message.includes('fr')
  );

  rm(xmlPath);
  rm(csvPath);
});

test('test_import_csv_warns_on_missing_language_column', () => {
  const xmlPath = tempXml('import_missing_col');
  const csvPath = tempCsv('import_missing_col', 'key,en\nODO,Total\n');

  const report = importCsv(xmlPath, csvPath);
  assert.ok(report.warnings.some((w) => w.includes('zh')));

  const data = loadTranslations(xmlPath);
  const odo = data.entries.find((e) => e.key === 'ODO');
  assert.strictEqual(odo.values.zh, '总里程', '未出现在 CSV 里的语言应保持原值不变');
  assert.strictEqual(odo.values.en, 'Total');

  rm(xmlPath);
  rm(csvPath);
});

test('test_import_csv_skips_empty_cell_for_existing_key_but_writes_it_for_new_key', () => {
  const xmlPath = tempXml('import_skip_empty');
  const csvPath = tempCsv('import_skip_empty', 'key,zh,en\nODO,总里程,\nTRIP,,Trip\n');

  const report = importCsv(xmlPath, csvPath);
  assert.strictEqual(report.updated, 1);
  assert.strictEqual(report.added, 1);
  assert.ok(report.warnings.some((w) => w.includes('ODO') && w.includes('保留原有翻译')));
  assert.ok(report.warnings.some((w) => w.includes('TRIP') && w.includes('新增条目')));

  const data = loadTranslations(xmlPath);
  const odo = data.entries.find((e) => e.key === 'ODO');
  assert.strictEqual(odo.values.en, 'ODO', '已有 key 的空列不应清空原值');
  const trip = data.entries.find((e) => e.key === 'TRIP');
  assert.strictEqual(trip.values.zh, '', '新增 key 的空列本来就没有旧值，应照写空值');

  rm(xmlPath);
  rm(csvPath);
});

test('test_import_csv_rejects_invalid_key_format', () => {
  const xmlPath = tempXml('import_bad_key');
  const csvPath = tempCsv('import_bad_key', 'key,zh,en\nbad key!,A,Bad\n');

  assert.throws(
    () => importCsv(xmlPath, csvPath),
    (err) => err.message.includes('非法字符')
  );

  rm(xmlPath);
  rm(csvPath);
});
