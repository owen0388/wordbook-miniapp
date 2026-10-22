/**
 * 冒烟测试：在 Node 里模拟小程序环境，把核心逻辑完整跑一遍。
 * 运行： node scripts/smoke-test.cjs
 *
 * 只验证纯逻辑（词库读取 / 书架 / SRS 排期 / 判分 / 会话编排），
 * 不涉及任何 UI 与小程序 API。
 */

/* ---------- 模拟小程序环境 ---------- */
const store = {};
global.wx = {
  getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
  setStorageSync: (k, v) => { store[k] = v; },
  removeStorageSync: (k) => { delete store[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(store) }),
  showToast: () => {}
};
global.getApp = () => ({ globalData: {} });

const path = require('path');
const fs = require('fs');
const dict = require(path.join(__dirname, '../services/dict'));
const user = require(path.join(__dirname, '../services/user'));
const srs = require(path.join(__dirname, '../services/srs'));
const dt = require(path.join(__dirname, '../utils/date'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 1. 词库 ---------- */
section('1. 词库读取');
const books = dict.getTextbooks();
check('读到教材', books.length >= 1, '实际 ' + books.length);
check('教材元数据完整', books.every((b) => b.id && b.name && b.unitCount > 0));
check('单元数不少于 1', dict.getUnits(books[0].id).length >= 1, '实际 ' + dict.getUnits(books[0].id).length);
const words0 = dict.getWords(books[0].id);
check('词条带 textbookId', words0.every((w) => w.textbookId === books[0].id));
check('词条字段完整', words0.every((w) => w.id && w.word && w.meaningCn));
check('关键词搜索命中英文', dict.searchWords('app').some((w) => w.word === 'apple'));
check('关键词搜索命中中文', dict.searchWords('苹果').length > 0);
if (books.length > 1) {
  check('wordId 跨教材复用', (() => {
    const a = dict.getWords(books[0].id).find((w) => w.word === 'apple');
    const b = dict.getWords(books[1].id).find((w) => w.word === 'apple');
    return b ? (!a || a.id === b.id) : true;
  })());
} else {
  console.log('  - 跳过：词库只有 1 本教材，跨教材复用测试需要 2 本以上');
}

/* ---------- 2. 书架 ---------- */
section('2. 书架与计划');
user.addBook(books[0].id);
check('加入书架', user.getBookshelf().length === 1);
check('第一本自动主学', user.getPrimaryBook().textbookId === books[0].id);
if (books.length > 1) {
  user.addBook(books[1].id);
  check('可加入第二本', user.getBookshelf().length === 2);
  user.setPrimary(books[1].id);
  check('切换主学', user.getPrimaryBook().textbookId === books[1].id);
  check('主学置顶排序', user.getBookshelf()[0].textbookId === books[1].id);
  user.moveBook(books[1].id, 1);
  check('下移生效', user.getBookshelf()[1].textbookId === books[1].id);
  user.setPrimary(books[0].id);
} else {
  console.log('  - 跳过：书架多教材排序测试需要 2 本以上');
}
// 默认新词量 10：一个词 3 屏（1 卡 + 2 题），30 屏约 9 分钟，落在小学生注意力窗口内
check('计划默认值', user.getPlan().dailyNewCount === 10);
user.savePlan({ dailyNewCount: 10, passModeCount: 2 });
check('计划可保存', user.getPlan().dailyNewCount === 10);

/* ---------- 2.5 自适应减量 ---------- */
section('2.5 自适应减量（昨天没做完就少给一点）');
{
  const base = { dailyNewCount: 10 };
  const yStr = dt.yesterday();

  delete store.wb_daily_log;
  check('昨天没来过 → 不减量', srs.effectiveNewCount(base) === 10);

  store.wb_daily_log = { [yStr]: { finished: true } };
  check('昨天做完了 → 不减量', srs.effectiveNewCount(base) === 10);

  store.wb_daily_log = { [yStr]: { finished: false } };
  check('昨天没做完 → 减到 8', srs.effectiveNewCount(base) === 8);

  check('减量下限为 4', srs.effectiveNewCount({ dailyNewCount: 5 }) === 4);
  check('减量不累积（计划 20 → 18）', srs.effectiveNewCount({ dailyNewCount: 20 }) === 18);

  delete store.wb_daily_log;   // 清掉，避免影响后面的打卡测试
}

/* ---------- 3. 排期算法（FSRS） ---------- */
section('3. FSRS 排期');
const w = dict.getWords(books[0].id)[0];
const D = (n) => dt.addDays('2026-10-18', n);   // 固定基准日，跨天可重现

// 首次答对：进入 learning，且第二天必须抽查（产品硬规则，不交给算法）
let p = srs.applyAnswer(w.id, true, books[0].id, { date: D(0), ms: 3200, mode: 'choice' });
check('首次答对生成稳定度', p.stability > 0, 'S=' + p.stability);
check('难度落在 1~10', p.difficulty >= 1 && p.difficulty <= 10, 'D=' + p.difficulty);
check('新词次日必抽查', p.nextReviewAt === D(1), p.nextReviewAt);
check('首次后状态为 learning', p.status === 'learning');

// 同一天再答对（新词有多道题）：不应重复调度，否则稳定度会虚高
const s0 = p.stability;
p = srs.applyAnswer(w.id, true, books[0].id, { date: D(0), ms: 2100, mode: 'en2cn' });
check('同一天重复作答不重复调度', p.stability === s0, 'S=' + p.stability);

// 次日答对：进入 review，间隔明显拉长
p = srs.applyAnswer(w.id, true, books[0].id, { date: D(1), ms: 1800, mode: 'spell' });
const iv1 = dt.diffDays(p.nextReviewAt, D(1));
check('次日答对进入 review', p.state === srs.fsrs.STATE.REVIEW);
check('次日答对间隔 > 1 天', iv1 > 1, '间隔 ' + iv1 + ' 天');
check('稳定度增长', p.stability > s0, s0.toFixed(2) + ' → ' + p.stability.toFixed(2));

// 到期再答对：间隔继续递增（这是 FSRS 相对固定间隔的核心收益）
const due1 = p.nextReviewAt;
const s1 = p.stability;
p = srs.applyAnswer(w.id, true, books[0].id, { date: due1, ms: 1500, mode: 'choice' });
const iv2 = dt.diffDays(p.nextReviewAt, due1);
check('间隔单调递增', iv2 > iv1, iv1 + ' → ' + iv2 + ' 天');
check('稳定度继续增长', p.stability > s1, s1.toFixed(2) + ' → ' + p.stability.toFixed(2));

// 答错：回落明天、稳定度下降、记错词本、lapses+1
const sBefore = p.stability;
const lapsesBefore = p.lapses;
const due2 = p.nextReviewAt;
p = srs.applyAnswer(w.id, false, books[0].id, { date: due2, ms: 9000, mode: 'cn2en' });
check('答错后明天再来', p.nextReviewAt === dt.addDays(due2, 1), p.nextReviewAt);
check('答错转入 relearning', p.state === srs.fsrs.STATE.RELEARNING);
check('答错后稳定度下降', p.stability < sBefore, sBefore.toFixed(2) + ' → ' + p.stability.toFixed(2));
check('遗忘次数 +1', p.lapses === lapsesBefore + 1, p.lapses);
check('答错记入错词本', user.getWrongList().some((x) => x.id === w.id));
check('错词本计数', user.getWrongBook()[w.id].wrongCount === 1);

// 长期坚持：最终达到 mastered（下次间隔 ≥30 天）
let guard = 0;
let cursor = p.nextReviewAt;
while (user.getWordProgress(w.id).status !== 'mastered' && guard++ < 40) {
  p = srs.applyAnswer(w.id, true, books[0].id, { date: cursor, ms: 1500, mode: 'choice' });
  cursor = p.nextReviewAt;
}
check('长期答对可到 mastered', p.status === 'mastered', 'S=' + p.stability + '，' + guard + ' 轮');
check('mastered 间隔 ≥ 30 天', dt.diffDays(p.nextReviewAt, p.lastReviewAt) >= 30,
  dt.diffDays(p.nextReviewAt, p.lastReviewAt) + ' 天');

/* ---------- 3b. FSRS 内核 ---------- */
section('3b. FSRS 内核');
check('R(t=S) 等于 0.9', Math.abs(srs.fsrs.retrievability(10, 10) - 0.9) < 1e-6,
  srs.fsrs.retrievability(10, 10).toFixed(6));
check('留存率越低间隔越长', srs.fsrs.nextInterval(10, 0.85) > srs.fsrs.nextInterval(10, 0.95));
check('间隔至少 1 天', srs.fsrs.nextInterval(0.1, 0.9) >= 1);
check('难度随 Again 上升', srs.fsrs.nextDifficulty(5, srs.fsrs.RATING.AGAIN) > 5);
check('难度随 Easy 下降', srs.fsrs.nextDifficulty(5, srs.fsrs.RATING.EASY) < 5);
check('难度始终夹在 1~10', (() => {
  let d = 5;
  for (let i = 0; i < 50; i++) d = srs.fsrs.nextDifficulty(d, srs.fsrs.RATING.AGAIN);
  return d <= 10 && d >= 1;
})());
check('老数据可由 stage 迁移', srs.fsrs.fromStage(4).stability === 7);

/* ---------- 3c. 复习明细 ---------- */
section('3c. 复习明细');
const months = user.listReviewLogMonths();
check('已写入复习明细', months.length > 0 && user.countReviewLogs() > 0,
  user.countReviewLogs() + ' 条');
const logs = user.getReviewLogs(months[months.length - 1]);
check('明细字段完整（词/日期/评分/耗时/题型）', Array.isArray(logs[0]) && logs[0].length === 5,
  JSON.stringify(logs[0]));
check('明细含合法评分', logs[0][2] >= 1 && logs[0][2] <= 4, logs[0][2]);
check('明细含耗时', typeof logs[0][3] === 'number');

/* ---------- 4. 判分 ---------- */
section('4. 判分容错');
const apple = dict.getWord('w_apple');
check('选择题：完全匹配', srs.judge('choice', apple, apple.meaningCn) === true);
check('选择题：错误答案', srs.judge('choice', apple, '香蕉') === false);
check('英译中：关键词命中', srs.judge('en2cn', apple, '苹果') === true);
check('英译中：含多余文字也命中', srs.judge('en2cn', apple, '意思是苹果吧') === true);
check('英译中：完全不对', srs.judge('en2cn', apple, '香蕉') === false);
check('中译英：正确', srs.judge('cn2en', apple, 'apple') === true);
check('中译英：大写容错', srs.judge('cn2en', apple, 'Apple') === true);
check('中译英：前后空格容错', srs.judge('cn2en', apple, '  apple  ') === true);
check('中译英：拼错判错', srs.judge('cn2en', apple, 'aple') === false);
check('拼写：正确', srs.judge('spell', apple, 'apple') === true);
check('空答案判错', srs.judge('spell', apple, '') === false);

/* 多义词：答出任意一个义项即算对（这是最常见的真实情况） */
const multi = { id: 'w_time', word: 'time', meaningCn: '时间；次数' };
check('多义词：答第一个义项', srs.judge('en2cn', multi, '时间') === true);
check('多义词：答第二个义项', srs.judge('en2cn', multi, '次数') === true);
check('多义词：单字"次"算对', srs.judge('en2cn', multi, '次') === true);
check('多义词：词尾单字"间"判错', srs.judge('en2cn', multi, '间') === false);
check('多义词：两个义项都写', srs.judge('en2cn', multi, '时间、次数') === true);
check('多义词：无关答案判错', srs.judge('en2cn', multi, '香蕉') === false);

/* 括号里的补充说法单独作为义项，但要求两个字以上才认 */
const withParen = { id: 'w_dad', word: 'dad', meaningCn: '（口语）爸爸；爹爹' };
check('括号补充：答"爸爸"算对', srs.judge('en2cn', withParen, '爸爸') === true);
check('括号补充：单字"口"不算对', srs.judge('en2cn', withParen, '口') === false);
check('义项拆分数量', srs.meaningSenses('（口语）爸爸；爹爹').length === 3);

/* ---------- 5. 会话编排 ---------- */
section('5. 每日会话编排');

// 造一个"今天到期"的词：SRS 排期已到
const wb = dict.getWords(books[0].id)[1];
srs.applyAnswer(wb.id, true, books[0].id);
const pb = user.getWordProgress(wb.id);
pb.nextReviewAt = dt.today();          // 模拟排期日已到
user.saveWordProgress(wb.id, pb);

// 造一个"昨天新学"的词：还没到期，但属于次日抽查
const wc = dict.getWords(books[0].id)[2];
srs.applyAnswer(wc.id, true, books[0].id);
const pc = user.getWordProgress(wc.id);
pc.learnedAt = dt.yesterday();          // 模拟昨天学的
pc.nextReviewAt = dt.addDays(dt.today(), 5);
user.saveWordProgress(wc.id, pc);

// 造一个"未到期"的词：不应进入今日复习池
const wd = dict.getWords(books[0].id)[3];
srs.applyAnswer(wd.id, true, books[0].id);
const pd = user.getWordProgress(wd.id);
pd.learnedAt = dt.addDays(dt.today(), -5);
pd.nextReviewAt = dt.addDays(dt.today(), 5);
user.saveWordProgress(wd.id, pd);

const session = srs.buildSessionItems();
check('有书架时可生成会话', session.hasShelf === true);
check('新词数受计划限制', session.newCount === 10, 'newCount=' + session.newCount);
check('到期词进入复习池', session.reviewItems.some((i) => i.wordId === wb.id));
check('昨日新学词进入复习池（次日抽查）', session.reviewItems.some((i) => i.wordId === wc.id));
check('未到期词不进入复习池', !session.reviewItems.some((i) => i.wordId === wd.id));
check('复习题每词一题', session.reviewItems.length === session.reviewCount);
check('新词先出学习卡', session.newItems[0].kind === 'card');
check('每词题数 = passModeCount', (() => {
  const target = session.newItems[0].wordId;
  return session.newItems.filter((i) => i.kind === 'new' && i.wordId === target).length === 2;
})());
check('题型都在允许范围内', session.newItems
  .filter((i) => i.mode)
  .every((i) => srs.MODE_KEYS.indexOf(i.mode) >= 0));

const opts = srs.buildChoiceOptions(apple, dict.getWords(books[0].id));
check('选择题 4 个选项', opts.length === 4, '实际 ' + opts.length);
check('选项包含正确答案', opts.indexOf(apple.meaningCn) >= 0);
check('选项无重复', new Set(opts).size === opts.length);

/* ---------- 5b. 复习池来源与顺序 ---------- */
section('5b. 复习池来源、新词顺序、干扰项质量');

// 复习来源拆分：界面上要能说清"这些复习词从哪来"
check('复习来源有拆分字段', !!session.reviewFrom
  && typeof session.reviewFrom.yesterdayNew === 'number'
  && typeof session.reviewFrom.due === 'number',
  JSON.stringify(session.reviewFrom));

// 移出书架的教材不该继续排复习 —— 否则会冒出"在当前教材里找不到"的幽灵词
const ghostBook = books.length > 1 ? books[1].id : null;
if (ghostBook) {
  const gw = dict.getWords(ghostBook)[0];
  srs.applyAnswer(gw.id, true, ghostBook);
  const gp = user.getWordProgress(gw.id);
  gp.nextReviewAt = dt.today();
  user.saveWordProgress(gw.id, gp);

  const before = srs.buildDailySession().reviewWords.map((x) => x.wordId);
  check('在书架上的教材会进复习', before.indexOf(gw.id) >= 0);

  user.removeBook(ghostBook);
  const after = srs.buildDailySession().reviewWords.map((x) => x.wordId);
  check('移出书架后不再进复习池', after.indexOf(gw.id) < 0);
  user.addBook(ghostBook);
}

// 新词不再按字母序（源表是字母排序单词表，原样取就是 A/B/C 开头）
const nw1 = srs.buildDailySession().newWords.map((x) => x.wordId);
const nw2 = srs.buildDailySession().newWords.map((x) => x.wordId);
check('同一天新词顺序稳定（可预期、可续学）', JSON.stringify(nw1) === JSON.stringify(nw2));
const rawOrder = dict.getWords(books[0].id).filter((w) => !user.getWordProgress(w.id))
  .slice(0, nw1.length).map((w) => w.id);
check('新词顺序已打乱，不是字母原序', JSON.stringify(nw1) !== JSON.stringify(rawOrder));

// 干扰项：不能出现占位符，不能与答案重复，长度要和答案贴得住
const allPool = dict.getWords(books[0].id);
let hasFiller = false;
let badLen = 0;
let lenSamples = 0;
let lenSum = 0;
let missAnswer = 0;
const wrongIdsNow = user.getWrongList().map((w) => w.id);
allPool.forEach((w) => {
  const o = srs.buildChoiceOptions(w, allPool, wrongIdsNow);
  if (o.some((x) => /（无）|（空）|（略）/.test(x))) hasFiller = true;
  if (o.length !== 4 || o.indexOf(w.meaningCn) < 0) missAnswer++;
  o.filter((x) => x !== w.meaningCn).forEach((x) => {
    const d = Math.abs(x.length - w.meaningCn.length);
    lenSamples++;
    lenSum += d;
    if (d > 6) badLen++;
  });
});
const avgLenDiff = lenSamples ? lenSum / lenSamples : 0;
check('干扰项不含占位符', !hasFiller);
check('每题都是 4 项且含正确答案', missAnswer === 0, missAnswer + ' 题异常');
// 词库里释义粒度差异很大（1 字"兔"到十几个字），完全同长不可能，
// 所以看平均数：平均差小就说明选项之间没有"一眼能排除"的长短破绽。
check('干扰项平均长度差 <= 2', avgLenDiff <= 2, '平均 ' + avgLenDiff.toFixed(2));
check('极端长度差只是少数', badLen <= lenSamples * 0.05, badLen + '/' + lenSamples);

// 英文输入过滤
check('英文输入过滤掉中文', srs.sanitizeEnInput('苹果') === '');
check('英文输入保留字母与连字符', srs.sanitizeEnInput("ice-cream") === 'ice-cream');
check('英文输入混输时只留字母', srs.sanitizeEnInput('ap苹果ple') === 'apple');

/* ---------- 6. 统计与日志 ---------- */
section('6. 统计与日志');
user.addLog(null, { newCount: 5, reviewCount: 10, correct: 13, wrong: 2, durationSec: 120 }, true);
const log = user.getLog();
check('日志累加', log.newCount === 5 && log.reviewCount === 10);

// finished 只升不降：完成后再进学习页、中途退出，不能把完成标记撤销
user.addLog(null, { newCount: 1 }, false);
check('完成后中途退出不清掉完成标记', user.getLog().finished === true);
check('打卡连续天数 = 1', user.getStreak() === 1, 'streak=' + user.getStreak());
const stats = user.getBookStats(books[0].id);
check('教材统计可用', stats.total > 0 && stats.learned >= 0);
check('最近天数返回 7 天', user.getRecentDays(7).length === 7);
check('总体统计有词库总量', user.getOverallStats().totalLibrary > 0);

const overall = user.getOverallStats();
check('已学单词数 > 0', overall.learned > 0);

/* ---------- 6b. 吉祥物 ---------- */
/* 打招呼是"一天只主动说一次"，标记写坏了会变成每次进首页都说话，
 * 孩子几分钟内就会觉得烦。这里把"第二次必须返回 false"钉死。 */
section('6b. 吉祥物');
check('当天第一次会打招呼', user.greetPupOnce() === true);
check('同一天第二次不再主动说话', user.greetPupOnce() === false);

/* ---------- 7. 发音音频 ---------- */
/* 音频是按教材预生成后打进包的，加教材时最容易忘的一步就是没跑 build-audio.py，
 * 结果界面上有喇叭但点了没声音。这里在数据层直接拦住。 */
section('7. 发音音频');
const manifest = require('../assets/audio/manifest.js');

const audioName = (w) => String(w || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

let audioMissing = 0;
let fileMissing = 0;
books.forEach((b) => {
  const list = manifest[b.id] || [];
  const set = new Set(list);
  const words = dict.getWords(b.id);
  const miss = words.filter((w) => !set.has(w.word));
  if (miss.length) {
    audioMissing += miss.length;
    console.log('    ' + b.name + ' 缺音频 ' + miss.length + ' 个：' + miss.slice(0, 5).map((w) => w.word).join(', '));
  }
  // 清单登记了，但磁盘上文件不在
  list.forEach((w) => {
    const p = path.join(__dirname, '..', 'assets', 'audio', b.id, audioName(w) + '.mp3');
    if (!fs.existsSync(p)) fileMissing++;
  });
});
check('每本教材的词都有音频清单', audioMissing === 0, '共缺 ' + audioMissing + ' 个');
check('清单里的音频文件都真实存在', fileMissing === 0, '缺文件 ' + fileMissing + ' 个');
check('发音能力可用', require('../services/speech').isAvailable() === true);

/* ---------- 7. 答题音效（真机无声问题的防线） ---------- */
section('7. 答题音效');

/* 用假的 InnerAudioContext 记录行为。
 * 这组测试的意义：手机上听不到声音时，能立刻分清是"代码没接上"
 * 还是"手机静音/音量为 0"——前者会在这里报红。 */
const played = [];
let optionApplied = null;
let audioCreated = 0;

global.wx.createInnerAudioContext = () => {
  audioCreated++;
  const a = {
    src: '', volume: 0, obeyMuteSwitch: true,
    stop() { this._stopped = true; },
    play() { played.push(this.src); },
    onError() {},
    destroy() {}
  };
  return a;
};
global.wx.setInnerAudioOption = (o) => { optionApplied = o; };
global.wx.vibrateShort = () => {};

const sfx = require(path.join(__dirname, '../services/sfx'));

sfx.init();
check('初始化后建好音效实例池', audioCreated >= 4, '实例数 ' + audioCreated);
check('已关闭系统静音开关（iOS 拨静音也能出声）',
  optionApplied && optionApplied.obeyMuteSwitch === false,
  JSON.stringify(optionApplied));
check('不打断用户正在播放的音乐', optionApplied && optionApplied.mixWithOther === true);

played.length = 0;
sfx.correct();
check('答对播放 correct.mp3', played.some((s) => s.indexOf('/assets/sfx/correct.mp3') >= 0), played.join(','));

played.length = 0;
sfx.wrong();
check('答错播放 wrong.mp3', played.some((s) => s.indexOf('/assets/sfx/wrong.mp3') >= 0), played.join(','));

played.length = 0;
sfx.tap();
check('点击播放 tap.mp3', played.some((s) => s.indexOf('/assets/sfx/tap.mp3') >= 0));

played.length = 0;
sfx.finish();
check('结算播放 finish.mp3', played.some((s) => s.indexOf('/assets/sfx/finish.mp3') >= 0));

played.length = 0;
sfx.setEnabled(false);
sfx.correct();
sfx.tap();
check('关闭开关后完全静音', played.length === 0, '仍播放 ' + played.length + ' 次');

sfx.setEnabled(true);
check('未知音效名不抛错', (() => { sfx.play('nope'); return true; })());

['tap', 'correct', 'wrong', 'finish'].forEach((n) => {
  const f = path.join(__dirname, '..', 'assets', 'sfx', n + '.mp3');
  check('音效文件存在 ' + n + '.mp3', fs.existsSync(f));
});

/* 音频表体积必须可控：主包只有 2MB，音效不能失控 */
const sfxSize = ['tap', 'correct', 'wrong', 'finish']
  .reduce((n, k) => n + fs.statSync(path.join(__dirname, '..', 'assets', 'sfx', k + '.mp3')).size, 0);
check('音效总体积 < 40KB', sfxSize < 40 * 1024, (sfxSize / 1024).toFixed(1) + ' KB');

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(40));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(40) + '\n');
process.exit(fail ? 1 : 0);
