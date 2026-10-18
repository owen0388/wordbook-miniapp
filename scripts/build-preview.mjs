/**
 * 生成浏览器预览版 preview/index.html
 *
 * 目的：不装微信开发者工具也能看到界面和完整流程。
 * 做法：把小程序里真实的 services/ 与 utils/ 源码 + 词库产物
 *       打进一个自包含 HTML，用 localStorage 顶替 wx.Storage。
 *       逻辑走的是同一套代码，不是重写的仿制品。
 *
 * 运行： node scripts/build-preview.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'preview');
const OUT_FILE = path.join(OUT_DIR, 'index.html');

const MODULE_FILES = [
  'utils/date.js',
  'utils/storage.js',
  'services/dict.js',
  'services/user.js',
  'services/fsrs.js',
  'services/srs.js',
  'assets/dict/bundle.js'
];

/* ---------- 1. 读取并校验源码 ---------- */
const modules = {};
MODULE_FILES.forEach((rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error('缺少文件：' + rel);
    process.exit(1);
  }
  const src = fs.readFileSync(abs, 'utf8');
  // 只做语法校验，不执行
  try {
    new Function('require', 'module', 'exports', src);
  } catch (e) {
    console.error('语法错误 ' + rel + ' -> ' + e.message);
    process.exit(1);
  }
  modules[rel.replace(/\.js$/, '')] = src;
});

// bundle.js 是 CommonJS 产物，直接执行它拿对象（自产文件，安全）
const bundle = new Function(
  'module',
  fs.readFileSync(path.join(ROOT, 'assets/dict/bundle.js'), 'utf8') + '\nreturn module.exports;'
)({ exports: {} });

const MODULES_JSON = JSON.stringify(modules).replace(/<\//g, '<\\/');

const bookList = (bundle.textbooks || [])
  .map((t) => t.name + '（' + (t.wordCount || 0) + ' 词）')
  .join('、');

/* ---------- 2. 样式 ----------
 * 设计方向：玩趣玩具（糖果手账）
 *   主色 深靛蓝 #27386E（学院感，家长放心）
 *   强调 珊瑚橙 #FF6B3D（唯一强调色，只留给关键动作与正向反馈）
 *   底色 温暖米白 #F8F3E9（不用冷灰，避免"后台系统"味）
 * 展示字：Baloo 2 ExtraBold（圆胖卡通体，笔画带弧度，内联 base64，零网络依赖）
 * 正文字：系统中文字体栈（中文 webfont 体积不划算，用字重与字距建立层次）
 * 记忆点：立体按压按钮 + 答对时糖果点爆开
 */
const FONT_FILE = path.join(ROOT, 'assets', 'fonts', 'baloo2-800.woff2');
let FONT_FACE = '';
try {
  const b64 = fs.readFileSync(FONT_FILE).toString('base64');
  FONT_FACE = `@font-face{font-family:'WBDisplay';src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:400 900;font-style:normal;font-display:swap}`;
} catch (e) {
  console.warn('未找到 assets/fonts/baloo2-800.woff2，展示字体将降级为系统字体');
}

const CSS = `
${FONT_FACE}
:root{
  --ink:#1C2333; --ink-2:#5A6377; --ink-3:#6E7789;
  --paper:#F8F3E9; --paper-2:#FCFAF5; --surface:#FFFFFF;
  --line:#E6DCCB; --line-2:#F0E9DC;
  --brand:#27386E; --brand-2:#19264D; --brand-3:#3A4F8C; --brand-soft:#E9EDF9;
  --accent:#FF6B3D; --accent-ink:#3B1608; --accent-soft:#FFEDE4;
  --ok:#0C9A6C; --ok-2:#06714F; --ok-soft:#DEF6EC;
  --bad:#D8474A; --bad-2:#A93236; --bad-soft:#FBEAEA;
  --gold:#FFC24B;
  --r-lg:22px; --r-md:15px; --r-sm:10px;
  --ease:cubic-bezier(.16,1,.3,1);
  --spring:cubic-bezier(.34,1.56,.64,1);
  --font-display:'WBDisplay','Segoe UI','PingFang SC',sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:var(--font-display);
  background:var(--paper);color:var(--ink);line-height:1.55;padding:24px;
  -webkit-font-smoothing:antialiased;
}
/* 氛围层：暖色渐变网格 + 极轻噪点，替代纯色平铺 */
body::before{
  content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(46rem 32rem at 6% -8%,rgba(255,107,61,.17),transparent 62%),
    radial-gradient(44rem 30rem at 104% 2%,rgba(39,56,110,.15),transparent 58%),
    radial-gradient(38rem 28rem at 52% 110%,rgba(76,205,196,.12),transparent 62%);
}
body::after{
  content:'';position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.04;mix-blend-mode:multiply;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
}
.wrap{position:relative;z-index:1;display:flex;gap:32px;justify-content:center;align-items:flex-start;flex-wrap:wrap}

/* ---------- 侧栏 ---------- */
.side{width:300px;flex:none;padding-top:8px;display:flex;flex-direction:column;gap:15px}
.side .brand{display:flex;align-items:center;gap:11px}
.side .logo{
  width:42px;height:42px;border-radius:13px;flex:none;display:grid;place-items:center;
  background:linear-gradient(150deg,#FF8A5C,#F2542A);
  box-shadow:0 4px 0 #C7431C,0 10px 20px -8px rgba(242,84,42,.7);
  font-family:var(--font-display);font-size:20px;color:#fff;font-weight:600;
  transform:rotate(-4deg);
}
.side h1{font-size:17px;font-weight:700;letter-spacing:-.01em}
.side .sub{font-size:12px;color:var(--ink-3);margin-top:1px;letter-spacing:.04em}
.side p{font-size:13px;color:var(--ink-2);line-height:1.75}
.side .note{
  font-size:12px;color:var(--ink-2);background:rgba(255,255,255,.78);border:1px solid var(--line-2);
  border-radius:var(--r-md);padding:13px 14px;line-height:1.85;
  box-shadow:0 1px 2px rgba(26,39,80,.04),0 10px 30px -22px rgba(26,39,80,.5);
}
.side .note b{font-weight:600;color:var(--ink);display:block;margin-bottom:8px;letter-spacing:.02em}
.side .note ul{list-style:none;padding:0;margin:0}
.side .note li{position:relative;padding-left:14px;line-height:1.8}
.side .note li+li{margin-top:3px}
.side .note li::before{
  content:'';position:absolute;left:2px;top:.72em;width:5px;height:5px;border-radius:50%;
  background:var(--accent);opacity:.65;
}
.side .note code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:11px;background:var(--accent-soft);color:#B8410F;padding:1px 5px;border-radius:4px}
.side .ctl{display:flex;gap:8px;flex-wrap:wrap}
.side .ctl .btn{width:auto;flex:1;min-width:0;white-space:nowrap}

/* ---------- 机身 ---------- */
.pw{
  position:relative;width:375px;height:734px;flex:none;
  display:flex;flex-direction:column;min-height:0;overflow:hidden;
  background:linear-gradient(178deg,#FFFDF8 0%,var(--paper-2) 42%,#F6F1E6 100%);border-radius:40px;
  box-shadow:
    0 0 0 1px rgba(26,39,80,.10),
    0 0 0 8px #FDFCF9,
    0 0 0 9px rgba(26,39,80,.07),
    0 34px 68px -26px rgba(26,39,80,.46),
    0 8px 18px -8px rgba(26,39,80,.14);
}
.phone{display:none}
.screen{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}

/* ---------- 顶部 ---------- */
.hd{
  position:relative;flex:none;overflow:hidden;color:#fff;
  padding:20px 20px 19px;
  background:
    radial-gradient(90% 150% at 0% 0%,#40569C 0%,rgba(64,86,156,0) 56%),
    linear-gradient(158deg,#2D4079 0%,#19264D 100%);
}
.hd::after{
  content:'';position:absolute;width:200px;height:200px;right:-64px;top:-104px;border-radius:50%;
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 0 0 24px rgba(255,255,255,.045),0 0 0 52px rgba(255,255,255,.028);
  pointer-events:none;animation:drift 11s ease-in-out infinite alternate;
}
.hd .d{position:relative;font-size:12px;opacity:.7;letter-spacing:.06em}
.hd .t{position:relative;font-size:21px;font-weight:700;letter-spacing:-.01em;margin-top:3px}
.hd .bar{
  position:relative;height:6px;background:rgba(255,255,255,.16);border-radius:99px;
  overflow:hidden;margin-top:15px;
}
.hd .bar i{
  position:relative;display:block;height:100%;border-radius:99px;overflow:hidden;
  background:linear-gradient(90deg,#FFB03A,#FF6B3D);
  box-shadow:0 0 14px rgba(255,107,61,.85);
  transition:width .55s var(--ease);
}
/* 一道白光顺着进度条走，让"今天的进度"看起来是活的 */
.hd .bar i::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent);
  animation:flow 2.4s linear infinite;
}
.hd .meta{position:relative;display:flex;justify-content:space-between;font-size:12px;opacity:.82;margin-top:8px;letter-spacing:.02em}
.hd .meta-top{margin-top:0;font-size:13.5px;font-weight:700;opacity:.95;letter-spacing:.01em}

/* ---------- 主体 ---------- */
.bd{flex:1;overflow-y:auto;padding:15px;background:transparent;position:relative;z-index:1;-webkit-overflow-scrolling:touch}
.bd::-webkit-scrollbar{width:0}
.card{
  position:relative;background:var(--surface);border-radius:var(--r-lg);padding:16px 18px;
  margin-bottom:12px;border:1px solid var(--line-2);
  box-shadow:0 1px 2px rgba(26,39,80,.04),0 10px 28px -20px rgba(26,39,80,.34);
}
/* 新词卡：超大首字母水印。新词卡只有拼写/音标/释义三条信息，
 * 加一层极淡的字形水印，卡片才不显得空。 */
.card-word{overflow:hidden}
.card-word::before{
  content:attr(data-letter);
  position:absolute;right:4px;bottom:-24px;
  font-family:var(--font-display);font-size:158px;line-height:1;
  color:rgba(39,56,110,.05);pointer-events:none;user-select:none;
}

/* 一次编排好的入场序列：错峰上浮，同题内重绘不重播 */
.screen > .bd > .card{animation:riseIn .52s var(--ease) both}
.screen > .bd > .card:nth-child(2){animation-delay:.06s}
.screen > .bd > .card:nth-child(3){animation-delay:.12s}
.screen > .bd > .card:nth-child(4){animation-delay:.17s}
.screen.still > .bd > .card{animation:none}
.screen.fb-bad > .bd > .card:first-child{animation:shake .5s var(--ease) both}

/* 换页转场：进学习页从右侧推入，到结算页从下方浮起，回首页淡入 */
.screen.enter-right{animation:slideInRight .5s var(--ease) both}
.screen.enter-up{animation:slideInUp .58s var(--ease) both}
.screen.enter-fade{animation:fadeIn .34s var(--ease) both}
/* 整屏已经在动，卡片就不必再各自错峰——两层位移叠加会晕 */
.screen.enter-right > .bd > .card,
.screen.enter-up > .bd > .card,
.screen.enter-fade > .bd > .card{animation:none}

.row{display:flex;justify-content:space-between;align-items:center;gap:14px;font-size:13px;padding:7px 0;color:var(--ink-2)}
.row+.row{border-top:1px solid var(--line-2)}
.row b{font-weight:600;color:var(--ink);text-align:right}

/* 首页 KPI */
.hero{display:flex;gap:10px;align-items:center}
.hero .n{flex:1;text-align:center;min-width:0}
.hero .n b{
  display:block;font-family:var(--font-display);font-size:34px;font-weight:600;
  line-height:1.05;color:var(--brand);font-variant-numeric:tabular-nums;
  animation:numIn .6s var(--spring) both;
}
.hero .n span{font-size:11.5px;color:var(--ink-3);letter-spacing:.05em}
.hero .v{width:1px;height:36px;background:var(--line-2);flex:none}

/* ---------- 按钮（立体按压） ---------- */
.btn{
  position:relative;display:block;width:100%;border:0;border-radius:16px;
  padding:15px;font-size:16px;font-family:inherit;font-weight:600;letter-spacing:.02em;
  color:var(--accent-ink);cursor:pointer;overflow:hidden;
  background:linear-gradient(180deg,#FF8558 0%,#FF6B3D 58%,#F5582A 100%);
  box-shadow:0 4px 0 #C7431C,0 12px 24px -10px rgba(242,84,42,.75);
  transition:transform .13s var(--ease),box-shadow .13s var(--ease),filter .13s;
  -webkit-tap-highlight-color:transparent;
}
.btn::after{
  content:'';position:absolute;left:1px;right:1px;top:1px;height:50%;
  border-radius:15px 15px 46% 46%/15px 15px 34% 34%;
  background:linear-gradient(180deg,rgba(255,255,255,.42),rgba(255,255,255,0));
  pointer-events:none;
}
.btn:hover{transform:translateY(-1px);box-shadow:0 5px 0 #C7431C,0 16px 28px -10px rgba(242,84,42,.82)}
.btn:active{transform:translateY(4px);box-shadow:0 0 0 #C7431C,0 4px 10px -4px rgba(242,84,42,.5);filter:brightness(.97)}
.btn:focus-visible{outline:2px solid var(--brand-3);outline-offset:3px}
.btn.ghost{
  background:#fff;color:var(--brand);border:1.5px solid #D5DEEC;
  box-shadow:0 3px 0 #E4EAF4,0 10px 20px -14px rgba(39,56,110,.4);
}
.btn.ghost::after{display:none}
.btn.ghost:hover{background:#F6F9FF;border-color:#B9C8E3;box-shadow:0 3px 0 #E4EAF4,0 12px 22px -14px rgba(39,56,110,.5)}
.btn.ghost:active{transform:translateY(3px);box-shadow:0 0 0 #E4EAF4}
.btn.sm{padding:11px 14px;font-size:13.5px;border-radius:13px}
.btn[disabled]{
  background:linear-gradient(180deg,#DCE1EA,#CBD2DF);color:#8B93A3;
  box-shadow:0 4px 0 #B5BDCB;cursor:default;transform:none;filter:none;
}
.btn[disabled]::after{opacity:.4}
.stack{margin-top:12px;display:flex;flex-direction:column;gap:9px}

/* 点击涟漪：从按下的位置扩散，按完自动移除。
 * 颜色按底色区分——实心橙按钮上走白光，白底按钮上走主色，否则看不见。 */
.ripple{
  position:absolute;border-radius:50%;pointer-events:none;z-index:2;
  background:radial-gradient(circle, rgba(255,255,255,.82), rgba(255,255,255,0) 62%);
  transform:scale(0);opacity:.9;
  animation:rippleOut .6s var(--ease) forwards;
}
.btn.ghost .ripple{
  background:radial-gradient(circle, rgba(39,56,110,.3), rgba(39,56,110,0) 64%);
}
.opt .ripple{
  background:radial-gradient(circle, rgba(39,56,110,.2), rgba(39,56,110,0) 64%);
}

/* ---------- 单词展示 ---------- */
.word-en{
  display:flex;align-items:center;justify-content:center;gap:12px;
  font-family:var(--font-display);font-size:40px;font-weight:600;
  line-height:1.12;color:var(--brand);letter-spacing:.005em;
  word-break:break-word;
}
.spk{
  flex:0 0 auto;width:38px;height:38px;padding:0;border:0;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;
  font-size:15px;line-height:1;cursor:pointer;color:var(--brand-3);
  background:linear-gradient(180deg,#F2F6FF,#E3EAF9);
  box-shadow:0 2px 0 #CBD6EC,0 3px 8px -4px rgba(39,56,110,.28);
  transition:transform .12s var(--spring),box-shadow .12s;
}
.spk:hover{transform:translateY(-1px) scale(1.05);box-shadow:0 3px 0 #CBD6EC,0 6px 12px -5px rgba(39,56,110,.34)}
.spk:active{transform:translateY(2px) scale(.95);box-shadow:0 0 0 #C9D4EC}
.spk:focus-visible{outline:2px solid var(--brand-3);outline-offset:3px}
.word-ph{text-align:center;color:var(--ink-3);font-size:13.5px;margin-top:8px;letter-spacing:.04em}
.ask{
  text-align:center;color:var(--ink-2);font-size:13px;margin-top:16px;padding-top:15px;
  border-top:1px dashed var(--line);letter-spacing:.02em;
}
.sense{text-align:center;font-size:21px;font-weight:700;color:var(--ink);letter-spacing:.01em;line-height:1.45}
.ex{font-size:12.5px;color:var(--ink-2);text-align:center;margin-top:12px;line-height:1.7}
.ex em{font-style:normal;color:var(--brand);font-weight:600}

/* ---------- 选项 ---------- */
.opt{
  position:relative;width:100%;display:block;text-align:left;font-family:inherit;
  border:1.5px solid var(--line);background:#fff;border-radius:14px;
  padding:14px 16px;font-size:15.5px;margin-bottom:10px;cursor:pointer;color:var(--ink);
  box-shadow:0 2px 0 rgba(26,39,80,.05);overflow:hidden;
  transition:transform .13s var(--ease),border-color .13s,background .13s,box-shadow .13s;
  -webkit-tap-highlight-color:transparent;
}
.opt:hover{border-color:#B4C4E5;background:#F7FAFF;transform:translateY(-1px);box-shadow:0 5px 14px -6px rgba(39,56,110,.28)}
.opt:active{transform:translateY(1px) scale(.995)}
.opt:focus-visible{outline:2px solid var(--brand-3);outline-offset:2px}
.opt.ok{
  border-color:var(--ok);background:var(--ok-soft);color:var(--ok-2);font-weight:600;
  box-shadow:0 2px 0 rgba(12,154,108,.25),0 8px 20px -12px rgba(12,154,108,.6);
  animation:popIn .42s var(--spring) both;
}
.opt.bad{
  border-color:var(--bad);background:var(--bad-soft);color:var(--bad-2);font-weight:600;
  animation:shake .45s var(--ease) both;
}
.opt[disabled]{cursor:default}
.opt[disabled]:hover{transform:none;box-shadow:0 2px 0 rgba(26,39,80,.05)}

/* ---------- 输入 ---------- */
.inp{
  width:100%;border:1.5px solid var(--line);border-radius:14px;padding:14px 16px;
  font-size:18px;font-family:inherit;outline:none;background:#fff;color:var(--ink);
  transition:border-color .18s,box-shadow .18s,background .18s;
}
.inp::placeholder{color:#A9B0BE;font-size:15px}
/* 聚焦用主色而不是强调色：橙色在别处代表"关键动作"，
 * 用在输入框上会被误读成"填错了" */
.inp:focus{border-color:var(--brand-3);box-shadow:0 0 0 4px rgba(39,56,110,.13);background:#fff}
.inp[disabled]{background:#FAFAFB;color:var(--ink-2)}

/* ---------- 答题反馈（记忆点） ---------- */
.fb{
  position:relative;border-radius:14px;padding:14px 16px;font-size:13.5px;margin-top:11px;
  font-weight:500;line-height:1.6;
}
.fb b{font-weight:700}
.fb.ok{
  color:var(--ok-2);border:1.5px solid rgba(12,154,108,.3);
  background:linear-gradient(135deg,#E7FAF2,#DAF5EA);
  box-shadow:0 6px 20px -10px rgba(12,154,108,.5);
  animation:popIn .42s var(--spring) both;
}
/* 糖果点爆开：一颗中心点炸成 7 个彩色圆点 */
.fb.ok::before{
  content:'';position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;
  border-radius:50%;pointer-events:none;
  box-shadow:
    0 -26px 0 -1px var(--gold),22px -16px 0 -1px var(--accent),
    26px 13px 0 -1px #4ECDC4,12px 25px 0 -1px #7BD389,
    -12px 25px 0 -1px var(--gold),-26px 13px 0 -1px #FF9F45,
    -22px -16px 0 -1px #8DA6FF;
  animation:spark .8s var(--ease) both;
}
.fb.bad{
  color:var(--bad-2);border:1.5px solid rgba(216,71,74,.28);
  background:linear-gradient(135deg,#FDEEED,#FBE4E3);
  box-shadow:0 6px 20px -10px rgba(216,71,74,.42);
  animation:shake .5s var(--ease) both;
}
/* 答对时卡片顶部扫过一道光 */
.screen.fb-ok > .bd > .card:first-child::after{
  content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(105deg,transparent 34%,rgba(12,154,108,.16) 50%,transparent 66%);
  background-size:260% 100%;animation:sweep .78s var(--ease) both;
}

/* ---------- 底栏 / 标签栏 ---------- */
.foot{padding:12px 15px 18px;background:var(--surface);border-top:1px solid var(--line-2);flex:none}
.tab{display:flex;background:var(--surface);border-top:1px solid var(--line-2);flex:none;padding:3px 0 6px}
.tab div{
  flex:1;text-align:center;padding:4px 0;font-size:11px;color:var(--ink-3);
  cursor:default;transition:color .18s,transform .18s;letter-spacing:.02em;
}
.tab div::before{display:block;font-size:15px;line-height:1.3;margin-bottom:1px;opacity:.55;transition:opacity .18s,transform .18s}
.tab div:nth-child(1)::before{content:'📅'}
.tab div:nth-child(2)::before{content:'📚'}
.tab div:nth-child(3)::before{content:'🔖'}
.tab div:nth-child(4)::before{content:'🔁'}
.tab div.on::before{opacity:1;transform:scale(1.1)}
.tab div:hover{color:var(--brand-3);transform:translateY(-1px)}
.tab div.on{color:var(--brand);font-weight:700}

.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:var(--brand-soft);color:var(--brand);margin-left:6px;font-weight:500}
.empty{text-align:center;padding:46px 16px;color:var(--ink-3);font-size:13.5px;line-height:2}
.tgl{
  border:1.5px solid var(--line);background:#fff;color:var(--ink-2);border-radius:99px;
  padding:6px 15px;font-size:12.5px;cursor:pointer;font-family:inherit;font-weight:600;
  transition:all .18s var(--ease);
}
.tgl:hover{border-color:#C3CFE6}
.tgl.on{background:var(--ok-soft);border-color:rgba(12,154,108,.42);color:var(--ok-2)}
.hint{font-size:11.5px;color:var(--ink-3);line-height:1.75;margin-top:7px}
.toast{
  position:absolute;left:50%;top:90px;z-index:9;transform:translateX(-50%);
  background:#fff;color:var(--ink);font-size:13px;padding:11px 18px;
  border-radius:12px;pointer-events:none;letter-spacing:.02em;white-space:nowrap;
  border:1px solid var(--line);
  box-shadow:0 12px 32px -10px rgba(26,39,80,.3),0 2px 6px rgba(26,39,80,.06);
  animation:toastIn .34s var(--spring) both;
}
.wrongitem{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:9px 0}
.wrongitem+.wrongitem{border-top:1px solid var(--line-2)}
.wrongitem b{font-weight:600;color:var(--brand);font-family:var(--font-display)}
.wrongitem span{color:var(--ink-2);text-align:right}

/* ---------- 垂直居中：内容少时不要贴着顶部 ---------- */
.bd.center{display:flex;flex-direction:column}
.bd.center > *:first-child{margin-top:auto}
.bd.center > *:last-child{margin-bottom:auto}

/* ---------- 新词标记 ---------- */
.chip{
  display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.14em;
  padding:3px 11px;border-radius:99px;margin-bottom:13px;
  background:linear-gradient(135deg,#FFE3D3,#FFD5C0);color:#B03D0F;
  box-shadow:0 2px 6px -2px rgba(242,84,42,.5);
}
.chip-wrap{text-align:center}

/* ---------- 选项序号 ---------- */
.opt{display:flex;align-items:center;gap:12px}
.opt-i{
  flex:none;width:25px;height:25px;border-radius:8px;display:grid;place-items:center;
  font-size:11.5px;font-weight:700;font-family:var(--font-display);
  background:#DFE6F6;color:var(--brand);
  transition:background .15s var(--ease),color .15s var(--ease),transform .15s var(--spring);
}
.opt:hover .opt-i{transform:scale(1.06)}
.opt-t{flex:1;min-width:0}
/* 选中/答错时，序号徽章"盖章"一下——比整行放大更精致，也不会撑破圆角 */
.opt.ok .opt-i{background:var(--ok);color:#fff;animation:badgePop .5s var(--spring) both}
.opt.bad .opt-i{background:var(--bad);color:#fff;animation:badgePop .45s var(--ease) both}

/* ---------- 结算页庆祝 ---------- */
.done{text-align:center;padding:6px 0 4px}
.done .badge{
  position:relative;width:78px;height:78px;margin:0 auto 14px;border-radius:50%;
  display:grid;place-items:center;color:#fff;
  background:linear-gradient(150deg,#FF9A5E,#F2542A);
  box-shadow:0 6px 0 #C7431C,0 18px 34px -14px rgba(242,84,42,.8);
  animation:badgeIn .7s var(--spring) both;
}
/* 光环默认透明，由动画驱动——否则关掉动效时会剩一个僵住的圆环 */
.done .badge::after{
  content:'';position:absolute;inset:-9px;border-radius:50%;
  border:2px solid rgba(242,84,42,.3);
  opacity:0;animation:halo 2.2s var(--ease) infinite;
}
.done .praise{font-size:19px;font-weight:700;color:var(--ink);letter-spacing:-.01em}
.done .sub{font-size:12.5px;color:var(--ink-3);margin-top:5px;letter-spacing:.04em}

/* ---------- 动效 ---------- */
@keyframes riseIn{from{opacity:0;transform:translateY(16px) scale(.985)}to{opacity:1;transform:none}}
/* opacity 在动画前段就冲到 1，只让缩放带弹性——
 * 否则弹性曲线会让元素长时间处于半透明，看起来像"发虚"而不是"弹出来" */
@keyframes numIn{0%{opacity:0;transform:translateY(8px) scale(.86)}28%{opacity:1}100%{opacity:1;transform:none}}
@keyframes popIn{0%{opacity:0;transform:scale(.9)}22%{opacity:1}62%{transform:scale(1.025)}100%{opacity:1;transform:scale(1)}}
@keyframes badgeIn{0%{opacity:0;transform:scale(.4) rotate(-18deg)}55%{opacity:1;transform:scale(1.07) rotate(3deg)}100%{opacity:1;transform:none}}
@keyframes halo{0%{transform:scale(.9);opacity:.85}70%{transform:scale(1.24);opacity:0}100%{transform:scale(1.24);opacity:0}}
@keyframes shake{
  0%,100%{transform:translateX(0)}
  12%{transform:translateX(-6px)}28%{transform:translateX(5px)}
  44%{transform:translateX(-4px)}60%{transform:translateX(3px)}76%{transform:translateX(-2px)}
}
@keyframes spark{0%{transform:scale(.3);opacity:1}55%{opacity:1}100%{transform:scale(1.45);opacity:0}}
@keyframes sweep{from{background-position:130% 0}to{background-position:-30% 0}}
@keyframes flow{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes drift{to{transform:translate(-10px,13px) scale(1.07)}}
@keyframes toastIn{from{opacity:0;transform:translate(-50%,-8px) scale(.96)}to{opacity:1;transform:translate(-50%,0) scale(1)}}
@keyframes rippleOut{to{transform:scale(1);opacity:0}}
@keyframes badgePop{0%{transform:scale(.55) rotate(-24deg)}62%{transform:scale(1.2) rotate(5deg)}100%{transform:scale(1) rotate(0)}}
@keyframes slideInRight{from{opacity:0;transform:translateX(56px)}to{opacity:1;transform:none}}
@keyframes slideInUp{from{opacity:0;transform:translateY(54px) scale(.965)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}


/* ---------- 氛围层：浮尘粒子 + 荧光 ----------
 * 粒子用平铺径向渐变 + 缓慢位移实现：不引入任何图片或 JS，
 * 只动 transform，滚动时不参与重排；两层不同速度形成前后视差。
 */
.pw::before{
  content:'';position:absolute;inset:0;z-index:0;pointer-events:none;
  background-image:
    radial-gradient(circle,rgba(255,107,61,.55) 0 1.5px,transparent 2px),
    radial-gradient(circle,rgba(39,56,110,.34) 0 1.1px,transparent 1.7px);
  background-size:112px 112px,72px 72px;
  background-position:0 0,34px 46px;
  opacity:.55;
  animation:dustA 34s linear infinite;
}
.pw::after{
  content:'';position:absolute;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(250px 250px at 2% -8%,rgba(255,107,61,.24),transparent 68%),
    radial-gradient(310px 310px at 106% 8%,rgba(86,116,214,.22),transparent 70%),
    radial-gradient(340px 340px at 52% 108%,rgba(78,205,196,.2),transparent 72%);
}
@keyframes dustA{from{transform:translate3d(0,0,0)}to{transform:translate3d(-112px,-112px,0)}}

/* 顶部深色区撒一层"星点"，深底上才看得出颗粒，浅底会脏 */
.hd::before{
  content:'';position:absolute;inset:0;pointer-events:none;
  background-image:
    radial-gradient(circle,rgba(255,255,255,.92) 0 1px,transparent 1.6px),
    radial-gradient(circle,rgba(255,255,255,.55) 0 .9px,transparent 1.4px);
  background-size:66px 66px,40px 40px;
  background-position:0 0,22px 30px;
  opacity:.32;animation:twinkle 7s ease-in-out infinite alternate;
}
@keyframes twinkle{from{opacity:.2}to{opacity:.5}}


/* ---------- 吉祥物 ---------- */
.hd-home{display:flex;align-items:center;gap:12px}
.hd-txt{flex:1}
.mascot{position:relative;width:56px;height:56px;flex:none;animation:mascotBob 3.6s ease-in-out infinite}
@keyframes mascotBob{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-5px) rotate(4deg)}}
.m-ear{position:absolute;top:3px;width:8px;height:8px;border-radius:50%;background:#FF8A5C;opacity:.95}
.m-ear.l{left:13px}
.m-ear.r{left:28px;top:1px;transform:scale(.78)}
.m-body{position:absolute;left:1.5px;right:1.5px;top:6px;bottom:0;border-radius:52% 52% 46% 46%;
  background:linear-gradient(160deg,#FFB47E 0%,#FF6B3D 58%,#E14E28 100%);
  box-shadow:inset 0 -5px 8px rgba(150,40,10,.28),inset 0 3px 5px rgba(255,255,255,.4),0 5px 10px -5px rgba(242,84,42,.75);
  overflow:hidden}
.m-belly{position:absolute;left:24%;right:24%;bottom:5%;height:32%;border-radius:50% 50% 46% 46%;background:linear-gradient(180deg,rgba(255,249,236,.72),rgba(255,236,210,.9))}
.m-eye{position:absolute;top:20%;width:14.5px;height:14.5px;border-radius:50%;background:#FFF9F0;
  display:flex;align-items:center;justify-content:center;box-shadow:inset 0 -1.5px 2.5px rgba(120,60,20,.22)}
.m-eye.l{left:15%}
.m-eye.r{right:15%}
.m-pupil{width:7px;height:7px;border-radius:50%;background:var(--brand);box-shadow:inset 1.5px -1.5px 0 rgba(255,255,255,.55)}
.m-beak{position:absolute;left:50%;top:56%;margin-left:-4.5px;width:0;height:0;
  border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #FFC24A}

/* ---------- 荧光质感 ---------- */
/* 卡片顶边一道高光：让白卡看起来是"微微凸起的糖片"，而不是一张纸 */
.card::after{
  content:'';position:absolute;left:7%;right:7%;top:0;height:1px;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.95),transparent);
}
.card{box-shadow:0 1px 2px rgba(26,39,80,.04),0 8px 22px -20px rgba(26,39,80,.3),0 0 16px -18px rgba(255,107,61,.4)}

/* 按钮顶面反光：立体感的另一半来自高光，不只是投影 */
.btn{position:relative;overflow:hidden}
.btn::before{
  content:'';position:absolute;left:6%;right:6%;top:2px;height:38%;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,.32),transparent);
  border-radius:inherit;
}
.btn-ghost::before,.btn-danger-ghost::before{background:linear-gradient(180deg,rgba(39,56,110,.05),transparent)}

/* 选项悬停/按下：底部透出一点荧光，指哪亮哪 */
.opt:hover{box-shadow:0 2px 0 rgba(26,39,80,.05),0 0 22px -10px rgba(255,107,61,.75)}
.opt:active{box-shadow:0 0 0 rgba(26,39,80,.05),0 0 26px -8px rgba(255,107,61,.9)}

/* 喇叭：平时安静，鼠标上来才发光 */
.spk{transition:transform .14s var(--spring),box-shadow .16s,border-color .16s}
.spk:hover{box-shadow:0 3px 0 #C9D4EC,0 0 22px -6px rgba(78,205,196,.95)}

/* 结算徽章外圈加一圈荧光，完成感更重 */
.done .badge{box-shadow:0 6px 0 #C7431C,0 18px 34px -14px rgba(242,84,42,.8),0 0 46px -6px rgba(255,107,61,.75)}

/* 主学教材之类的数字用展示体，且等宽，跳动时不抖 */
.dur,.acc{font-variant-numeric:tabular-nums}

/* 彻底关掉动效：用于无头截图，保证拍到的是动画结束后的稳定状态 */
.no-anim *,.no-anim *::before,.no-anim *::after{animation:none!important;transition:none!important}

/* 降级：尊重系统的「减少动态效果」设置 */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
}

/* 窄屏：手机壳收边，去掉多余留白 */
@media (max-width:820px){
  body{padding:12px}
  .wrap{gap:18px}
  .side{width:100%;max-width:375px;padding-top:0}
  .pw{width:100%;max-width:375px;height:min(734px,86vh)}
}
`;

/* ---------- 3. 预览应用（调用真实 services） ---------- */
const APP = `
var cache = {}, MODS = ${MODULES_JSON};

/* ---------- 顶替小程序 API：Storage 落到 localStorage ---------- */
var LS = window.localStorage;
window.wx = {
  getStorageSync: function(k){
    var raw = null;
    try { raw = LS.getItem(k); } catch(e){ return ''; }
    if (raw === null || raw === '') return '';
    try { return JSON.parse(raw); } catch(e){ return raw; }
  },
  setStorageSync: function(k, v){ try { LS.setItem(k, JSON.stringify(v)); } catch(e){} },
  removeStorageSync: function(k){ try { LS.removeItem(k); } catch(e){} },
  clearStorageSync: function(){ try { LS.clear(); } catch(e){} },
  showToast: function(){},
  showModal: function(){},
  getStorageInfoSync: function(){ return { keys: [], currentSize: 0, limitSize: 10240 }; },
  env: { USER_DATA_PATH: '/tmp' }
};
window.getApp = function(){ return { globalData: {} }; };

function norm(p){
  var parts = p.split('/'), out = [];
  for (var i=0;i<parts.length;i++){
    var s = parts[i];
    if (s === '' || s === '.') continue;
    if (s === '..') { out.pop(); continue; }
    out.push(s);
  }
  return out.join('/');
}
function stripJs(k){ return k.slice(-3) === '.js' ? k.slice(0, -3) : k; }
function req(from, id){
  var base = id.charAt(0) === '.' ? from.split('/').slice(0,-1).join('/') + '/' : '';
  var key = stripJs(norm(base + id));
  if (cache[key]) return cache[key].exports;
  if (!MODS[key]) throw new Error('找不到模块 ' + key + '（来自 ' + from + '）');
  var m = { exports: {} };
  cache[key] = m;
  var fn = new Function('require', 'module', 'exports', MODS[key]);
  fn(function(d){ return req(key + '.js', d); }, m, m.exports);
  return m.exports;
}
var dict = req('services/dict.js', './dict');
var user = req('services/user.js', './user');
var srs  = req('services/srs.js', './srs');
var storage = req('utils/date.js', './storage');
try { storage.migrate(); storage.rolloverIfNeeded(); } catch(e){}

var state = {
  screen: 'home', queue: [], idx: 0, cur: null,
  picked: null, input: '', feedback: null,
  stats: null, startTs: 0, result: null, toast: '',
  autoSpeak: true, sfxOn: true, spokenQ: '', spokenA: ''
};

var $ = function(id){ return document.getElementById(id); };
var esc = function(s){ return String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };

/* ============ 音效 ============
 * 全部用 Web Audio 实时合成，不加载任何音频文件：
 *   - 零体积、零网络请求，不会被"文件找不到"或自动播放策略拦成静默失败
 *   - 不存在版权问题
 *   - 无声环境（无头测试、静音设备、老浏览器）自动空转，绝不抛错阻塞答题
 * 音色设计：答对上行三音像小铃铛，答错只用柔和下行两音（不刺耳、不惩罚感）。
 */
var _ac = null, _acTried = false;

function ac(){
  if (_ac || _acTried) return _ac;
  _acTried = true;
  try {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    _ac = new C();
  } catch(e){ _ac = null; }
  return _ac;
}

/* 浏览器要求音频必须由用户手势唤醒，每次点击都顺手 resume 一下 */
function wakeAudio(){
  var c = ac();
  if (!c) return;
  try { if (c.state === 'suspended' && c.resume) c.resume(); } catch(e){}
}

function tone(freq, delay, dur, type, vol){
  if (state.sfxOn === false) return;
  var c = ac();
  if (!c) return;
  try {
    var t0 = c.currentTime + (delay || 0);
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    /* 指数包络不能从 0 起，否则不发声 */
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.14, t0 + 0.014);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (dur || 0.16));
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + (dur || 0.16) + 0.04);
  } catch(e){ /* 静默降级 */ }
}

function sfxTap(){ tone(1046.5, 0, 0.05, 'sine', 0.10); }
function sfxFlip(){
  tone(523.25, 0, 0.09, 'sine', 0.14);
  tone(783.99, 0.05, 0.12, 'sine', 0.12);
}
/* 答对：E5 → A5 → D6，像一颗小铃铛滚下来 */
function sfxCorrect(){
  tone(659.25, 0, 0.14, 'sine', 0.30);
  tone(880.00, 0.07, 0.15, 'sine', 0.26);
  tone(1174.66, 0.15, 0.26, 'sine', 0.21);
}
/* 答错：只降两个音，音色用三角波，柔和不挫败 */
function sfxWrong(){
  tone(311.13, 0, 0.17, 'triangle', 0.24);
  tone(233.08, 0.10, 0.28, 'triangle', 0.20);
}
/* 结算：完整小旋律，给完成感 */
function sfxFinish(){
  var n = [523.25, 659.25, 783.99, 1046.50];
  for (var i = 0; i < n.length; i++) tone(n[i], i * 0.11, 0.32, 'sine', 0.24);
  tone(1567.98, 0.46, 0.55, 'sine', 0.15);
}

/* 点击涟漪：从按下的位置扩散一圈光。
 * 用真实 DOM 插一个 span，600ms 后自动移除；
 * 无 DOM 的环境（无头测试）直接跳过，绝不抛错。 */
function ripple(el, ev){
  try {
    if (!el || typeof document.createElement !== 'function') return;
    if (!el.getBoundingClientRect || !el.appendChild) return;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var cx = (ev && ev.clientX ? ev.clientX - r.left : r.width / 2);
    var cy = (ev && ev.clientY ? ev.clientY - r.top : r.height / 2);
    cx = Math.max(0, Math.min(r.width, cx));
    cy = Math.max(0, Math.min(r.height, cy));
    /* 半径取"点击点到最远角"，光晕刚好在扩散完时盖满控件——
     * 用宽度算会让涟漪一开始就糊住整个按钮，看不出是从手指下散开的 */
    var dx = Math.max(cx, r.width - cx);
    var dy = Math.max(cy, r.height - cy);
    var size = Math.sqrt(dx * dx + dy * dy) * 2;
    var s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = 'width:' + size + 'px;height:' + size + 'px;'
      + 'left:' + (cx - size / 2) + 'px;top:' + (cy - size / 2) + 'px';
    el.appendChild(s);
    setTimeout(function(){
      try { if (s.parentNode) s.parentNode.removeChild(s); } catch(e){}
    }, 620);
  } catch(e){ /* 忽略：涟漪只是锦上添花 */ }
}

/* 给按钮包一层"点击音 + 涟漪 + 唤醒音频上下文"，保持原有 this 语义 */
function withTap(fn){
  return function(ev){
    wakeAudio();
    sfxTap();
    ripple(this, ev);
    return fn.apply(this, arguments);
  };
}

/* ============ 朗读 ============
 * 预览版用浏览器自带语音合成（Web Speech API），零依赖、离线可用。
 * 小程序端播放包内预生成 mp3，接口语义与这里保持一致（见 services/speech.js）。
 * 语速刻意放慢到 0.85，符合小学生跟读节奏。
 */
var _voice = null;
function pickVoice(){
  try {
    var s = window.speechSynthesis;
    if (!s) return null;
    if (_voice) return _voice;
    var vs = s.getVoices() || [];
    var best = null;
    for (var i = 0; i < vs.length; i++){
      if (!/^en(-|_)?/i.test(vs[i].lang || '')) continue;
      // 优先选标注为 en-US / 女声一类更清晰的
      if (!best) best = vs[i];
      if (/en[-_]US/i.test(vs[i].lang)) { best = vs[i]; break; }
    }
    _voice = best;
    return best;
  } catch (e){ return null; }
}

function speak(text){
  if (!text) return;
  try {
    var s = window.speechSynthesis;
    if (!s) return;
    s.cancel();                       // 连点时打断上一句，避免叠音
    var u = new window.SpeechSynthesisUtterance(String(text));
    u.lang = 'en-US';
    u.rate = 0.85;
    u.pitch = 1;
    var v = pickVoice();
    if (v) u.voice = v;
    s.speak(u);
  } catch (e){ /* 无语音环境（如无头校验）时静默跳过 */ }
}

/* 自动朗读的闸门：按"词"去重，不按时间。
 * 一个新词会连续出「卡片 → 词义选择 → 英译中 → 拼写」好几道题，
 * 逐题朗读就是复读机；而换成下一个词时必须能读出来。
 * 所以记住"上一个自动读过的词"，同一个词只读一次。
 * 手动点喇叭走 speak()，不受这道闸门限制——想听就一定给他听。
 */
var _lastSpokenId = '';
function speakOnce(wordId, text){
  if (!text) return;
  if (wordId && wordId === _lastSpokenId) return;
  _lastSpokenId = wordId || '';
  speak(text);
}

/* 用内联 SVG 而不是 🔊：emoji 在不同系统里字宽和基线都不一样，
 * 塞进圆形按钮会明显偏移，看起来像图标从按钮里"跑出去"了 */
function spkBtn(){
  return '<button class="spk" id="spk" title="朗读发音" aria-label="朗读发音">'
    + '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"'
    + ' stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M11 5 6.5 9H3.5v6h3L11 19V5z"/>'
    + '<path d="M15.4 8.7a4.7 4.7 0 0 1 0 6.6"/>'
    + '<path d="M18.3 5.9a8.6 8.6 0 0 1 0 12.2"/>'
    + '</svg></button>';
}

/* 只在题面显示英文时自动朗读；拼写/中译英题面是中文，读了会直接泄题 */
function maybeAutoSpeak(){
  var it = state.cur;
  if (!it || !state.autoSpeak) return;
  if (it.mode !== 'card' && it.mode !== 'en2cn' && it.mode !== 'choice') return;
  var key = state.idx + ':' + it.mode;
  if (state.spokenQ === key) return;
  state.spokenQ = key;
  speakOnce(it.wordId, it.word.word);
}

/* 答完题补读一次。只在"题面是中文、本来就没读过"时补——
 * 英文题面已经读过这个词了，再读第二遍就是用户听到的"读重了"。 */
function maybeSpeakAnswer(){
  if (!state.feedback || !state.autoSpeak || !state.cur) return;
  var it = state.cur;
  if (state.spokenQ === state.idx + ':' + it.mode) return;
  var key = state.idx + ':' + (state.feedback.ok ? 1 : 0);
  if (state.spokenA === key) return;
  state.spokenA = key;
  speakOnce(it.wordId, it.word.word);
}

function showToast(msg){
  state.toast = msg;
  render();
  setTimeout(function(){ state.toast = ''; render(); }, 1600);
}

function todayLabel(){
  var d = new Date();
  var w = ['日','一','二','三','四','五','六'][d.getDay()];
  return (d.getMonth()+1) + '月' + d.getDate() + '日 周' + w;
}

function overview(){
  var map = user.getProgressMap() || {};
  var ids = Object.keys(map);
  var mastered = ids.filter(function(k){ return map[k] && map[k].status === 'mastered'; }).length;
  var streak = 0;
  try { streak = user.getStreak() || 0; } catch(e){}
  var primary = user.getPrimaryBook();
  /* 书架里只存 textbookId，教材全名要回词库查——否则界面上会露出 pep_3a 这种内部 ID */
  var pname = '—';
  if (primary){
    var tb = null;
    try { tb = dict.getTextbook(primary.textbookId); } catch(e){}
    pname = (tb && tb.name) || primary.textbookName || primary.textbookId;
  }
  return { learned: ids.length, mastered: mastered, streak: streak, primary: primary, primaryName: pname };
}

/* ---------- 首页 ---------- */

/* 吉祥物：与小程序 app.wxss 里的 .mascot 同一套结构与配色，纯 CSS 绘制 */
function mascotHtml(){
  return '<div class="mascot">'
    + '<div class="m-ear l"></div><div class="m-ear r"></div>'
    + '<div class="m-body"><div class="m-belly"></div>'
    + '<div class="m-eye l"><div class="m-pupil"></div></div>'
    + '<div class="m-eye r"><div class="m-pupil"></div></div>'
    + '<div class="m-beak"></div></div>'
    + '</div>';
}

function renderHome(){

  var c = srs.peekDailyCounts();
  var ov = overview();
  var books = user.getBookshelf() || [];
  var html = '';
  html += '<div class="hd hd-home"><div class="hd-txt"><div class="d">' + todayLabel() + '</div>'+ '<div class="t">今日任务</div></div>' + mascotHtml() + '</div>';
  html += '<div class="bd">';

  if (!c.hasShelf){
    html += '<div class="card"><div class="empty">书架还是空的<br>先添加一本教材才能开始</div>'
         +  '<button class="btn" id="setup">一键添加教材</button></div>';
  } else {
    html += '<div class="card"><div class="hero">'
         +  '<div class="n"><b>' + c.reviewCount + '</b><span>待复习</span></div>'
         +  '<div class="v"></div>'
         +  '<div class="n"><b>' + c.newCount + '</b><span>新学词</span></div>'
         +  '</div>';
    if (c.reviewCount + c.newCount === 0){
      html += '<div class="stack"><div class="fb ok">今日任务已完成，休息一下</div></div>';
    } else {
      html += '<div class="stack"><button class="btn" id="start">开始学习</button></div>';
    }
    html += '</div>';

    html += '<div class="card">'
         +  '<div class="row"><span>主学教材</span><b>' + esc(ov.primaryName) + '</b></div>'
         +  '<div class="row"><span>书架教材</span><b>' + books.length + ' 本</b></div>'
         +  '<div class="row"><span>已学词条</span><b>' + ov.learned + ' 词</b></div>'
         +  '<div class="row"><span>已掌握</span><b>' + ov.mastered + ' 词</b></div>'
         +  '<div class="row"><span>连续打卡</span><b>' + ov.streak + ' 天</b></div>'
         +  '</div>';

    /* 朗读与音效合成一张卡：首页要在一屏里放完，两张卡会把设置挤到折叠线下 */
    html += '<div class="card">'
         +  '<div class="row"><span>自动朗读发音</span>'
         +  '<button class="tgl' + (state.autoSpeak ? ' on' : '') + '" id="autospeak">'
         +  (state.autoSpeak ? '已开启' : '已关闭') + '</button></div>'
         +  '<div class="row"><span>答题音效</span>'
         +  '<button class="tgl' + (state.sfxOn ? ' on' : '') + '" id="sfx">'
         +  (state.sfxOn ? '已开启' : '已关闭') + '</button></div>'
         +  '<div class="hint">朗读只在英文题面自动播放，拼写与中译英不出声；音效全部实时合成</div>'
         +  '</div>';

    var wrong = user.getWrongList() || [];
    if (wrong.length){
      html += '<div class="card"><div class="row" style="border:0"><span>错词本</span><b>' + wrong.length + ' 词待巩固</b></div>'
           +  '<div class="stack"><button class="btn ghost sm" id="wrong">只练错词</button></div></div>';
    }
  }
  html += '</div>';
  html += '<div class="tab"><div class="on">今日</div><div>词库</div><div>书架</div><div>错词本</div></div>';
  return { html: html, foot: '' };
}

/* ---------- 学习会话 ---------- */
function prepare(it){
  var word = dict.getWord(it.wordId);
  var mode = it.kind === 'card' ? 'card' : (srs.MODES[it.mode] ? it.mode : 'choice');
  var item = { kind: it.kind, wordId: it.wordId, textbookId: it.textbookId, mode: mode, word: word, options: [], prompt: '' };
  if (mode !== 'card') item.prompt = srs.MODES[mode].hint;
  if (mode === 'choice') item.options = srs.buildChoiceOptions(word, dict.getWords(it.textbookId));
  return item;
}

function startSession(wrongOnly){
  var s = wrongOnly ? srs.buildWrongOnlyItems(20) : srs.buildSessionItems();
  if (!s.hasShelf){ showToast('请先添加教材'); return; }
  var q = (s.reviewItems || []).concat(s.newItems || []);
  if (!q.length){ showToast('今日任务已完成'); return; }

  state.queue = q;
  state.idx = 0;
  state.picked = null;
  state.input = '';
  state.feedback = null;
  state.startTs = Date.now();
  _lastSpokenId = '';   // 新会话重新允许朗读第一个词
  state.newWordIds = (s.newItems || []).filter(function(x){ return x.kind !== 'card'; })
    .map(function(x){ return x.wordId; })
    .filter(function(v, i, a){ return a.indexOf(v) === i; });
  state.stats = {
    reviewTotal: 0, reviewCorrect: 0,
    newTotal: 0, newCorrect: 0,
    wrongIds: [], pending: {}
  };
  state.screen = 'session';
  loadCurrent();
  render();
}

function loadCurrent(){
  if (state.idx >= state.queue.length){ state.cur = null; return; }
  state.cur = prepare(state.queue[state.idx]);
}

function advance(){
  state.picked = null;
  state.input = '';
  state.feedback = null;
  state.idx++;
  if (state.idx >= state.queue.length || state.idx >= 160){ finish(); return; }
  loadCurrent();
  render();
}

function submit(ok){
  if (state.feedback) return;
  var it = state.cur;
  var st = state.stats;
  srs.applyAnswer(it.wordId, ok, it.textbookId);

  if (it.kind === 'review'){ st.reviewTotal++; if (ok) st.reviewCorrect++; }
  else {
    st.newTotal++;
    if (ok) st.newCorrect++;
    else st.pending[it.wordId] = (st.pending[it.wordId] || 0) + 1;
  }
  if (!ok){
    st.wrongIds.push(it.wordId);
    state.queue.push({ kind: it.kind, wordId: it.wordId, textbookId: it.textbookId, mode: it.mode });
  }
  state.feedback = { ok: ok, correct: it.word.meaningCn, answer: it.word.word };
  if (ok) sfxCorrect(); else sfxWrong();
  render();
}

function renderSession(){
  var it = state.cur;
  if (!it) return { html: '', foot: '' };
  var total = state.queue.length;
  var pct = Math.min(100, Math.round(state.idx / total * 100));
  var phase = it.kind === 'review' ? '抽查复习' : '新词学习';

  /* 进度条放在标题下面：放到最上面会像一条悬空的色带 */
  var html = '<div class="hd"><div class="meta meta-top"><span>' + phase + '</span>'
           + '<span>' + (state.idx + 1) + ' / ' + total + '</span></div>'
           + '<div class="bar"><i style="width:' + pct + '%"></i></div></div>';
  html += '<div class="bd center">';

  if (it.mode === 'card'){
    html += '<div class="card card-word" data-letter="' + esc(it.word.word.charAt(0).toLowerCase()) + '">'
         +  '<div class="chip-wrap"><span class="chip">新词</span></div>'
         +  '<div class="word-en">' + esc(it.word.word) + spkBtn() + '</div>'
         +  '<div class="word-ph">' + esc(it.word.phonetic || '') + (it.word.pos ? ' · ' + esc(it.word.pos) : '') + '</div>'
         +  '<div class="ask" style="border:0;padding-top:16px"><div class="sense">' + esc(it.word.meaningCn) + '</div></div>'
         +  (it.word.example ? '<div class="ex"><em>' + esc(it.word.example) + '</em><br>' + esc(it.word.exampleCn || '') + '</div>' : '')
         +  '</div>';
    html += '</div>';
    return { html: html, foot: '<button class="btn" id="gotit">记住了，开始练习</button>' };
  }

  var isEn2Cn = it.mode === 'en2cn';
  html += '<div class="card">'
       +  (isEn2Cn
            ? '<div class="word-en">' + esc(it.word.word) + spkBtn() + '</div><div class="word-ph">' + esc(it.word.phonetic || '') + '</div>'
            : it.mode === 'choice'
              ? '<div class="word-en">' + esc(it.word.word) + spkBtn() + '</div><div class="word-ph">' + esc(it.word.phonetic || '') + '</div>'
              : '<div class="sense">' + esc(it.word.meaningCn) + '</div>')
       +  '<div class="ask">' + esc(it.prompt) + '</div>'
       +  '</div>';

  if (it.mode === 'choice'){
    html += '<div>';
    it.options.forEach(function(o, i){
      var cls = 'opt';
      var dis = '';
      if (state.feedback){
        if (o === it.word.meaningCn) cls += ' ok';
        else if (o === state.picked) cls += ' bad';
        dis = ' disabled';
      }
      html += '<button class="' + cls + '" data-opt="' + i + '"' + dis + '>'
           +  '<span class="opt-i">' + 'ABCD'.charAt(i) + '</span>'
           +  '<span class="opt-t">' + esc(o) + '</span>'
           +  '</button>';
    });
    html += '</div>';
  } else {
    html += '<input class="inp" id="ans" autocomplete="off" spellcheck="false" value="' + esc(state.input) + '"'
         +  (state.feedback ? ' disabled' : '') + ' placeholder="' + (it.mode === 'spell' ? '拼出这个单词' : it.mode === 'cn2en' ? '输入英文单词' : '输入中文意思') + '">';
  }

  if (state.feedback){
    // 判对也展示完整释义：多义词答出一个义项就算对，但要让孩子看到还有别的意思
    var full = esc(it.word.word) + '　' + esc(it.word.meaningCn);
    html += '<div class="fb ' + (state.feedback.ok ? 'ok' : 'bad') + '">'
         +  (state.feedback.ok ? '答对了　<b>' + full + '</b>' : '答错了　正确答案：<b>' + full + '</b>')
         +  '</div>';
  }
  html += '</div>';

  var foot;
  if (state.feedback) foot = '<button class="btn" id="next">下一题</button>';
  else if (it.mode === 'choice') foot = '<button class="btn" id="submit" disabled>选择一个选项</button>';
  else foot = '<button class="btn" id="submit">提交</button>';
  return { html: html, foot: foot };
}

function finish(){
  var st = state.stats || { reviewTotal:0, reviewCorrect:0, newTotal:0, newCorrect:0, wrongIds:[], pending:{} };
  if (!st.pending) st.pending = {};
  var newPassed = (state.newWordIds || []).filter(function(id){ return !st.pending[id]; }).length;
  var durationSec = Math.max(1, Math.round((Date.now() - state.startTs) / 1000));
  try {
    user.addLog(null, {
      newCount: newPassed,
      reviewCount: st.reviewTotal,
      correct: st.reviewCorrect + st.newCorrect,
      wrong: st.wrongIds.length,
      durationSec: durationSec
    }, true);
  } catch(e){}

  var uniqWrong = st.wrongIds.filter(function(v, i, a){ return a.indexOf(v) === i; });
  state.result = {
    newPassed: newPassed,
    reviewTotal: st.reviewTotal,
    reviewCorrect: st.reviewCorrect,
    accuracy: st.reviewTotal ? Math.round(st.reviewCorrect / st.reviewTotal * 100) : null,
    durationSec: durationSec,
    wrong: uniqWrong.map(function(id){ return dict.getWord(id); }).filter(Boolean)
  };
  state.cur = null;
  state.screen = 'result';
  sfxFinish();
  render();
}

function renderResult(){
  var r = state.result || { newPassed:0, reviewTotal:0, reviewCorrect:0, accuracy:null, durationSec:0, wrong:[] };
  var m = Math.floor(r.durationSec / 60), s = r.durationSec % 60;
  /* 结算页是孩子每天看到的最后一眼，值得给一点明确的肯定 */
  var praise = r.wrong.length === 0 ? '全对，太棒了！'
             : r.wrong.length <= 2 ? '几乎全对，继续保持'
             : '有进步，明天再过一遍';
  var html = '<div class="hd"><div class="d">' + todayLabel() + '</div><div class="t">今日完成</div></div><div class="bd center">';
  html += '<div class="done">'
       +  '<div class="badge"><svg viewBox="0 0 24 24" width="36" height="36" fill="none"'
       +  ' stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"'
       +  ' aria-hidden="true"><path d="M4.5 12.5l5 5L19.5 7"/></svg></div>'
       +  '<div class="praise">' + praise + '</div>'
       +  '<div class="sub">今天又往前走了一步</div>'
       +  '</div>';
  html += '<div class="card"><div class="hero">'
       +  '<div class="n"><b>' + r.newPassed + '</b><span>新学词</span></div>'
       +  '<div class="v"></div>'
       +  '<div class="n"><b>' + r.reviewTotal + '</b><span>抽查词</span></div>'
       +  '<div class="v"></div>'
       +  '<div class="n"><b>' + (r.accuracy === null ? '—' : r.accuracy + '%') + '</b><span>抽查正确率</span></div>'
       +  '</div></div>';
  html += '<div class="card">'
       +  '<div class="row"><span>用时</span><b>' + m + ' 分 ' + s + ' 秒</b></div>'
       +  '<div class="row"><span>本轮错词</span><b>' + r.wrong.length + ' 个</b></div>'
       +  '</div>';
  if (r.wrong.length){
    html += '<div class="card">';
    r.wrong.forEach(function(w){
      html += '<div class="wrongitem"><b style="font-weight:500">' + esc(w.word) + '</b><span>' + esc(w.meaningCn) + '</span></div>';
    });
    html += '</div>';
  }
  html += '</div>';
  return { html: html, foot: '<div class="stack" style="margin:0"><button class="btn" id="home">回到首页</button></div>' };
}

/* ---------- 渲染 ----------
 * 只在"换题 / 换屏"时播入场动画。同一道题答完只是重绘反馈，
 * 若这时也重播入场，整屏会闪一下，比没有动画更难受，所以用 still 关掉。
 */
var _lastKey = '', _lastScreen = '';
function screenKey(){
  var cur = state.cur;
  return state.screen + '|' + (cur ? cur.wordId + ':' + cur.mode : '') + '|' + state.idx;
}
function render(){
  var r = state.screen === 'home' ? renderHome()
        : state.screen === 'result' ? renderResult()
        : renderSession();
  var key = screenKey();
  var still = (key === _lastKey);
  _lastKey = key;

  var screenChanged = (state.screen !== _lastScreen);
  _lastScreen = state.screen;

  var cls = 'screen' + (still ? ' still' : '');
  if (screenChanged){
    /* 方向感：往下学是"推入"，结束是"浮起"，回到今日是"淡入" */
    cls += state.screen === 'result' ? ' enter-up'
         : state.screen === 'session' ? ' enter-right'
         : ' enter-fade';
  }
  if (state.feedback) cls += state.feedback.ok ? ' fb-ok' : ' fb-bad';

  var pw = $('pw');
  pw.innerHTML = '<div class="' + cls + '" id="screen">' + r.html + '</div>'
               + (r.foot ? '<div class="foot">' + r.foot + '</div>' : '')
               + (state.toast ? '<div class="toast">' + esc(state.toast) + '</div>' : '');
  bind();
  maybeAutoSpeak();
  maybeSpeakAnswer();
}

/* 只有"导航类"按钮给点击音；提交类不播，
 * 否则点击音会和答对/答错的判定音撞在一起，听起来像杂音。 */
function bind(){
  var el;
  if ((el = $('setup'))) el.onclick = withTap(doSetup);
  if ((el = $('start'))) el.onclick = withTap(function(){ startSession(false); });
  if ((el = $('wrong'))) el.onclick = withTap(function(){ startSession(true); });
  if ((el = $('home'))) el.onclick = withTap(function(){ state.screen = 'home'; render(); });
  if ((el = $('gotit'))) el.onclick = withTap(advance);
  if ((el = $('next'))) el.onclick = withTap(advance);
  if ((el = $('spk'))) el.onclick = function(){ wakeAudio(); if (state.cur) speak(state.cur.word.word); };
  if ((el = $('autospeak'))) el.onclick = withTap(function(){
    state.autoSpeak = !state.autoSpeak;
    state.spokenQ = '';
    render();
  });
  if ((el = $('sfx'))) el.onclick = withTap(function(){
    state.sfxOn = !state.sfxOn;
    render();
    if (state.sfxOn) sfxCorrect();   // 重新开启时放一声，确认真的生效
  });

  if ((el = $('submit'))){
    el.onclick = function(ev){
      ripple(this, ev);
      var it = state.cur;
      if (it.mode === 'choice'){
        if (state.picked === null) return;
        submit(srs.judge('choice', it.word, state.picked));
        return;
      }
      submit(srs.judge(it.mode, it.word, state.input));
    };
  }

  var ans = $('ans');
  if (ans) {
    ans.oninput = function(){ state.input = ans.value; };
    ans.onkeydown = function(e){ if (e.key === 'Enter'){ e.preventDefault(); var b = $('submit'); if (b) b.click(); } };
    if (!state.feedback) { try { ans.focus(); } catch(e){} }
  }

  var opts = document.querySelectorAll('[data-opt]');
  for (var i = 0; i < opts.length; i++){
    opts[i].onclick = function(ev){
      if (state.feedback) return;
      ripple(this, ev);
      var it = state.cur;
      state.picked = it.options[Number(this.getAttribute('data-opt'))];
      submit(srs.judge('choice', it.word, state.picked));
    };
  }

  /* 侧栏的试听按钮：用来快速确认"音效到底有没有响"，排除设备静音等因素 */
  if ((el = $('sfxtest'))) el.onclick = function(ev){
    wakeAudio();
    ripple(this, ev);
    if (state.sfxOn === false){ showToast('音效当前是关闭的'); return; }
    sfxCorrect();
  };
}

function doSetup(){
  var books = dict.getTextbooks();
  books.forEach(function(b){
    if (!user.isInShelf(b.id)) user.addBook(b.id);
  });
  if (books.length) user.setPrimary(books[0].id);
  user.savePlan({ dailyNewCount: 8, passModeCount: 2 });
  showToast('已添加 ' + books.length + ' 本教材，每日 8 词');
}

window.resetAll = function(){
  try { localStorage.clear(); } catch(e){}
  state.screen = 'home'; state.queue = []; state.cur = null; state.result = null;
  render();
  showToast('数据已清空');
};

render();
`;

/* ---------- 4. 组装 HTML ---------- */
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>背单词小程序 · 浏览器预览版</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <aside class="side">
    <div class="brand">
      <div class="logo">Aa</div>
      <div>
        <h1>单词秒记</h1>
        <div class="sub">浏览器预览 · 真实逻辑</div>
      </div>
    </div>
    <p>把小程序的核心逻辑搬进浏览器，用来判断界面和手感。点开就能玩，不用装任何东西。</p>
    <div class="ctl">
      <button class="btn ghost sm" id="sfxtest">试听音效</button>
      <button class="btn ghost sm" id="reset">清空数据重来</button>
    </div>
    <div class="note">
      <b>关于这一版</b>
      <ul>
        <li>词库：${bookList}</li>
        <li>排期、判分、错词本走的是和小程序同一套代码</li>
        <li>数据存在浏览器本地，关掉再开还在</li>
        <li>音效由 Web Audio 实时合成，不加载任何音频文件</li>
      </ul>
    </div>
  </aside>
  <div class="pw" id="pw"></div>
</div>
<script>${APP}</script>
<script>document.getElementById('reset').onclick=window.resetAll;</script>
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, html);

console.log('已生成：' + path.relative(ROOT, OUT_FILE));
console.log('内联模块：' + MODULE_FILES.length + ' 个（' + MODULE_FILES.join('、') + '）');
console.log('演示词库：' + bookList);
console.log('文件体积：' + (fs.statSync(OUT_FILE).size / 1024).toFixed(1) + ' KB');
