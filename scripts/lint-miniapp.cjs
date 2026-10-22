#!/usr/bin/env node
/**
 * 小程序静态校验（编译前自查）
 * 运行： node scripts/lint-miniapp.cjs
 *
 * 为什么需要它：
 *   微信开发者工具的报错是「编译期」的，改一轮要重新编译才能看到结果。
 *   下面这些问题都会直接让编译失败，但都能在本地用文本规则查出来：
 *
 *   1) WXSS 不支持 `*` 通配符选择器      → error at token `*`
 *   2) 页面缺 .json                      → 页面无法注册，整个小程序白屏
 *   3) 括号不配对                        → 样式表被截断，后面全部失效
 *   4) WXML 标签不配对                    → 页面渲染报错
 *   5) 用了较新的 CSS 简写（inset / gap 等）在旧安卓 WebView 上不生效
 *
 * 这个脚本不替代真机验证，只负责把"必然失败"的低级错误挡在前面。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let errors = 0;
let warns = 0;
let checks = 0;

function err(msg) { errors++; console.log('  ✗ ' + msg); }
function warn(msg) { warns++; console.log('  ! ' + msg); }
function ok(msg) { checks++; console.log('  ✓ ' + msg); }

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

function walk(dir, out, filter) {
  fs.readdirSync(dir).forEach((name) => {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (['node_modules', '.git', 'data', 'scripts', 'preview'].indexOf(name) >= 0) return;
      walk(p, out, filter);
    } else if (filter(name)) {
      out.push(p);
    }
  });
  return out;
}

/** 去掉 CSS 注释，避免注释里的 * 被误判 */
function stripCssComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* ---------- 1. 页面文件是否齐全 ---------- */
console.log('\n[1] 页面文件完整性');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const pages = appJson.pages || [];
if (!pages.length) err('app.json 里没有 pages');
pages.forEach((p) => {
  const base = path.join(ROOT, p);
  ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    const f = base + '.' + ext;
    if (!fs.existsSync(f)) err(rel(f) + ' 不存在（缺 .json 会导致页面无法注册）');
  });
});
ok(pages.length + ' 个页面的 js/json/wxml/wxss 都已就位');

/* ---------- 2. WXSS 规则 ---------- */
console.log('\n[2] WXSS 语法与兼容性');
const wxssFiles = walk(ROOT, [], (n) => n.endsWith('.wxss'));
wxssFiles.forEach((f) => {
  const raw = fs.readFileSync(f, 'utf8');
  const s = stripCssComments(raw);
  const name = rel(f);

  // 括号平衡
  if (s.split('{').length !== s.split('}').length) {
    err(name + ' 大括号不配对');
  }

  s.split('\n').forEach((line, i) => {
    const ln = i + 1;
    const t = line.trim();

    // 通配符选择器：`*` 或 `> *` 或 `*:nth-child`
    if (/(^|[,\s>+~])\*(\s*[{:,.\[]|$)/.test(t) && t.indexOf('font') < 0) {
      err(name + ':' + ln + ' 使用了 * 通配符选择器（WXSS 不支持，改用 view）');
    }

    // 较新的 CSS 简写，旧安卓 WebView 不认
    if (/^inset\s*:/.test(t)) {
      warn(name + ':' + ln + ' inset 简写在旧安卓上不生效，建议展开成 top/right/bottom/left');
    }
    // 鼠标态选择器在小程序里无意义
    if (/:hover|:focus\b/.test(t)) {
      warn(name + ':' + ln + ' :hover / :focus 在真机上不触发，改用 hover-class');
    }
  });

  // @font-face 必须走 base64 或网络地址，本地路径不生效
  const fontFaces = s.match(/@font-face\{[\s\S]*?\}/g) || [];
  fontFaces.forEach((ff) => {
    if (/src\s*:\s*url\(\s*['"]?(?!data:|https?:)/.test(ff) && !/url\('?data:/.test(ff)) {
      warn(name + ' @font-face 引用了本地文件路径，小程序不支持，需转 base64 或放网络');
    }
  });

  /* ---- 以下三条是为了拦住"超长行被工具截断后写回文件"这类事故 ---- */

  // 1) 截断标记：说明文件是工具输出被原样重建的，内容已经残缺
  if (raw.indexOf('truncated') >= 0) {
    err(name + ' 含 "truncated" 字样，疑似被工具截断后写回，内容不完整');
  }

  // 2) 单引号必须成对。base64 那种超长行被腰斩时，结尾的引号和分号会一起丢，
  //    字符串不闭合，WXSS 编译器一路往下吃到奇怪字符才报 unexpected token
  const sq = (s.match(/'/g) || []).length;
  if (sq % 2 !== 0) {
    err(name + ' 单引号数量为奇数（' + sq + '），存在未闭合的字符串');
  }
  const dq = (s.match(/"/g) || []).length;
  if (dq % 2 !== 0) {
    warn(name + ' 双引号数量为奇数（' + dq + '），请确认没有未闭合字符串');
  }

  // 3) base64 字体必须"url('data:...')"完整闭合。截断后这里匹配不上
  if (fontFaces.length) {
    fontFaces.forEach((ff) => {
      if (ff.indexOf('data:') >= 0 && !/url\(\s*['"]data:[^'"]+['"]\s*\)/.test(ff)) {
        err(name + ' 的 @font-face base64 未正确闭合（引号或括号丢失）');
      }
    });
  }

  // 4) 超长单行：改这种文件必须用脚本，别手工复制粘贴。
  //    字体文件本身就是一条 base64 长行，属正常，不提示
  if (!/font\.wxss$/.test(name)) {
    raw.split('\n').forEach((line, i) => {
      if (line.length > 5000) {
        warn(name + ':' + (i + 1) + ' 有 ' + line.length + ' 字符的长行（base64 等），'
          + '重写该文件时必须用脚本处理，不能依赖工具回显后手工复制');
      }
    });
  }

  // 5) @import 指向的文件必须存在
  (s.match(/@import\s+['"][^'"]+['"]/g) || []).forEach((line) => {
    const m = /@import\s+['"]([^'"]+)['"]/.exec(line);
    if (!m) return;
    const target = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(target)) {
      err(name + ' 的 @import 指向不存在的文件：' + m[1]);
    }
  });
});
ok(wxssFiles.length + ' 个 WXSS 文件已检查');

/* ---------- 3. WXML 标签配对 ---------- */
console.log('\n[3] WXML 标签配对');
const wxmlFiles = walk(ROOT, [], (n) => n.endsWith('.wxml'));
wxmlFiles.forEach((f) => {
  const s = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  ['view', 'block', 'scroll-view', 'swiper', 'button', 'text'].forEach((tag) => {
    const open = (s.match(new RegExp('<' + tag + '(\\s|>)', 'g')) || []).length;
    const close = (s.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    // 自闭合写法 <tag ... />
    const selfClose = (s.match(new RegExp('<' + tag + '[^>]*/>', 'g')) || []).length;
    if (open - selfClose !== close) {
      err(rel(f) + ' <' + tag + '> 数量不配对：开 ' + (open - selfClose) + ' / 闭 ' + close);
    }
  });
});
ok(wxmlFiles.length + ' 个 WXML 文件已检查');

/* ---------- 4. 页面 JSON 合法性 ---------- */
console.log('\n[4] JSON 合法性');
const jsonFiles = walk(ROOT, [], (n) => n.endsWith('.json'));
jsonFiles.forEach((f) => {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    err(rel(f) + ' 不是合法 JSON：' + e.message);
  }
});
ok(jsonFiles.length + ' 个 JSON 文件已检查');

/* ---------- 5. JS 里的 require 路径 ---------- */
console.log('\n[5] require 路径');
const jsFiles = walk(ROOT, [], (n) => n.endsWith('.js'))
  .filter((f) => rel(f).indexOf('assets/') !== 0);
let requireCount = 0;
jsFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (spec.charAt(0) !== '.') continue;      // 只查相对路径
    requireCount++;
    const base = path.resolve(path.dirname(f), spec);
    const hit = ['', '.js', '.json', '/index.js']
      .map((ext) => base + ext)
      .some((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!hit) {
      err(rel(f) + ' require("' + spec + '") 指向的文件不存在'
        + '（相对当前文件解析为 ' + rel(base) + '）');
    }
  }
});
ok(requireCount + ' 条相对 require 路径有效');

/* ---------- 6. 音效资源 ---------- */
console.log('\n[6] 资源完整性');
['tap', 'pup', 'correct', 'wrong', 'finish'].forEach((n) => {
  const f = path.join(ROOT, 'assets', 'sfx', n + '.mp3');
  if (!fs.existsSync(f)) err('缺少音效 assets/sfx/' + n + '.mp3（运行 node scripts/build-sfx 前需先跑 build-sfx.py）');
});
if (fs.existsSync(path.join(ROOT, 'assets', 'sfx'))) ok('5 个音效齐全');

const dict = path.join(ROOT, 'assets', 'dict', 'bundle.js');
if (!fs.existsSync(dict)) err('缺少词库产物 assets/dict/bundle.js');
else ok('词库产物存在');

// WXML 里写的 /assets/... 图片必须真实存在，否则真机上只是一块空白，
// 控制台也不会报错（和之前 require 路径写错整页白屏是同一类隐形故障）
let imgRefs = 0;
const imgRe = /src\s*=\s*"(\/assets\/[^"{}]+)"/g;
wxmlFiles.forEach((f) => {
  const file = path.isAbsolute(f) ? f : path.join(ROOT, f);
  const src = fs.readFileSync(file, 'utf8');
  let m;
  imgRe.lastIndex = 0;
  while ((m = imgRe.exec(src))) {
    imgRefs++;
    const rel = m[1].replace(/^\//, '');
    if (!fs.existsSync(path.join(ROOT, rel))) {
      err(path.basename(f) + ' 引用的图片不存在：' + m[1]);
    }
  }
});
if (imgRefs) ok(imgRefs + ' 处 /assets 图片引用全部存在');

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(44));
console.log('通过检查 ' + checks + ' 项 · 警告 ' + warns + ' 项 · 错误 ' + errors + ' 项');
console.log('='.repeat(44) + '\n');
process.exit(errors ? 1 : 0);
