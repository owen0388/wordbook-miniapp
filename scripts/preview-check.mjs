/**
 * 校验 preview/index.html：把生成的脚本放进模拟浏览器环境，
 * 用真实 DOM 事件路径跑完整流程（首页 → 学习 → 结算）。
 * 运行： node scripts/preview-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'preview', 'index.html');

if (!fs.existsSync(FILE)) {
  console.error('预览文件不存在，请先运行 node scripts/build-preview.mjs');
  process.exit(1);
}
const html = fs.readFileSync(FILE, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const app = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
if (!app || app.length < 1000) {
  console.error('没有从预览文件里找到应用脚本');
  process.exit(1);
}

/* ---------- 模拟浏览器 ---------- */
const store = new Map();
const ls = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear()
};

function baseEl(attrs) {
  return Object.assign({
    innerHTML: '', value: '', disabled: false, style: {},
    onclick: null, oninput: null, onkeydown: null,
    setAttribute() {}, focus() {}
  }, attrs || {});
}

let ids = new Set();
const pwEl = baseEl();
// 注意：必须用 defineProperty，Object.assign 会把访问器求值成普通属性
Object.defineProperty(pwEl, 'innerHTML', {
  configurable: true,
  get() { return this._html || ''; },
  set(v) {
    this._html = String(v);
    ids = new Set([...this._html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  }
});

const optEls = new Map();
function optEl(i) {
  if (!optEls.has(i)) {
    optEls.set(i, baseEl({ getAttribute: (n) => (n === 'data-opt' ? i : '') }));
  }
  return optEls.get(i);
}
function visibleOpts() {
  const out = [];
  for (const m of String(pwEl._html || '').matchAll(/data-opt="(\d+)"/g)) out.push(optEl(m[1]));
  return out;
}

/* 每个 id 必须是独立对象——真实 DOM 里不同元素互不影响，
 * 若全指向同一个对象，后绑定的 onclick 会覆盖前一个，测出假结果。 */
const idEls = new Map();
function elOf(id) {
  if (!idEls.has(id)) {
    const el = baseEl();
    Object.defineProperty(el, 'innerHTML', {
      configurable: true,
      get() { return this._html || ''; },
      set(v) { this._html = String(v); }
    });
    idEls.set(id, el);
  }
  return idEls.get(id);
}

const doc = {
  getElementById: (id) => (id === 'pw' ? pwEl : (ids.has(id) ? elOf(id) : null)),
  querySelectorAll: (sel) => (sel === '[data-opt]' ? visibleOpts() : []),
  querySelector: () => null
};

/* iOS 音频上下文 mock：只记录频率调用，用来验证"音效真的在合成"，
 * 不验证听感——听感只能靠人耳。 */
const freqs = [];
function FakeOsc() {
  this.type = '';
  this.frequency = { setValueAtTime: (f) => { freqs.push(f); } };
  this.connect = () => {};
  this.start = () => {};
  this.stop = () => {};
}
function FakeGain() {
  this.gain = { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
  this.connect = () => {};
}
function FakeAudioContext() {
  this.currentTime = 0;
  this.state = 'running';
  this.destination = {};
  this.createOscillator = () => new FakeOsc();
  this.createGain = () => new FakeGain();
  this.resume = () => {};
}

/* 语音合成 mock：只记录"读了什么"，用来验证自动朗读不会把同一个词读成复读机 */
const spoken = [];
function FakeUtterance(text) { this.text = String(text); }
const fakeSpeech = {
  cancel() {},
  speak(u) { spoken.push(u.text); },
  getVoices() { return []; }
};

const sandbox = vm.createContext({
  document: doc,
  localStorage: ls,
  console,
  setTimeout,
  clearTimeout,
  AudioContext: FakeAudioContext,
  speechSynthesis: fakeSpeech,
  SpeechSynthesisUtterance: FakeUtterance
});
sandbox.window = sandbox; // 与浏览器一致：window 就是全局对象

vm.runInContext(
  app + '\n;__probe = { state: state, start: startSession, submit: submit, advance: advance, sfxCorrect: sfxCorrect, sfxWrong: sfxWrong, speak: speak, speakOnce: speakOnce };',
  sandbox
);
const P = sandbox.__probe;
const S = P.state;
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const rendered = () => String(pwEl._html || '');

/* ---------- 1. 初始化 ---------- */
console.log('\n1. 页面初始化');
check('脚本可执行，三个服务全部加载成功', typeof S === 'object');
check('首页已渲染', rendered().length > 200, '长度 ' + rendered().length);
check('初始屏幕为首页', S.screen === 'home');
check('空书架时给出引导', rendered().indexOf('一键添加教材') >= 0);

/* ---------- 2. 点击「一键添加教材」 ---------- */
console.log('\n2. 添加教材（走真实按钮点击）');
const setupBtn = doc.getElementById('setup');
check('找得到按钮节点', !!setupBtn);
setupBtn.onclick();
check('书架上已有教材', rendered().indexOf('主学教材') >= 0);
check('剩余名额来自计划设置', rendered().indexOf('8</b>') >= 0, '片段：' + rendered().slice(0, 120));
check('首页有自动朗读开关', rendered().indexOf('id="autospeak"') >= 0);

/* ---------- 3. 点击开始学习 ---------- */
console.log('\n3. 学习会话（点选项 / 填输入框，全部作答正确）');
doc.getElementById('start').onclick();
check('进入会话屏幕', S.screen === 'session');
check('进入学习页带推入转场（enter-right）', rendered().indexOf('enter-right') >= 0,
  rendered().slice(0, 80));
check('队列非空', S.queue.length > 0, '队列 ' + S.queue.length);

let guard = 0, sawCard = false, sawChoice = false, sawInput = false;
let spkOnEn = false, leakOnSpell = false, leakOnCn2en = false;
while (S.screen === 'session' && guard++ < 1200) {
  const it = S.cur;
  if (!it) break;

  // 发音按钮只应出现在"题面是英文"的题上；拼写/中译英题面是中文，出现喇叭就等于泄题
  const hasSpk = rendered().indexOf('id="spk"') >= 0;
  if (it.mode === 'card' || it.mode === 'en2cn' || it.mode === 'choice') {
    if (hasSpk) spkOnEn = true;
  } else if (it.mode === 'spell' && hasSpk) {
    leakOnSpell = true;
  } else if (it.mode === 'cn2en' && hasSpk) {
    leakOnCn2en = true;
  }

  if (it.mode === 'card') {
    sawCard = true;
    doc.getElementById('gotit').onclick();
    continue;
  }
  if (S.feedback) { doc.getElementById('next').onclick(); continue; }

  if (it.mode === 'choice') {
    sawChoice = true;
    const idx = it.options.indexOf(it.word.meaningCn);
    doc.querySelectorAll('[data-opt]')[idx].onclick();
  } else {
    sawInput = true;
    const inp = doc.getElementById('ans');
    inp.value = it.mode === 'en2cn' ? it.word.meaningCn.split(/[；;，,、/]/)[0] : it.word.word;
    inp.oninput();
    doc.getElementById('submit').onclick();
  }
}
check('流程正常结束', S.screen === 'result', '屏幕 ' + S.screen + '，第 ' + guard + ' 步');
check('出现过学习卡', sawCard);
check('出现过词义选择题', sawChoice);
check('出现过输入题（拼写/英译中/中译英）', sawInput);
check('英文题面出现朗读按钮', spkOnEn === true);
check('拼写题不出现朗读按钮（防泄题）', leakOnSpell === false);
check('中译英题不出现朗读按钮（防泄题）', leakOnCn2en === false);

/* ---------- 4. 结算 ---------- */
console.log('\n4. 结算页');
const r = S.result;
check('有结算结果', !!r);
check('新学词数 > 0', r && r.newPassed > 0, r ? 'newPassed=' + r.newPassed : '');
check('全程答对则无错词', r && r.wrong.length === 0, r ? '错词 ' + r.wrong.length : '');
check('结算页渲染成功', rendered().indexOf('今日完成') >= 0);
check('结算页带浮起转场（enter-up）', rendered().indexOf('enter-up') >= 0,
  rendered().slice(0, 80));
check('记录了用时', r && r.durationSec >= 1);

/* ---------- 5. 答错路径 ---------- */
console.log('\n5. 答错路径');
doc.getElementById('home').onclick();
check('回到首页', S.screen === 'home');
if (doc.getElementById('start')) {
  doc.getElementById('start').onclick();
} else {
  P.start(false);
}
guard = 0;
while (S.screen === 'session' && guard++ < 1500) {
  const it = S.cur;
  if (!it) break;
  if (it.mode === 'card') { doc.getElementById('gotit').onclick(); continue; }
  if (S.feedback) { doc.getElementById('next').onclick(); continue; }
  if (it.mode === 'choice') {
    const opts = doc.querySelectorAll('[data-opt]');
    const wrongIdx = it.options.findIndex((o) => o !== it.word.meaningCn);
    opts[wrongIdx].onclick();
  } else {
    const inp = doc.getElementById('ans');
    inp.value = it.mode === 'en2cn' ? '肯定不对的答案' : 'zzzz';
    inp.oninput();
    doc.getElementById('submit').onclick();
  }
}
check('答错后仍能走到结算', S.screen === 'result', '屏幕 ' + S.screen);
check('错词被记录', S.result && S.result.wrong.length > 0, S.result ? '错词 ' + S.result.wrong.length : '');
check('答错的题回到队尾重来（总题数增加）', S.queue.length > S.result.wrong.length,
  '队列 ' + S.queue.length + ' / 错词 ' + (S.result ? S.result.wrong.length : '-'));
check('结算页出现错词区', rendered().indexOf('本轮错词') >= 0);

/* ---------- 6. 本地存储 ---------- */
console.log('\n6. 本地存储');
const keys = [...store.keys()];
check('键带 wb_ 前缀', keys.some((k) => k.indexOf('wb_') === 0));
check('进度已落盘 wb_progress', keys.indexOf('wb_progress') >= 0);
check('日志已落盘 wb_daily_log', keys.indexOf('wb_daily_log') >= 0);
check('错词本已落盘 wb_wrong_book', keys.indexOf('wb_wrong_book') >= 0);
check('书架已落盘 wb_bookshelf', keys.indexOf('wb_bookshelf') >= 0);
check('刷新后数据仍在（localStorage 未清空）', JSON.parse(store.get('wb_bookshelf')).length >= 1);

/* ---------- 7. 音效合成 ---------- */
console.log('\n7. 音效合成（Web Audio）');
S.sfxOn = true;
freqs.length = 0;
P.sfxCorrect();
check('答对合成 3 个音', freqs.length === 3, '实际 ' + freqs.length);
check('答对音为上行（音高递增）', freqs.length === 3 && freqs[0] < freqs[1] && freqs[1] < freqs[2],
  freqs.join(' → '));

freqs.length = 0;
P.sfxWrong();
check('答错只合成 2 个音（更短更轻）', freqs.length === 2, '实际 ' + freqs.length);
check('答错音为下行（不刺耳）', freqs.length === 2 && freqs[0] > freqs[1], freqs.join(' → '));
check('答错音整体低于答对音', freqs[0] < 400, '最高 ' + freqs[0]);

S.sfxOn = false;
freqs.length = 0;
P.sfxCorrect();
check('关闭音效后不再合成', freqs.length === 0, '仍合成了 ' + freqs.length + ' 个');
S.sfxOn = true;

/* ---------- 8. 朗读去重 ---------- */
console.log('\n8. 朗读去重（同一个词不读成复读机）');
spoken.length = 0;
P.speakOnce('w_demo_1', 'apple');
P.speakOnce('w_demo_1', 'apple');
P.speakOnce('w_demo_1', 'apple');
check('同一个词连出多题只朗读一次', spoken.length === 1, '实际读了 ' + spoken.length + ' 次');
P.speakOnce('w_demo_2', 'book');
check('换成新词会重新朗读', spoken.length === 2, '实际读了 ' + spoken.length + ' 次');

spoken.length = 0;
P.speak('apple');
P.speak('apple');
check('手动点喇叭不受去重限制', spoken.length === 2, '实际读了 ' + spoken.length + ' 次');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
