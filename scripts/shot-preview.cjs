/**
 * 把预览版复制成若干"自动走到某状态"的副本，再用 Chrome 无头截图。
 * 仅用于开发期看视觉，不进入交付产物。
 * 运行： node scripts/shot-preview.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'preview', 'index.html');
const TMP = path.resolve(ROOT, '..', '.workbuddy', 'tmp', 'shots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!fs.existsSync(SRC)) {
  console.error('请先运行 node scripts/build-preview.mjs');
  process.exit(1);
}
fs.mkdirSync(TMP, { recursive: true });
const base = fs.readFileSync(SRC, 'utf8');

const HELPERS = `
document.documentElement.classList.add('no-anim');
function until(pred, max){
  var g = 0;
  while (state.cur && !pred(state.cur) && g++ < 400) advance();
}
function pickOption(right){
  var opts = document.querySelectorAll('[data-opt]');
  var it = state.cur;
  var i = right
    ? it.options.indexOf(it.word.meaningCn)
    : it.options.findIndex(function(o){ return o !== it.word.meaningCn; });
  if (opts[i]) opts[i].click();
}
`;

const scenes = {
  'demo-card': `
    document.getElementById('setup').click();
    startSession(false);
  `,
  'demo-choice': `
    document.getElementById('setup').click();
    startSession(false);
    until(function(it){ return it.mode === 'choice'; });
  `,
  'demo-ok': `
    document.getElementById('setup').click();
    startSession(false);
    until(function(it){ return it.mode === 'choice'; });
    pickOption(true);
  `,
  'demo-bad': `
    document.getElementById('setup').click();
    startSession(false);
    until(function(it){ return it.mode === 'choice'; });
    pickOption(false);
  `,
  'demo-input': `
    document.getElementById('setup').click();
    startSession(false);
    until(function(it){ return it.mode === 'spell' || it.mode === 'cn2en'; });
  `,
  'demo-home': `
    document.getElementById('setup').click();
    state.screen = 'home'; state.cur = null; render();
  `,
  'demo-result': `
    document.getElementById('setup').click();
    startSession(false);
    var g = 0;
    while (state.screen === 'session' && g++ < 400){
      var it = state.cur;
      if (!it) break;
      if (it.mode === 'card'){ advance(); continue; }
      if (state.feedback){ advance(); continue; }
      if (it.mode === 'choice'){ pickOption(true); continue; }
      var inp = document.getElementById('ans');
      inp.value = it.mode === 'en2cn' ? it.word.meaningCn.split(/[；;，,、/]/)[0] : it.word.word;
      inp.oninput();
      document.getElementById('submit').click();
    }
  `
};

let ok = 0;
Object.keys(scenes).forEach((name) => {
  const inject = `<script>window.addEventListener('load',function(){try{${HELPERS}${scenes[name]}}catch(e){document.title='ERR:'+e.message;console.log('ERR',e.message)}});</script>`;
  const html = base.replace('</body>', inject + '\n</body>');
  const file = path.join(TMP, name + '.html');
  fs.writeFileSync(file, html);

  const png = path.join(TMP, name + '.png');
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--virtual-time-budget=3000', '--window-size=1240,860',
      '--screenshot=' + png,
      'file:///' + file.replace(/\\/g, '/')
    ], { stdio: 'ignore' });
    console.log('✓ ' + name + '.png');
    ok++;
  } catch (e) {
    console.log('✗ ' + name + ' —— ' + e.message);
  }
});
console.log('\n共 ' + ok + ' 张，目录：' + TMP);
