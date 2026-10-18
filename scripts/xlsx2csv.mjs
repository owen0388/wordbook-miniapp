/**
 * xlsx → CSV 直读工具（零第三方依赖，只用 Node 内置 zlib）
 *
 * 用途：把教材单词表 xlsx 直接变成项目能吃的 CSV，并自动登记到 books.json。
 *      以后新增教材不用改代码，把 xlsx 丢进 data/raw-src/ 跑一次即可。
 *
 * 运行：
 *   node scripts/xlsx2csv.mjs                 # 扫描 data/raw-src/ 下所有 .xlsx
 *   node scripts/xlsx2csv.mjs 语文.xlsx ...   # 只处理指定文件
 *
 * 编码说明：
 *   xlsx 内部是 ZIP + XML，中文有两种存法——共享字符串表（sharedStrings.xml）
 *   或内联字符串（inlineStr），且常被写成 &#33521; 这类数字实体。
 *   这里统一按 XML 实体解码，输出 UTF-8（无 BOM），不会出现乱码。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'data/raw-src');

/* ============ ZIP 读取 ============ */

function readZip(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 ZIP 目录）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + fnLen);
    files.set(name, { method, compSize, localOff });
    p += 46 + fnLen + extraLen + cmtLen;
  }

  return {
    names: [...files.keys()],
    has: (n) => files.has(n),
    text(name) {
      const f = files.get(name);
      if (!f) return null;
      const lfnLen = buf.readUInt16LE(f.localOff + 26);
      const lexLen = buf.readUInt16LE(f.localOff + 28);
      const start = f.localOff + 30 + lfnLen + lexLen;
      const raw = buf.subarray(start, start + f.compSize);
      const out = f.method === 0 ? raw
        : f.method === 8 ? zlib.inflateRawSync(raw)
          : (() => { throw new Error('不支持的压缩方式 ' + f.method); })();
      return out.toString('utf8');
    }
  };
}

/* ============ XML 解码 ============ */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 解码 XML 实体：&#33521; / &#x82F1; / &amp; */
function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X'
        ? parseInt(g.slice(2), 16)
        : parseInt(g.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED[g] != null ? NAMED[g] : m;
  });
}

/** 取出片段内所有 <t> 文本并拼接（富文本会被拆成多个 run） */
function collectText(frag) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(frag))) out += m[1];
  return unescapeXml(out);
}

function parseSharedStrings(xml) {
  const list = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) list.push(collectText(m[1]));
  return list;
}

function colToIndex(ref) {
  const letters = ref.replace(/[^A-Za-z]/g, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 解析工作表为二维字符串数组（按行号对齐，空行保留为空数组） */
function parseSheet(xml, shared) {
  const byRow = new Map();
  let maxCol = 0;

  const rowRe = /<row([^>]*)>([\s\S]*?)<\/row>|<row([^>]*)\/>/g;
  let rm;
  let autoRow = 0;

  while ((rm = rowRe.exec(xml))) {
    const attrs = rm[1] || rm[3] || '';
    const body = rm[2] || '';
    const rNum = /(?:^|\s)r="(\d+)"/.exec(attrs);
    const rowIdx = rNum ? Number(rNum[1]) - 1 : autoRow;
    autoRow = rowIdx + 1;

    const cells = [];
    const cellRe = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(body))) {
      const cAttrs = cm[1] || '';
      const cBody = cm[2] || '';
      const ref = /(?:^|\s)r="([A-Za-z]+\d+)"/.exec(cAttrs);
      const type = /(?:^|\s)t="([^"]+)"/.exec(cAttrs);
      const ci = ref ? colToIndex(ref[1]) : cells.length;

      let val = '';
      if (type && type[1] === 'inlineStr') {
        val = collectText(cBody);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(cBody);
        if (v) {
          val = type && type[1] === 's'
            ? (shared[Number(v[1])] != null ? shared[Number(v[1])] : '')
            : unescapeXml(v[1]);
        } else if (cBody.indexOf('<is>') >= 0) {
          val = collectText(cBody);
        }
      }
      cells[ci] = val;
      if (ci > maxCol) maxCol = ci;
    }
    byRow.set(rowIdx, cells);
  }

  const maxRow = byRow.size ? Math.max(...byRow.keys()) : -1;
  const grid = [];
  for (let r = 0; r <= maxRow; r++) {
    const row = byRow.get(r) || [];
    const norm = [];
    for (let c = 0; c <= maxCol; c++) norm.push(row[c] != null ? String(row[c]) : '');
    grid.push(norm);
  }
  return grid;
}

/* ============ CSV 输出 ============ */

function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

/* ============ 文件名 → 教材元数据 ============ */

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function inferBook(fileName) {
  const base = fileName.replace(/\.xlsx$/i, '');
  // 年级：优先阿拉伯数字+年级，其次中文数字+年级
  let grade = null;
  const g1 = /([1-6])\s*年级/.exec(base);
  const g2 = /([一二三四五六])\s*年级/.exec(base);
  if (g1) grade = Number(g1[1]);
  else if (g2) grade = CN_NUM[g2[1]];

  // 学期
  const term = /下册/.test(base) ? '下' : (/上册/.test(base) ? '上' : '上');

  // 出版社
  let publisher = '人教版';
  let idPrefix = 'pep';
  let namePrefix = '人教版（PEP）';
  if (/北师大/.test(base)) { publisher = '北师大版'; idPrefix = 'bsd'; namePrefix = '北师大版'; }
  else if (/PEP|人教版/i.test(base)) { publisher = '人教版'; idPrefix = 'pep'; namePrefix = '人教版（PEP）'; }

  if (!grade) return null;

  return {
    textbookId: `${idPrefix}_${grade}${term === '上' ? 'a' : 'b'}`,
    textbookName: `${namePrefix}${['一', '二', '三', '四', '五', '六'][grade - 1]}年级${term}册`,
    publisher,
    grade,
    term
  };
}

/** 源表列名可能有不同叫法，做一组别名 */
const ALIAS = {
  word: ['英文', '单词', 'word', 'Word', '英语'],
  meaningCn: ['中文', '释义', '意思', '词义', '中文释义'],
  phonetic: ['音标', 'phonetic', 'Phonetic', '国际音标'],
  example: ['例句', 'example', 'Example'],
  note: ['备注', 'note', 'Note', '说明'],
  unit: ['单元', 'unit', 'Unit', '单元号']
};

function pickHeader(header, keys) {
  for (const k of keys) {
    const i = header.indexOf(k);
    if (i >= 0) return i;
  }
  return -1;
}

/* ============ 主流程 ============ */

const argFiles = process.argv.slice(2).filter((a) => !a.startsWith('-'));
let files = [];
if (argFiles.length) {
  files = argFiles.map((f) => path.resolve(process.cwd(), f));
} else {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('找不到目录：' + SRC_DIR);
    process.exit(1);
  }
  files = fs.readdirSync(SRC_DIR)
    .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
    .map((f) => path.join(SRC_DIR, f));
  files.sort();
}

if (!files.length) {
  console.log('data/raw-src/ 下没有 .xlsx 文件。');
  console.log('把教材单词表 xlsx 丢进 ' + path.relative(ROOT, SRC_DIR) + ' 再跑一次即可。');
  process.exit(0);
}

const booksFile = path.join(SRC_DIR, 'books.json');
let books = [];
if (fs.existsSync(booksFile)) {
  try { books = JSON.parse(fs.readFileSync(booksFile, 'utf8')); } catch { books = []; }
}

const done = [];
const failed = [];

for (const file of files) {
  const fileName = path.basename(file);
  try {
    const buf = fs.readFileSync(file);
    const zip = readZip(buf);

    const sharedPath = 'xl/sharedStrings.xml';
    const shared = zip.has(sharedPath) ? parseSharedStrings(zip.text(sharedPath)) : [];

    // 取第一张工作表
    const sheetName = zip.names
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(/(\d+)/.exec(a)[1]);
        const nb = Number(/(\d+)/.exec(b)[1]);
        return na - nb;
      })[0];
    if (!sheetName) throw new Error('xlsx 里没有工作表');

    const grid = parseSheet(zip.text(sheetName), shared);
    if (grid.length < 2) throw new Error('表格没有数据行');

    const header = grid[0].map((h) => h.trim());

    // 定位表头（容忍前面有标题行）
    let headerRow = 0;
    for (let i = 0; i < Math.min(grid.length, 8); i++) {
      const h = grid[i].map((x) => x.trim());
      if (pickHeader(h, ALIAS.word) >= 0 && pickHeader(h, ALIAS.meaningCn) >= 0) {
        headerRow = i;
        break;
      }
    }
    const realHeader = grid[headerRow].map((h) => h.trim());
    const cWord = pickHeader(realHeader, ALIAS.word);
    const cMean = pickHeader(realHeader, ALIAS.meaningCn);
    if (cWord < 0 || cMean < 0) {
      throw new Error('找不到「英文 / 中文」这两列，实际表头：' + realHeader.join(' | '));
    }
    const cPhon = pickHeader(realHeader, ALIAS.phonetic);
    const cEx = pickHeader(realHeader, ALIAS.example);
    const cNote = pickHeader(realHeader, ALIAS.note);

    const meta = inferBook(fileName);
    if (!meta) throw new Error('从文件名识别不出年级，请把文件名改成类似「…四年级 上册（PEP）…」');

    // 输出 CSV：保留源表原列，供 import-wordlist 按列名映射
    const outHeader = ['英文', '中文', '音标', '例句', '备注'];
    const outRows = [outHeader];
    let rows = 0;
    for (let i = headerRow + 1; i < grid.length; i++) {
      const r = grid[i];
      const w = (r[cWord] || '').trim();
      const m = (r[cMean] || '').trim();
      if (!w || !m) continue;
      outRows.push([
        w,
        m,
        cPhon >= 0 ? (r[cPhon] || '').trim() : '',
        cEx >= 0 ? (r[cEx] || '').trim() : '',
        cNote >= 0 ? (r[cNote] || '').trim() : ''
      ]);
      rows++;
    }
    if (!rows) throw new Error('清洗后没有有效词条');

    const outName = meta.textbookId.replace('_', '-') + '.csv';
    const outPath = path.join(SRC_DIR, outName);
    fs.writeFileSync(outPath, toCsv(outRows), 'utf8');

    // 登记 books.json
    const entry = {
      source: outName,
      textbookId: meta.textbookId,
      textbookName: meta.textbookName,
      publisher: meta.publisher,
      grade: meta.grade,
      term: meta.term,
      unitColumn: null,
      columns: {
        word: '英文',
        meaningCn: '中文',
        phonetic: '音标',
        example: '例句',
        note: '备注'
      }
    };
    const at = books.findIndex((b) => b.textbookId === meta.textbookId);
    if (at >= 0) books[at] = Object.assign({}, books[at], entry);
    else books.push(entry);

    done.push({ file: fileName, out: path.relative(ROOT, outPath), book: meta.textbookName, words: rows });
  } catch (e) {
    failed.push({ file: fileName, error: e.message });
  }
}

books.sort((a, b) => (a.grade - b.grade) || String(a.term).localeCompare(String(b.term)));
fs.writeFileSync(booksFile, JSON.stringify(books, null, 2) + '\n', 'utf8');

if (done.length) {
  console.log('xlsx 转换完成\n');
  done.forEach((d) => {
    console.log('  ' + d.book);
    console.log('    ' + d.file + ' → ' + d.out + '（' + d.words + ' 词）');
  });
  console.log('\nbooks.json 已同步（共 ' + books.length + ' 本登记）');
  console.log('下一步：node scripts/import-wordlist.mjs && node scripts/build-dict.mjs');
}

if (failed.length) {
  console.log('\n以下文件处理失败：');
  failed.forEach((f) => console.log('  ✗ ' + f.file + '\n    ' + f.error));
  process.exitCode = 1;
}
