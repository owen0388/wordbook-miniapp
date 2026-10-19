/**
 * 调度 + 出题引擎（产品的心脏）
 *
 * 排期算法：FSRS（见 services/fsrs.js），不是固定间隔。
 *   - 每个词维护 stability（记忆稳定度）与 difficulty（固有难度）
 *   - 答对 → 按"距上次多久 + 当时记得的概率"重算，间隔通常变长
 *   - 答错 → 稳定度回落、状态转 relearning，下次固定明天
 *   - 目标留存率 0.85（对小学生宁可少复习，也不要任务堆积）
 *
 * 唯一不交给算法的规则：**新词第二天必须抽查**。
 * 这是产品的硬约束（"今天讲的 Unit 3，明晚就能被问到"），
 * 由 learning 阶段的固定 1 天间隔保证。
 *
 * 出题侧不变：四题型、复习块每词 1 题、新学块先卡片再 N 题。
 */

const dict = require('./dict');
const user = require('./user');
const fsrs = require('./fsrs');
const { today, yesterday, addDays, diffDays } = require('../utils/date');

/** 下次复习间隔达到这个天数即标记「已掌握」（仍会按排期继续抽查） */
const MASTER_INTERVAL = 30;

const MODES = {
  choice: { key: 'choice', label: '词义选择', hint: '选出正确的中文释义' },
  en2cn: { key: 'en2cn', label: '英译中', hint: '写出中文意思' },
  cn2en: { key: 'cn2en', label: '中译英', hint: '写出英文单词' },
  spell: { key: 'spell', label: '拼写', hint: '根据释义拼出单词' }
};

const MODE_KEYS = Object.keys(MODES);

/* ============ 工具 ============ */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function normalizeEn(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z]/g, '');
}

function normalizeCn(s) {
  return String(s || '').trim().replace(/[\s,.。、;；!！?？'"]/g, '');
}

/** 中文释义拆成关键词，用于英译中的宽松判分（"苹果；果实" → ["苹果","果实"]） */
function meaningKeywords(meaningCn) {
  return String(meaningCn || '')
    .split(/[；;，,、/（）()]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * 把释义拆成"义项"列表，用于判分。
 *
 * 一个词常有多个意思（time = 时间；次数），孩子答出**任意一个**就该算对。
 * 括号里的补充说法也算独立义项，但它常常是语体说明（口语/书面语），
 * 所以标记 strict：必须答够两个字才算命中，避免孩子答"口"就蒙对。
 *
 *   "时间；次数"            → [{时间},{次数}]
 *   "（口语）爸爸；爹爹"     → [{口语,strict},{爸爸},{爹爹}]
 *
 * @returns {{text:string, strict:boolean}[]}
 */
function meaningSenses(meaningCn) {
  const out = [];
  String(meaningCn || '').split(/[；;，,、\/]/).forEach((part) => {
    const p = String(part || '').trim();
    if (!p) return;
    const br = /[（(]([^）)]*)[）)]/.exec(p);
    if (br && br[1].trim()) out.push({ text: br[1].trim(), strict: true });
    const main = p.replace(/[（(][^）)]*[）)]/g, '').trim();
    if (main) out.push({ text: main, strict: false });
  });
  return out;
}

/**
 * 单个义项匹配。双向包含，解决"答得比释义短/长"两种真实情况：
 *
 *   "次"   ⊂ "次数"   → 对（孩子只答出一个义项的一部分）
 *   "间"   ⊂ "时间"   → 错（落在词尾，多半是蒙的）
 *   "时间次数" ⊃ "时间" → 对（孩子把多个义项都写上了）
 *
 * 规则：单字只在其位于义项**开头**时才算对。这一条专门用来挡"间"这类词尾单字，
 * 同时又放行"次→次数""大→大的"这种孩子最自然的简答。
 */
function matchSense(userCn, sense) {
  const u = normalizeCn(userCn);
  const s = normalizeCn(sense.text);
  if (!u || !s) return false;
  if (u === s) return true;

  // 用户答得比义项更全（写了多个义项）
  if (u.length >= 2 && u.indexOf(s) >= 0) return true;

  // 用户答得比义项短
  if (s.indexOf(u) >= 0) {
    if (sense.strict) return u.length >= 2;      // 括号里的补充说法要求两字以上
    return u.length >= 2 || s.indexOf(u) === 0;  // 单字须命中开头
  }
  return false;
}

/* ============ 排期（FSRS） ============ */

/** 一次作答 → FSRS 评分。四题型只有对错两态，因此只用 Again / Good */
function ratingOf(isCorrect) {
  return isCorrect ? fsrs.RATING.GOOD : fsrs.RATING.AGAIN;
}

/** 老数据（只有 stage、没有 stability）就地升级为 FSRS 状态，避免老用户"从零开始" */
function upgradeLegacy(p) {
  if (p.stability && p.stability > 0) return p;
  if (p.stage) {
    const conv = fsrs.fromStage(p.stage);
    p.state = conv.state;
    p.stability = conv.stability;
    p.difficulty = conv.difficulty;
    p.lapses = p.wrongCount || 0;
    p.reps = p.correctCount || 0;
  } else {
    p.state = fsrs.STATE.NEW;
    p.stability = 0;
    p.difficulty = 0;
    p.reps = 0;
    p.lapses = 0;
  }
  delete p.stage;
  return p;
}

/**
 * 判定一次作答并更新该词的记忆状态。
 *
 * @param {string} wordId
 * @param {boolean} isCorrect
 * @param {string} textbookId
 * @param {{ms?:number, mode?:string, date?:string}} [opts] 耗时、题型与基准日期
 *        （date 仅供测试模拟跨天，正常运行不传）
 * @returns {object} 更新后的进度记录
 */
function applyAnswer(wordId, isCorrect, textbookId, opts) {
  const o = opts || {};
  const map = user.getProgressMap();
  const t = o.date || today();

  let p = map[wordId];
  if (!p) {
    p = {
      textbookId: textbookId || '',
      status: 'learning',
      state: fsrs.STATE.NEW,
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      correctCount: 0,
      wrongCount: 0,
      streak: 0,
      learnedAt: t,
      lastReviewAt: '',
      nextReviewAt: ''
    };
  }
  if (!p.textbookId && textbookId) p.textbookId = textbookId;
  upgradeLegacy(p);

  const rating = ratingOf(isCorrect);
  // 同一天内重复作答（新词有 passModeCount 道题）：只累计统计，不再次调度。
  // 否则一天答两题会被算成两次复习，稳定度虚高、间隔被错误拉长。
  const answeredToday = p.lastReviewAt === t;

  if (isCorrect) {
    p.correctCount = (p.correctCount || 0) + 1;
    p.streak = (p.streak || 0) + 1;
  } else {
    p.wrongCount = (p.wrongCount || 0) + 1;
    p.streak = 0;
  }

  if (!answeredToday) {
    const elapsed = p.lastReviewAt ? Math.max(0, diffDays(t, p.lastReviewAt)) : 0;
    const next = fsrs.schedule(p, rating, elapsed);

    p.state = next.state;
    p.stability = next.stability;
    p.difficulty = next.difficulty;
    p.lapses = next.lapses;
    p.reps = (p.reps || 0) + 1;
    p.lastReviewAt = t;
    p.lastInterval = next.intervalDays;
    p.nextReviewAt = addDays(t, next.intervalDays);

    const inLearning = next.state === fsrs.STATE.LEARNING || next.state === fsrs.STATE.RELEARNING;
    p.status = inLearning ? 'learning'
      : (next.intervalDays >= MASTER_INTERVAL ? 'mastered' : 'review');
  } else if (!isCorrect && p.status !== 'learning') {
    // 当天已经排过期，之后又答错：至少把间隔压回明天，别让答错的词跑到几天后
    p.state = fsrs.STATE.RELEARNING;
    p.nextReviewAt = addDays(t, 1);
    p.lastInterval = 1;
    p.status = 'learning';
  }

  p.lastResult = isCorrect ? 'correct' : 'wrong';
  if (!p.learnedAt) p.learnedAt = t;

  if (!isCorrect) user.recordWrong(wordId, textbookId || p.textbookId);

  // 复习明细：FSRS 的原料，也是将来校准参数、复盘遗忘曲线的唯一依据
  user.addReviewLog(wordId, rating, o.ms, o.mode, t);

  user.saveWordProgress(wordId, p);
  return p;
}

/* ============ 今日队列 ============ */

/**
 * 今天的实际新词量（自适应减量）。
 *
 * 逻辑只有一条：**昨天开了工但没做完，今天就少给一点**。
 * 之所以不叫"逐步递增"，是因为对正在流失的用户，减量是接住他，递增是加压。
 * 产品要保护的是"每天都能完成"，而不是"每天学得更多"。
 *
 * 递减始终基于计划值计算，不做累积递减，所以不会越减越少到 0。
 * 昨天压根没来过（比如刚安装）也不减，避免第一天就给个残缺的任务。
 */
function effectiveNewCount(plan) {
  const base = plan.dailyNewCount || 10;
  const log = user.getLog(yesterday());
  if (!log || log.finished) return base;
  return Math.max(4, base - 2);
}

/**
 * 组装今日学习任务。
 * 复习池 = 昨日新学 ∪ SRS 到期，错词优先。
 * 新词池 = 按书架顺序（主学教材优先）取未学过的词。
 */
function buildDailySession() {
  const plan = user.getPlan();
  const map = user.getProgressMap();
  const t = today();
  const y = yesterday();

  const newLimit = effectiveNewCount(plan);

  // --- 复习池 ---
  const pool = [];
  Object.keys(map).forEach((wordId) => {
    const p = map[wordId];
    if (!p || p.status === 'new') return;
    const isDue = p.nextReviewAt && p.nextReviewAt <= t; // YYYY-MM-DD 可直接字符串比较
    const isYesterdayNew = p.learnedAt === y;
    if (isDue || isYesterdayNew) pool.push({ wordId, progress: p });
  });

  pool.sort((a, b) => {
    if (b.progress.wrongCount !== a.progress.wrongCount) return b.progress.wrongCount - a.progress.wrongCount;
    return a.progress.nextReviewAt < b.progress.nextReviewAt ? -1 : 1;
  });

  const reviewWords = pool.slice(0, plan.dailyReviewLimit).map((x) => ({
    wordId: x.wordId,
    textbookId: x.progress.textbookId || '',
    wrongCount: x.progress.wrongCount || 0
  }));

  // --- 新词池 ---
  const shelf = user.getBookshelf().slice().sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));
  const newWords = [];
  for (let i = 0; i < shelf.length; i++) {
    if (newWords.length >= newLimit) break;
    const words = dict.getWords(shelf[i].textbookId);
    for (let j = 0; j < words.length; j++) {
      if (newWords.length >= newLimit) break;
      const w = words[j];
      if (!map[w.id]) newWords.push({ wordId: w.id, textbookId: shelf[i].textbookId });
    }
  }

  return {
    plan,
    reviewWords,
    newWords,
    reviewCount: reviewWords.length,
    newCount: newWords.length,
    newLimit,                                   // 今天实际给的新词上限
    reduced: newLimit < (plan.dailyNewCount || 10), // 是否因昨天没做完而减量
    hasShelf: shelf.length > 0
  };
}

/** 只取数量，供首页轻量展示 */
function peekDailyCounts() {
  const s = buildDailySession();
  return {
    reviewCount: s.reviewCount,
    newCount: s.newCount,
    reduced: s.reduced,
    hasShelf: s.hasShelf
  };
}

/**
 * 错词专项：只抽错词本里的词做一轮复习，不学新词。
 * 不影响今日正常任务，可在首页任务之外随时来一轮。
 */
function buildWrongOnlyItems(limit) {
  const plan = user.getPlan();
  const list = user.getWrongList().slice(0, limit || 30);
  const items = list.map((w) => ({
    kind: 'review',
    wordId: w.id,
    textbookId: w.textbookId,
    mode: pickModes(1, plan)[0]
  }));
  return { plan, reviewItems: items, newItems: [], reviewCount: items.length, newCount: 0, hasShelf: true };
}

/** 从允许的题型里随机挑 n 个不重复的题型 */
function pickModes(n, plan) {
  const allowed = (plan && plan.modes && plan.modes.length ? plan.modes : MODE_KEYS)
    .filter((m) => MODES[m]);
  const list = allowed.length ? allowed : MODE_KEYS;
  const count = Math.max(1, Math.min(n || 1, list.length));
  return shuffle(list).slice(0, count);
}

/**
 * 生成完整的学习条目序列。
 *   复习块：每词 1 题（抽查性质，快节奏）
 *   新学块：每个词先出一张学习卡，再接 passModeCount 道题
 * 复习块与未通过的新词答错后会回到当前块队尾重来。
 */
function buildSessionItems() {
  const s = buildDailySession();
  const plan = s.plan;

  const reviewItems = s.reviewWords.map((w) => ({
    kind: 'review',
    wordId: w.wordId,
    textbookId: w.textbookId,
    mode: pickModes(1, plan)[0]
  }));

  const newItems = [];
  s.newWords.forEach((w) => {
    newItems.push({ kind: 'card', wordId: w.wordId, textbookId: w.textbookId });
    pickModes(plan.passModeCount, plan).forEach((m) => {
      newItems.push({ kind: 'new', wordId: w.wordId, textbookId: w.textbookId, mode: m });
    });
  });

  return {
    plan,
    reviewItems,
    newItems,
    reviewCount: s.reviewWords.length,
    newCount: s.newWords.length,
    reduced: s.reduced,
    hasShelf: s.hasShelf
  };
}

/* ============ 判分 ============ */

/**
 * 判分。所有题型都对大小写、空格、标点做容错。
 * @returns {boolean}
 */
function judge(mode, word, input) {
  if (!word) return false;
  const ans = input === undefined || input === null ? '' : String(input);

  if (mode === 'choice') {
    return normalizeCn(ans) === normalizeCn(word.meaningCn);
  }

  if (mode === 'en2cn') {
    const userCn = normalizeCn(ans);
    if (!userCn) return false;
    // 答出任意一个义项即算对（time 的"时间"或"次数"，答"次"也认）
    return meaningSenses(word.meaningCn).some((s) => matchSense(ans, s));
  }

  // cn2en / spell：英文拼写完全匹配
  const u = normalizeEn(ans);
  return !!u && u === normalizeEn(word.word);
}

/** 词义选择题的选项：正确项 + 3 个同教材干扰项 */
function buildChoiceOptions(word, pool) {
  const correct = word.meaningCn;
  const others = shuffle(
    (pool || [])
      .filter((w) => w.id !== word.id && normalizeCn(w.meaningCn) !== normalizeCn(correct))
      .map((w) => w.meaningCn)
  );
  const uniq = [];
  others.forEach((m) => {
    if (uniq.length < 3 && uniq.indexOf(m) < 0) uniq.push(m);
  });
  // 词库太小时用占位保证 4 个选项
  const filler = ['（无）', '（空）', '（略）'];
  let fi = 0;
  while (uniq.length < 3) uniq.push(filler[fi++ % filler.length]);

  return shuffle([correct].concat(uniq));
}

module.exports = {
  fsrs,
  MASTER_INTERVAL,
  ratingOf,
  MODES,
  MODE_KEYS,
  shuffle,
  normalizeEn,
  normalizeCn,
  meaningKeywords,
  meaningSenses,
  matchSense,
  applyAnswer,
  effectiveNewCount,
  buildDailySession,
  peekDailyCounts,
  buildWrongOnlyItems,
  pickModes,
  buildSessionItems,
  judge,
  buildChoiceOptions
};
