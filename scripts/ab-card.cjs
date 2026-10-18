/* 定位卡片外围那圈淡色矩形的来源：逐个屏蔽候选规则再截图对比 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'preview', 'index.html');
const TMP = path.resolve(ROOT, '..', '.workbuddy', 'tmp');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const html = fs.readFileSync(SRC, 'utf8');

/* 复用 shot-preview 的"自动走到学习卡"注入方式：直接点按钮 */
const DRIVE = `
<script>
window.addEventListener('load', function(){
  function q(id){ return document.getElementById(id); }
  var el = q('setup'); if (el) el.click();
  el = q('start'); if (el) el.click();
  document.documentElement.classList.add('no-anim');
  var guard = 0;
  while (guard++ < 40) {
    var s = window.__probe && window.__probe.state;
    if (!s) break;
    if (s.cur && s.cur.mode === 'card') break;
    var g = q('gotit'); if (!g) break; g.click();
  }
});
</script>
`;

const VARIANTS = {
  base: '',
  noCardShadow: '.card{box-shadow:none!important}',
  noCardAfter: '.card::after{display:none!important}',
  noWatermark: '.card-word::before{display:none!important}',
  noPwAfter: '.pw::after{display:none!important}',
};

fs.mkdirSync(path.join(TMP, 'ab'), { recursive: true });

Object.entries(VARIANTS).forEach(([name, css]) => {
  const out = html
    .replace('</head>', `<style>${css}</style></head>`)
    .replace('</body>', DRIVE + '</body>');
  const file = path.join(TMP, 'ab', name + '.html');
  fs.writeFileSync(file, out, 'utf8');
  const shot = path.join(TMP, 'shots', 'ab-' + name + '.png');
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--virtual-time-budget=2200', '--window-size=1240,860',
    '--screenshot=' + shot, 'file:///' + file.replace(/\\/g, '/')
  ], { stdio: 'ignore' });
  console.log('✓ ab-' + name + '.png');
});
