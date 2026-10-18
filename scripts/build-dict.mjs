#!/usr/bin/env node
/**
 * 词库构建脚本：CSV -> 小程序可直接读取的 JSON
 *
 * 用法：
 *   node scripts/build-dict.mjs                    # 读取 data/*.csv
 *   node scripts/build-dict.mjs data/词库导入模板.csv   # 指定单个文件
 *
 * 产出（data/dist/）：
 *   index.json            教材目录 + 词库版本号（很小，直接预置进小程序包）
 *   units.json            单元目录（按教材分组，直接预置进小程序包）
 *   words/<教材id>.json    单本教材的全部词条（约 30~60KB，按需下载或分包）
 *
 * 设计要点：
 *   - wordId 由单词本身派生（如 w_pencil_box），不依赖教材。
 *     同一个单词出现在不同教材时 id 相同，掌握状态可跨教材复用。
 *   - 单元归属、拼写、音标必须来自教材词汇表，脚本只做校验不做猜测。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DATA_DIR = path.join(ROOT, 'data');
const DIST_DIR = path.join(ROOT, 'assets', 'dict');

/** 最小 CSV 解析器：支持双引号包裹的字段（例句里会有逗号） */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/** 由单词派生稳定 id：跨教材复用同一个 id */
function makeWordId(word) {
  const slug = String(word).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return 'w_' + (slug || 'unknown');
}

function loadRows(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (rows[i][idx] ?? '').trim(); });
    if (Object.values(obj).every(v => v === '')) continue;
    obj.__line = i + 1;
    obj.__file = path.basename(file);
    out.push(obj);
  }
  return out;
}

function main() {
  const argFiles = process.argv.slice(2).filter(a => !a.startsWith('-'));
  let files = [];
  if (argFiles.length) {
    files = argFiles.map(f => path.resolve(ROOT, f));
  } else {
    // 默认读取 data/raw 下的真实词库；为空时回退到 data/demo 的演示数据
    const rawDir = path.join(DATA_DIR, 'raw');
    const demoDir = path.join(DATA_DIR, 'demo');
    const scan = (dir) => fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).map(f => path.join(dir, f))
      : [];

    files = scan(rawDir);
    if (!files.length) {
      const demo = scan(demoDir);
      if (demo.length) {
        console.log('提示：data/raw 下没有词库文件，本次使用 data/demo 的演示数据构建。');
        files = demo;
      }
    }
  }
  if (!files.length) {
    console.error('没有找到任何 CSV 文件。请把词库放到 data/raw/ 下，或显式指定文件路径。');
    process.exit(1);
  }

  const errors = [];
  const warns = [];
  const textbooks = new Map();   // id -> meta
  const units = new Map();       // textbookId -> Map(unitKey -> unit)
  const wordsByBook = new Map(); // textbookId -> word[]
  const seen = new Set();        // `${textbookId}::${unitSeq}::${word}` 去重
  // 只有当词表里确实提供了音频列时，才校验音频缺失（本期暂不做发音）
  let audioInUse = false;
  const audioRows = [];
  let posMissing = 0;            // 词性缺失数量，最后合并成一条告警

  const REQUIRED = ['textbook_id', 'textbook_name', 'grade', 'term', 'unit_seq', 'unit_name', 'word', 'meaning_cn'];

  for (const file of files) {
    const rows = loadRows(file);
    for (const r of rows) {
      const where = `${r.__file}:${r.__line}`;
      const missing = REQUIRED.filter(k => !r[k]);
      if (missing.length) {
        errors.push(`${where} 缺少必填字段：${missing.join(', ')}`);
        continue;
      }

      const bookId = r.textbook_id;
      if (!textbooks.has(bookId)) {
        textbooks.set(bookId, {
          id: bookId,
          name: r.textbook_name,
          publisher: r.publisher || '',
          grade: Number(r.grade),
          term: r.term,
          unitCount: 0,
          wordCount: 0,
          file: `words/${bookId}.json`
        });
        units.set(bookId, new Map());
        wordsByBook.set(bookId, []);
      } else {
        const meta = textbooks.get(bookId);
        if (meta.name !== r.textbook_name) {
          warns.push(`${where} 教材 ${bookId} 的名称前后不一致：“${meta.name}” vs “${r.textbook_name}”`);
        }
        if (Number(meta.grade) !== Number(r.grade) || meta.term !== r.term) {
          warns.push(`${where} 教材 ${bookId} 的年级/学期前后不一致`);
        }
      }

      const unitSeq = Number(r.unit_seq);
      if (!Number.isFinite(unitSeq)) {
        errors.push(`${where} unit_seq 不是数字：“${r.unit_seq}”`);
        continue;
      }
      const unitKey = String(unitSeq);
      const unitMap = units.get(bookId);
      if (!unitMap.has(unitKey)) {
        unitMap.set(unitKey, {
          id: `${bookId}_u${unitSeq}`,
          textbookId: bookId,
          seq: unitSeq,
          name: r.unit_name,
          wordCount: 0
        });
      }

      const word = r.word;
      const dupKey = `${bookId}::${unitSeq}::${word.toLowerCase()}`;
      if (seen.has(dupKey)) {
        warns.push(`${where} 重复词条（同一单元内已出现）：${word}`);
      }
      seen.add(dupKey);

      if (!r.phonetic) warns.push(`${where} 缺少音标：${word}`);
      if (!r.pos) posMissing++;
      if (r.audio_file) audioInUse = true;
      if (!r.audio_file) audioRows.push({ where, word });

      const rec = {
        id: makeWordId(word),
        word,
        phonetic: r.phonetic || '',
        pos: r.pos || '',
        meaningCn: r.meaning_cn,
        example: r.example || '',
        exampleCn: r.example_cn || '',
        audio: r.audio_file || `${makeWordId(word)}.mp3`,
        unitId: unitMap.get(unitKey).id,
        unitSeq,
        seq: Number(r.seq) || 0
      };
      wordsByBook.get(bookId).push(rec);
      unitMap.get(unitKey).wordCount++;
      textbooks.get(bookId).wordCount++;
    }
  }

  if (audioInUse) {
    audioRows.forEach(x => warns.push(`${x.where} 缺少音频文件名：${x.word}`));
  } else {
    console.log('（词表未提供音频列，已跳过音频校验）');
  }
  if (posMissing) {
    warns.push(`共 ${posMissing} 个词条缺少词性（pos），界面暂不显示词性；需要的话补一列即可`);
  }

  // 组装产出
  fs.mkdirSync(path.join(DIST_DIR, 'words'), { recursive: true });

  const index = {
    version: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    textbooks: []
  };

  const allUnits = {};
  const allWords = {};
  let totalWords = 0;
  const uniqueWords = new Set();

  for (const [bookId, meta] of textbooks) {
    const unitList = [...units.get(bookId).values()].sort((a, b) => a.seq - b.seq);
    unitList.forEach((u, i) => { u.order = i + 1; });
    meta.unitCount = unitList.length;
    allUnits[bookId] = unitList;

    const words = wordsByBook.get(bookId)
      .sort((a, b) => (a.unitSeq - b.unitSeq) || (a.seq - b.seq));
    words.forEach(w => uniqueWords.add(w.id));
    allWords[bookId] = words;

    fs.writeFileSync(
      path.join(DIST_DIR, 'words', `${bookId}.json`),
      JSON.stringify(words)
    );
    totalWords += words.length;
    index.textbooks.push(meta);
  }

  index.textbooks.sort((a, b) =>
    (a.publisher === b.publisher ? 0 : a.publisher < b.publisher ? -1 : 1) ||
    (a.grade - b.grade) || (a.term === '上' ? -1 : 1)
  );

  fs.writeFileSync(path.join(DIST_DIR, 'index.json'), JSON.stringify(index, null, 2));
  fs.writeFileSync(path.join(DIST_DIR, 'units.json'), JSON.stringify(allUnits));

  // 汇总成一份 CommonJS bundle，供小程序本地 require（小程序不支持动态路径 require）
  const bundle = {
    version: index.version,
    textbooks: index.textbooks,
    units: allUnits,
    words: allWords
  };
  fs.writeFileSync(
    path.join(DIST_DIR, 'bundle.js'),
    '// 本文件由 scripts/build-dict.mjs 自动生成，请勿手工修改。\n' +
    '// 词库版本：' + index.version + '\n' +
    'module.exports = ' + JSON.stringify(bundle) + ';\n'
  );

  // 报告
  console.log('\n=== 词库构建报告 ===\n');
  console.log(`教材数：${index.textbooks.length}`);
  console.log(`词条总数（含跨册重复）：${totalWords}`);
  console.log(`去重后独立单词数：${uniqueWords.size}`);
  console.log('\n按教材：');
  for (const t of index.textbooks) {
    const kb = (fs.statSync(path.join(DIST_DIR, 'words', `${t.id}.json`)).size / 1024).toFixed(1);
    console.log(`  ${t.name.padEnd(28, '　')} ${String(t.unitCount).padStart(2)} 单元  ${String(t.wordCount).padStart(4)} 词  ${kb.padStart(6)} KB`);
  }
  const totalKb = index.textbooks.reduce(
    (s, t) => s + fs.statSync(path.join(DIST_DIR, 'words', `${t.id}.json`)).size, 0) / 1024;
  console.log(`\n词条 JSON 总体积：${totalKb.toFixed(1)} KB`);

  if (errors.length) {
    console.log(`\n[错误] ${errors.length} 条（必须修复）：`);
    errors.slice(0, 30).forEach(e => console.log('  ✗ ' + e));
    if (errors.length > 30) console.log(`  ... 另有 ${errors.length - 30} 条`);
  }
  if (warns.length) {
    console.log(`\n[警告] ${warns.length} 条（可忽略，但建议补齐）：`);
    warns.slice(0, 30).forEach(w => console.log('  ! ' + w));
    if (warns.length > 30) console.log(`  ... 另有 ${warns.length - 30} 条`);
  }
  console.log(`\n产出目录：${DIST_DIR}\n`);

  process.exit(errors.length ? 1 : 0);
}

main();
