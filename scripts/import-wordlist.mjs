/**
 * 把外部导出的单词表（xlsx / 平台导出）转成本项目标准的词库源 CSV。
 *
 * 输入： data/raw-src/books.json 里登记的源文件（表头为中文字段）
 * 输出： data/raw/<textbookId>.csv（build-dict.mjs 的输入）
 *
 * 做三件事：
 *   1. 字段映射（源表列名 → 本项目字段）
 *   2. 释义清洗（去掉教材里的 * 标记、多余空格、重复分隔符）
 *   3. 补齐教材元数据与单元归属
 *
 * 运行： node scripts/import-wordlist.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'data/raw-src');
const OUT_DIR = path.join(ROOT, 'data/raw');

const OUT_HEADER = [
  'textbook_id', 'textbook_name', 'publisher', 'grade', 'term',
  'unit_seq', 'unit_name', 'seq', 'word', 'phonetic', 'pos',
  'meaning_cn', 'example', 'example_cn', 'audio_file', 'note'
];

/* ---------- CSV ---------- */

/** 支持双引号包裹、内嵌逗号与转义引号的 CSV 解析 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

/* ---------- 清洗 ---------- */

/**
 * 教材词汇表里的释义常带记号，例如：
 *   "伯母；婶母； *舅母；姑母；姨母"   → 星号是义项标记
 *   "（ 口语）爸爸；爹爹"              → 全角括号里多打了一个空格
 *   "给……浇水； *水"                  → 星号前有空格
 * 这些直接进产品会让小朋友看到奇怪符号，必须清掉。
 */
function cleanMeaning(input) {
  let s = String(input || '');
  s = s.replace(/\s*\*\s*/g, '');                 // 星号及其前后空格（"女教师的 *称呼" → "女教师的称呼"）
  s = s.replace(/（\s+/g, '（').replace(/\s+）/g, '）'); // 全角括号内空格
  s = s.replace(/\s+/g, ' ');                     // 合并连续空白
  s = s.replace(/\s*；\s*/g, '；');                // 分隔符两侧空格
  s = s.replace(/；{2,}/g, '；');
  s = s.replace(/^[；、,，\s]+/, '').replace(/[；、,，\s]+$/, '');
  return s.trim();
}

function cleanWord(input) {
  return String(input || '').trim();
}

function cleanPhonetic(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  return /^\/.*\/$/.test(s) ? s : '/' + s.replace(/^\/|\/$/g, '') + '/';
}

/* ---------- 主流程 ---------- */

const configFile = path.join(SRC_DIR, 'books.json');
if (!fs.existsSync(configFile)) {
  console.error('缺少 ' + path.relative(ROOT, configFile));
  process.exit(1);
}
const books = JSON.parse(fs.readFileSync(configFile, 'utf8'));
fs.mkdirSync(OUT_DIR, { recursive: true });

let totalOut = 0;
const summary = [];

books.forEach((book) => {
  const srcPath = path.join(SRC_DIR, book.source);
  if (!fs.existsSync(srcPath)) {
    console.error('缺少源文件：' + book.source);
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(srcPath, 'utf8').replace(/^\uFEFF/, ''));
  if (rows.length < 2) {
    console.error(book.source + ' 没有数据行');
    process.exit(1);
  }
  const header = rows[0].map((h) => h.trim());
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) { console.error(book.source + ' 找不到列：' + name); process.exit(1); }
    return i;
  };
  const map = {
    word: col(book.columns.word),
    meaningCn: col(book.columns.meaningCn),
    phonetic: book.columns.phonetic && header.indexOf(book.columns.phonetic) >= 0
      ? header.indexOf(book.columns.phonetic) : -1,
    example: book.columns.example && header.indexOf(book.columns.example) >= 0
      ? header.indexOf(book.columns.example) : -1,
    note: book.columns.note && header.indexOf(book.columns.note) >= 0
      ? header.indexOf(book.columns.note) : -1,
    unit: book.unitColumn && header.indexOf(book.unitColumn) >= 0
      ? header.indexOf(book.unitColumn) : -1
  };

  const out = [OUT_HEADER];
  const seen = new Set();
  let seq = 0;
  let lastUnit = null;
  let unitSeq = 0;
  let skipped = 0;
  let starFixed = 0;

  rows.slice(1).forEach((r) => {
    const word = cleanWord(r[map.word]);
    const meaningRaw = String(r[map.meaningCn] || '');
    const meaning = cleanMeaning(meaningRaw);
    const phonetic = map.phonetic >= 0 ? cleanPhonetic(r[map.phonetic]) : '';
    const example = map.example >= 0 ? String(r[map.example] || '').trim() : '';
    const note = map.note >= 0 ? String(r[map.note] || '').trim() : '';

    if (!word || !meaning) { skipped++; return; }
    const key = word.toLowerCase();
    if (seen.has(key)) { skipped++; return; }
    seen.add(key);

    if (/\*/.test(meaningRaw)) starFixed++;

    // 单元归属：源表有单元列就用；没有就整册当 1 个单元（当前小学词表按整册背）
    let uName;
    if (map.unit >= 0) {
      uName = String(r[map.unit] || '').trim() || '未分单元';
      if (uName !== lastUnit) { unitSeq++; lastUnit = uName; seq = 0; }
    } else {
      uName = '全册';
      if (unitSeq === 0) unitSeq = 1;
    }
    seq++;

    out.push([
      book.textbookId, book.textbookName, book.publisher, book.grade, book.term,
      unitSeq, uName, seq, word, phonetic, '',
      meaning, example, '', '', note
    ]);
  });

  const outFile = path.join(OUT_DIR, book.textbookId + '.csv');
  fs.writeFileSync(outFile, toCsv(out), 'utf8');
  totalOut += out.length - 1;
  summary.push({
    book: book.textbookName,
    file: path.relative(ROOT, outFile),
    words: out.length - 1,
    units: unitSeq,
    skipped,
    starFixed,
    withPhonetic: out.slice(1).filter((r) => r[9]).length,
    withExample: out.slice(1).filter((r) => r[12]).length
  });
});

console.log('导入完成\n');
summary.forEach((s) => {
  console.log('  ' + s.book);
  console.log('    输出：' + s.file);
  console.log('    词条 ' + s.words + ' 条 · 单元 ' + s.units + ' 个');
  console.log('    有音标 ' + s.withPhonetic + ' · 有例句 ' + s.withExample);
  console.log('    清洗星号释义 ' + s.starFixed + ' 条 · 跳过无效/重复 ' + s.skipped + ' 条');
});
console.log('\n合计 ' + totalOut + ' 个词条 → 下一步运行 node scripts/build-dict.mjs');

/* ---------- 额外产出一份 Excel 友好的总览 ----------
 * 程序内部统一用 UTF-8（无 BOM）；但 Excel 双击打开无 BOM 的 UTF-8 会按 GBK 解码而显示乱码。
 * 所以单独生成一份带 BOM 的副本，专门给人在 Excel / WPS 里核对，不参与构建。
 */
const overview = [OUT_HEADER];
books.forEach((b) => {
  const f = path.join(OUT_DIR, b.textbookId + '.csv');
  if (!fs.existsSync(f)) return;
  const rows = parseCsv(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  rows.slice(1).forEach((r) => overview.push(r));
});
const overviewFile = path.join(ROOT, 'data', '词库总览.csv');
fs.writeFileSync(overviewFile, '\uFEFF' + toCsv(overview), 'utf8');
console.log('已生成可直接用 Excel 打开核对的副本：' + path.relative(ROOT, overviewFile));
