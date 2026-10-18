/**
 * 生成单词发音试听页：preview/audition.html
 *
 * 用途：不装微信开发者工具、不上真机，双击就能连听几百个单词的真实发音，
 *      用来判断音质和语速是否合适。
 * 运行：node scripts/build-audition.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const bundle = require(path.join(ROOT, 'assets/dict/bundle.js'));
const manifest = require(path.join(ROOT, 'assets/audio/manifest.js'));

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const audioName = (w) => String(w || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// bundle.textbooks 是数组，转成 id → meta 便于查
const books = {};
(bundle.textbooks || []).forEach((b) => { if (b && b.id) books[b.id] = b; });

const bookIds = Object.keys(books).filter((id) => (manifest[id] || []).length);
bookIds.sort((a, b) => {
  const ga = books[a].grade || 0;
  const gb = books[b].grade || 0;
  if (ga !== gb) return ga - gb;
  return String(books[a].term || '').localeCompare(String(books[b].term || ''));
});

let tabs = '';
let panels = '';
let total = 0;

bookIds.forEach((id, i) => {
  const meta = books[id] || {};
  const words = bundle.words[id] || [];
  const set = new Set(manifest[id] || []);
  const rows = words.filter((w) => set.has(w.word));

  tabs += `<button class="tab${i === 0 ? ' on' : ''}" data-tab="${id}">${esc(meta.name || id)}<em>${rows.length}</em></button>`;

  let list = '';
  rows.forEach((w) => {
    const src = `../assets/audio/${id}/${audioName(w.word)}.mp3`;
    list += `<button class="item" data-src="${esc(src)}" data-word="${esc(w.word)}">`
         +  `<span class="w">${esc(w.word)}</span>`
         +  `<span class="p">${esc(w.phonetic || '')}</span>`
         +  `<span class="m">${esc(w.meaningCn)}</span>`
         +  `</button>`;
    total++;
  });

  panels += `<div class="panel${i === 0 ? ' on' : ''}" id="panel-${id}">${list}</div>`;
});

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>单词发音试听</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#F3F5F9;color:#1A2233;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:0 0 90px}
.hd{background:#1B3A6B;color:#fff;padding:18px 18px 16px;position:sticky;top:0;z-index:10}
.hd h1{margin:0;font-size:17px;font-weight:600}
.hd p{margin:5px 0 0;font-size:12px;color:#B9C9E4;line-height:1.6}
.tabs{display:flex;gap:6px;overflow-x:auto;padding:12px 14px 4px;background:#F3F5F9}
.tab{flex:0 0 auto;border:1px solid #DDE3EC;background:#fff;color:#5B657A;border-radius:8px;padding:7px 11px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.tab em{font-style:normal;color:#9AA1AC;margin-left:5px;font-size:11px}
.tab.on{background:#2E6BD6;border-color:#2E6BD6;color:#fff}
.tab.on em{color:#CFE0FA}
.panel{display:none;padding:10px 14px}
.panel.on{display:block}
.item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#fff;border:1px solid #E8ECF2;border-radius:10px;padding:11px 13px;margin-bottom:7px;cursor:pointer;font-family:inherit}
.item:hover{border-color:#2E6BD6;background:#F5F9FF}
.item.playing{border-color:#2E6BD6;background:#E6F0FC}
.w{font-size:16px;font-weight:600;color:#1B3A6B;min-width:104px}
.p{font-size:12px;color:#8A9099;min-width:104px}
.m{font-size:12px;color:#5B657A;flex:1}
.bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #E1E7F0;padding:10px 14px;display:flex;align-items:center;gap:12px}
.bar audio{flex:1;height:36px}
.bar .now{font-size:12px;color:#5B657A;min-width:90px;text-align:right}
.tip{padding:10px 16px;font-size:11px;color:#9AA1AC;line-height:1.7}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd">
    <h1>单词发音试听</h1>
    <p>共 ${total} 个词的预生成音频 · 微软神经语音 en-US-AriaNeural · 语速比常速慢 15%<br>
       点任意单词即可试听，这是小程序里实际会播放的同一份文件。</p>
  </div>
  <div class="tabs">${tabs}</div>
  ${panels}
  <div class="tip">音质说明：单声道 24kHz / 32kbps，已去掉首尾静音，平均每个词约 2.5KB。
    这个码率能保住 /s/ /θ/ /f/ 这类辅音的高频，适合跟读；如需更接近真人，可提高码率，代价是包体积变大。</div>
</div>
<div class="bar">
  <audio id="player" controls preload="none"></audio>
  <div class="now" id="now">未选择</div>
</div>
<script>
var player = document.getElementById('player');
var now = document.getElementById('now');
var cur = null, items = document.querySelectorAll('.item');

document.querySelectorAll('.tab').forEach(function(t){
  t.onclick = function(){
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.remove('on'); });
    document.querySelectorAll('.panel').forEach(function(x){ x.classList.remove('on'); });
    t.classList.add('on');
    document.getElementById('panel-' + t.getAttribute('data-tab')).classList.add('on');
  };
});

function play(el){
  items.forEach(function(x){ x.classList.remove('playing'); });
  el.classList.add('playing');
  cur = el;
  player.src = el.getAttribute('data-src');
  now.textContent = el.getAttribute('data-word');
  player.play().catch(function(){ now.textContent = '播放失败'; });
}

items.forEach(function(el){ el.onclick = function(){ play(el); }; });

// 连续播放：一个结束自动跳下一个，方便快速过一遍
player.addEventListener('ended', function(){
  if (!cur) return;
  var next = cur.nextElementSibling;
  if (next && next.classList.contains('item')) play(next);
});

// 键盘：上下切换
document.addEventListener('keydown', function(e){
  if (!cur) return;
  if (e.key === 'ArrowDown') { var n = cur.nextElementSibling; if (n) { e.preventDefault(); play(n); } }
  if (e.key === 'ArrowUp') { var p = cur.previousElementSibling; if (p) { e.preventDefault(); play(p); } }
});
</script>
</body>
</html>
`;

const out = path.join(ROOT, 'preview', 'audition.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log('已生成：' + path.relative(ROOT, out));
console.log('教材 ' + bookIds.length + ' 本 · 可试听 ' + total + ' 个词');
