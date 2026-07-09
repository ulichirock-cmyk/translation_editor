'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../electron/xml_store');
const { createNewXml } = require('../electron/new_xml');

let COUNTER = 0;
function tempDir() {
  COUNTER += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `new_xml_test_${process.pid}_${COUNTER}_`));
}

test('createNewXml creates template, marker and multilang files', () => {
  const dir = tempDir();
  const xmlPath = path.join(dir, 'translations.xml');
  const summary = createNewXml(xmlPath);
  assert.match(summary, /OK/);

  // XML 可被正常解析，含 zh/en 与示例条目
  const data = store.loadTranslations(xmlPath);
  assert.deepStrictEqual(data.langs.map((l) => l.code), ['zh', 'en']);
  assert.strictEqual(data.entries.length, 1);
  assert.strictEqual(data.entries[0].key, 'HELLO');
  assert.strictEqual(data.entries[0].values.zh, '你好');

  // 同目录生成了标记与 .h/.c，且一致性检查通过
  assert.ok(fs.existsSync(path.join(dir, 'gen_multilang.py')));
  assert.ok(fs.existsSync(path.join(dir, 'multilang.h')));
  assert.ok(fs.readFileSync(path.join(dir, 'multilang.c'), 'utf8').includes('"Hello"'));
  assert.strictEqual(store.checkMultilangConsistency(xmlPath).consistent, true);

  // 新建的文件能继续走正常编辑路径（新增条目 + 保存单元格）
  store.addEntry(xmlPath, 'NEW_KEY', { zh: '新键' });
  store.saveCells(xmlPath, [{ key: 'HELLO', code: 'en', value: 'Hi' }]);
  const after = store.loadTranslations(xmlPath);
  assert.strictEqual(after.entries.length, 2);
  assert.strictEqual(after.entries[0].values.en, 'Hi');
});

test('createNewXml reuses existing marker in parent dir', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'gen_multilang.py'), '# existing marker\n');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  const xmlPath = path.join(sub, 'translations.xml');
  createNewXml(xmlPath);
  // 不在子目录重复建标记，.h/.c 生成到既有标记所在目录
  assert.ok(!fs.existsSync(path.join(sub, 'gen_multilang.py')));
  assert.ok(fs.existsSync(path.join(dir, 'multilang.c')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'gen_multilang.py'), 'utf8'), '# existing marker\n');
});

test('createNewXml refuses to overwrite existing file', () => {
  const dir = tempDir();
  const xmlPath = path.join(dir, 'translations.xml');
  fs.writeFileSync(xmlPath, 'precious');
  assert.throws(() => createNewXml(xmlPath), /文件已存在/);
  assert.strictEqual(fs.readFileSync(xmlPath, 'utf8'), 'precious');
});
