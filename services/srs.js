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

/** 字符串 → 32 位整数种子（FNV-1a） */
function seedOf(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 确定性洗牌（线性同余）。
 *
 * 为什么要确定性而不是 Math.random：
 * 首页会调一次算数量、进学习页又会调一次算条目，中途退出再进还会调。
 * 纯随机会让"今天学哪 10 个"每次都变 —— 用户昨天看到词表里有 apple，
 * 今天再进就没了，会以为丢数据。用日期做种子，同一天永远是同一批、同一顺序，
 * 跨天才换一批，既打散了字母序又保证了可预期。
 */
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = (seed >>> 0) || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function normalizeEn(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z]/g, '');
}

/**
 * 英文题输入框的字符过滤：只留英文字母、空格、连字符、撇号。
 *
 * 小程序没有"切换系统输入法"的 API，所以"只能输英文"只能在字符层做：
 * 用户用中文键盘敲进来的汉字会被直接丢掉。输不进去，比任何提示都管用。
 * （唯一拦不住的：中文输入法组字阶段的拼音字母——那些本身就是 a-z。）
 */
function sanitizeEnInput(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[^A-Za-z' -]/g, '');
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
 * 复习池 = 昨日新学 ∪ SRS 到期，错词优先，**且只取当前书架里的教材**。
 * 新词池 = 打乱书架内未学过的词，主学教材优先占名额。
 */
function buildDailySession() {
  const plan = user.getPlan();
  const map = user.getProgressMap();
  const t = today();
  const y = yesterday();

  const newLimit = effectiveNewCount(plan);

  // 书架上的教材集合。
  // 复习池必须按它过滤：进度记录是永久的，教材从书架移除后记录仍在，
  // 不过滤的话这些"幽灵词"会一直排进复习——用户在当前教材里翻不到它们，
  // 就会觉得"复习里冒出大量没见过的新词"。这正是本轮反馈的根因。
  const shelf = user.getBookshelf().slice()
    .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));
  const shelfSet = {};
  shelf.forEach((b) => { shelfSet[b.textbookId] = 1; });

  // --- 复习池 ---
  const pool = [];
  let fromYesterdayNew = 0;
  let fromDue = 0;
  Object.keys(map).forEach((wordId) => {
    const p = map[wordId];
    if (!p || p.status === 'new') return;
    // 老数据可能没有 textbookId，放行；有值但不在书架上则跳过
    if (p.textbookId && !shelfSet[p.textbookId]) return;

    const isDue = p.nextReviewAt && p.nextReviewAt <= t; // YYYY-MM-DD 可直接字符串比较
    const isYesterdayNew = p.learnedAt === y;
    if (!isDue && !isYesterdayNew) return;

    if (isYesterdayNew) fromYesterdayNew++;
    else fromDue++;
    pool.push({ wordId, progress: p });
  });

  // 先按"有没有错过"分成两档：错过的优先加强，档内打乱，
  // 避免每天都是同一个顺序（原来严格按日期排，前几个永远是同一批）。
  const wrongFirst = pool.filter((x) => (x.progress.wrongCount || 0) > 0);
  const rest = pool.filter((x) => !(x.progress.wrongCount || 0));
  const orderedPool = shuffle(wrongFirst).concat(shuffle(rest));

  const reviewWords = orderedPool.slice(0, plan.dailyReviewLimit).map((x) => ({
    wordId: x.wordId,
    textbookId: x.progress.textbookId || '',
    wrongCount: x.progress.wrongCount || 0
  }));

  // --- 新词池 ---
  // 不再按词库数组顺序（那是字母序，每天都是 apple/banana/cat 开头，很枯燥）。
  // 用「日期 + 教材」做种子打乱，同一天稳定、跨天轮换。
  const newWords = [];
  for (let i = 0; i < shelf.length; i++) {
    if (newWords.length >= newLimit) break;
    const tid = shelf[i].textbookId;
    const words = seededShuffle(dict.getWords(tid), seedOf(t + '|' + tid));
    for (let j = 0; j < words.length; j++) {
      if (newWords.length >= newLimit) break;
      const w = words[j];
      if (!map[w.id]) newWords.push({ wordId: w.id, textbookId: tid });
    }
  }

  return {
    plan,
    reviewWords,
    newWords,
    reviewCount: reviewWords.length,
    newCount: newWords.length,
    // 复习来源拆分：让"为什么今天有这么多复习"变成可见的事
    reviewFrom: {
      yesterdayNew: fromYesterdayNew,
      due: fromDue,
      total: pool.length
    },
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
    reviewFrom: s.reviewFrom,
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
    reviewFrom: s.reviewFrom,
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

/**
 * 判断一个释义是否适合当干扰项。
 *
 * 三类要挡掉：
 *   1. 纯符号/占位（"（无）"、"—"）—— 一眼假，等于送分
 *   2. 不含汉字（音标、英文）—— 与中文释义不在同一平面
 *   3. 过短（单字）—— 和"苹果""动物"这种两字词不在一个粒度上
 */
function isBadMeaning(m) {
  const s = String(m || '').trim();
  if (s.length < 2) return true;
  if (!/[\u4e00-\u9fff]/.test(s)) return true;
  if (/^[（(【\[][^）)】\]]{0,3}[）)】\]]$/.test(s)) return true;
  return false;
}

/**
 * 干扰项"迷惑度"打分。
 *
 * 目标是让孩子真的要想一下，而不是扫一眼就排除。词库没有语义标签，
 * 所以只能用三个可计算的信号：
 *   - 错题本里的词（+50）     用户自己曾经搞混过的，最真实的混淆证据
 *   - 释义首字相同（+30）     "上午/下午""这/那"这类，中文里最容易看错
 *   - 长度接近（最高 +20）    避免"苹果"旁边站着一个九字长释义
 *   - 汉字有交集（最高 +15）  "时间 / 次数" 这种共享字，天然易混
 */
function confusingScore(cand, word, wrongIds) {
  const a = String(word.meaningCn || '');
  const b = String(cand.meaningCn || '');
  let score = 0;

  if (wrongIds && wrongIds[cand.id]) score += 50;

  if (a.charAt(0) && a.charAt(0) === b.charAt(0)) score += 30;

  const dl = Math.abs(a.length - b.length);
  // 长度权重给得最重：错题和首字相同都是"锦上添花"，
  // 但选项间长度悬殊是最致命的破绽——"兔"旁边站着 16 个字的释义，
  // 孩子根本不用想就能排除。词库里释义粒度差别很大（1 字到十几个字），
  // 所以只能靠排序尽量贴住，正解实在找不到同粒度的就接受。
  score += Math.max(0, 24 - dl * 6);

  let shared = 0;
  for (let i = 0; i < b.length; i++) {
    const ch = b.charAt(i);
    if (ch !== b.charAt(0) && a.indexOf(ch) >= 0) shared++;
  }
  score += Math.min(15, shared * 5);

  return score;
}

/**
 * 词义选择题的选项：正确项 + 3 个干扰项。
 *
 * 干扰项不再纯随机，改为「同教材候选 → 迷惑度打分 → 取高分池里随机抽 3 个」。
 * 不直接取 top3，是为了避免同一道题每次都长一样（孩子会记位置）。
 *
 * @param {object} word   当前词
 * @param {object[]} pool 候选词（同教材）
 * @param {string[]} [wrongIds] 错题本的词 id，用于加权
 */
function buildChoiceOptions(word, pool, wrongIds) {
  const correct = word.meaningCn;
  const wrongSet = {};
  (wrongIds || []).forEach((id) => { wrongSet[id] = 1; });

  const cands = (pool || []).filter((w) =>
    w && w.id !== word.id
    && normalizeCn(w.meaningCn) !== normalizeCn(correct)
    && !isBadMeaning(w.meaningCn));

  // 释义去重，避免两个选项文字完全相同
  const seen = {};
  const unique = [];
  cands.forEach((w) => {
    const k = normalizeCn(w.meaningCn);
    if (seen[k]) return;
    seen[k] = 1;
    unique.push(w);
  });

  const ranked = unique
    .map((w) => ({ w, s: confusingScore(w, word, wrongSet) }))
    .sort((x, y) => y.s - x.s);

  // 从高分池里随机取，池子大小随候选数自适应
  const topN = Math.min(ranked.length, Math.max(3, Math.min(8, Math.ceil(ranked.length / 2))));
  const picked = shuffle(ranked.slice(0, topN)).slice(0, 3).map((x) => x.w.meaningCn);

  // 候选不足（教材词太少）时，从词库全局补，仍然避开占位符
  if (picked.length < 3) {
    const global = shuffle(dict.getAllWords());
    for (let i = 0; i < global.length && picked.length < 3; i++) {
      const m = global[i].meaningCn;
      if (!m || isBadMeaning(m) || normalizeCn(m) === normalizeCn(correct)) continue;
      if (picked.some((p) => normalizeCn(p) === normalizeCn(m))) continue;
      picked.push(m);
    }
  }

  return shuffle([correct].concat(picked));
}

module.exports = {
  fsrs,
  MASTER_INTERVAL,
  ratingOf,
  MODES,
  MODE_KEYS,
  shuffle,
  seedOf,
  seededShuffle,
  normalizeEn,
  sanitizeEnInput,
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
  isBadMeaning,
  confusingScore,
  buildChoiceOptions
};
