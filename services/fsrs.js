/**
 * FSRS 调度内核（Free Spaced Repetition Scheduler）
 *
 * 算法：FSRS-4.5 + 官方默认参数（17 个权重）
 * 来源：open-spaced-repetition/fsrs.js（MIT 许可），Anki 23.10 起的内置默认调度器
 *
 * 与固定间隔（1/2/4/7/15/30 天）的本质差别
 * ─────────────────────────────────────
 * 固定间隔假设"所有词一样难、所有孩子记性一样好"，答对就往后挪一档。
 * FSRS 给每个词维护两个连续量：
 *   stability  S —— 记忆稳定度，表示"过多少天还有 90% 概率记得"
 *   difficulty D —— 这个词对这个人的固有难度（1~10）
 * 每次作答后按「距上次多久 + 当时记得的概率 + 这次表现」重算 S 和 D，
 * 再反推出"下次该在哪天复习"。
 *
 * 因此同样答对两次，简单的 apple 和难的 afternoon 会得到完全不同间隔；
 * 而固定间隔方案里它们永远同步，结果就是简单词被过度复习（浪费耐心）、
 * 难词复习不足（到期就忘）。
 *
 * 本文件只做"给定状态 + 评分 → 新状态 + 间隔"，不碰存储、不碰 UI。
 */

const DECAY = -0.5;
const FACTOR = 19 / 81;              // ≈ 0.2346，使 R(S, S) = 0.9

/** FSRS-4.5 官方默认权重 */
const DEFAULT_W = [
  0.4872, 1.4003, 3.7145, 13.8206,  // w0-3  初次稳定度 S0(Again/Hard/Good/Easy)
  5.1618, 1.2298,                    // w4-5  初次难度 D0 的基准与斜率
  0.8975, 0.031,                     // w6-7  难度更新步长与均值回归强度
  1.6474, 0.1367, 1.0461,            // w8-10 记得时稳定度增长的基准/衰减/遗忘曲线影响
  2.1072, 0.0793, 0.3246, 1.587,     // w11-14 遗忘时稳定度的基准/难度项/原稳定度项/可提取度项
  0.2272, 2.8755                     // w15-16 Hard 惩罚、Easy 奖励
];

/**
 * 目标留存率。FSRS 的核心旋钮：越低 → 间隔越长、复习越少、忘得越多。
 *
 * 取 0.9 而不是更激进的 0.85，原因见下面的 MAX_INTERVAL：
 * 一旦给间隔加上限，低留存率带来的"省复习"优势就被压缩了，
 * 而小学生记错一个词的代价（挫败感）远高于成人多看一遍的成本。
 */
const DEFAULT_RETENTION = 0.9;

/**
 * 复习间隔上限（天）。这是本项目必须加的一条现实约束，FSRS 原始实现没有。
 *
 * 为什么：FSRS-4.5 的默认参数是用成人长期牌组的真实数据训练的。
 * 直接套到「小学教材词汇」上，模拟出的轨迹是
 *   第 1 天 → +1、第 2 天 → +11、第 13 天 → +55、第 68 天 → +232 天
 * 对成人记忆模型没错，但教材一学期只有约 140 天，232 天等于"背完这辈子不再见"，
 * 明显不符合"这学期要记住"的产品目标。
 *
 * 60 天的含义：任何词至少每两个月必须再出现一次。
 * 一学期约能复习 5 次，既不会遗忘，也不会堆积。
 */
const DEFAULT_MAX_INTERVAL = 60;

const RATING = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

const STATE = { NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 };

const MAX_STABILITY = 36500;   // 100 年，防止溢出
const MIN_STABILITY = 0.1;

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * 可提取度：距上次复习过去 elapsedDays 天时，还能记住的概率。
 * R(t, S) = (1 + FACTOR * t / S) ^ DECAY
 * 当 t = S 时，R = 0.9 —— 这就是 stability 的定义。
 */
function retrievability(elapsedDays, stability) {
  if (!stability || stability <= 0) return 0;
  const t = Math.max(0, Number(elapsedDays) || 0);
  return Math.pow(1 + FACTOR * t / stability, DECAY);
}

/**
 * 由稳定度反推"下次该隔多少天"。
 * 解 R(I, S) = retention 得到：I = S / FACTOR * (retention^(1/DECAY) - 1)
 */
function nextInterval(stability, retention, maxInterval) {
  const r = clamp(Number(retention) || DEFAULT_RETENTION, 0.7, 0.98);
  const s = Math.max(MIN_STABILITY, Number(stability) || MIN_STABILITY);
  const iv = s / FACTOR * (Math.pow(r, 1 / DECAY) - 1);
  const cap = Number(maxInterval) || DEFAULT_MAX_INTERVAL;
  // 下限 1 天：教材背单词按天组织，不存在当天再考
  return clamp(Math.round(iv), 1, Math.min(cap, 3650));
}

function initStability(rating, w = DEFAULT_W) {
  const g = clamp(Math.round(rating), 1, 4);
  return Math.max(w[g - 1], MIN_STABILITY);
}

function initDifficulty(rating, w = DEFAULT_W) {
  const g = clamp(Math.round(rating), 1, 4);
  return clamp(w[4] - (g - 3) * w[5], 1, 10);
}

/** 难度更新：按评分偏移，并朝"平均难度"做均值回归，避免长期跑偏 */
function nextDifficulty(difficulty, rating, w = DEFAULT_W) {
  const g = clamp(Math.round(rating), 1, 4);
  const d = clamp(Number(difficulty) || initDifficulty(RATING.GOOD, w), 1, 10);
  const delta = d - w[6] * (g - 3);
  const meanReversion = w[7] * initDifficulty(RATING.EASY, w) + (1 - w[7]) * delta;
  return clamp(meanReversion, 1, 10);
}

/** 记得时的稳定度增长：越接近遗忘（R 小），答对带来的增益越大 */
function nextStabilityRecall(difficulty, stability, r, rating, w = DEFAULT_W) {
  const g = clamp(Math.round(rating), 1, 4);
  const hardPenalty = g === RATING.HARD ? w[15] : 1;
  const easyBonus = g === RATING.EASY ? w[16] : 1;
  const s = Math.max(MIN_STABILITY, stability);
  const growth = 1
    + Math.exp(w[8])
    * (11 - difficulty)
    * Math.pow(s, -w[9])
    * (Math.exp((1 - r) * w[10]) - 1)
    * hardPenalty * easyBonus;
  return clamp(s * growth, MIN_STABILITY, MAX_STABILITY);
}

/** 遗忘后的稳定度：不是归零，而是按难度和原稳定度给一个更小的值 */
function nextStabilityForget(difficulty, stability, r, w = DEFAULT_W) {
  const s = Math.max(MIN_STABILITY, stability);
  const ns = w[11]
    * Math.pow(difficulty, -w[12])
    * (Math.pow(s + 1, w[13]) - 1)
    * Math.exp((1 - r) * w[14]);
  return clamp(ns, MIN_STABILITY, MAX_STABILITY);
}

/**
 * 核心入口：给当前记忆状态和一次评分，算出新的记忆状态与下次间隔。
 *
 * @param {object} card  { state, stability, difficulty, lapses }
 * @param {number} rating RATING.*
 * @param {number} elapsedDays 距上次复习的天数（首次可传 0）
 * @param {object} [opts] { w, retention, maxInterval }
 * @returns {{state:number, stability:number, difficulty:number, intervalDays:number, lapses:number}}
 */
function schedule(card, rating, elapsedDays, opts) {
  const o = opts || {};
  const w = o.w || DEFAULT_W;
  const retention = o.retention || DEFAULT_RETENTION;
  const maxInterval = o.maxInterval || DEFAULT_MAX_INTERVAL;
  const c = card || {};
  const g = clamp(Math.round(rating) || RATING.GOOD, 1, 4);

  const isFirst = !c.stability || c.state === STATE.NEW || c.state === undefined;

  if (isFirst) {
    // 第一次接触：S 和 D 直接由首次表现决定。
    // 间隔固定为 1 天 —— 这是产品的硬规则「第二天先抽查」，不交给算法决定。
    return {
      state: g === RATING.AGAIN ? STATE.RELEARNING : STATE.LEARNING,
      stability: initStability(g, w),
      difficulty: initDifficulty(g, w),
      intervalDays: 1,
      lapses: g === RATING.AGAIN ? 1 : 0
    };
  }

  const s0 = Math.max(MIN_STABILITY, Number(c.stability));
  const d0 = clamp(Number(c.difficulty) || initDifficulty(RATING.GOOD, w), 1, 10);
  const r = retrievability(elapsedDays, s0);
  const lapses = Number(c.lapses) || 0;

  if (g === RATING.AGAIN) {
    const ns = nextStabilityForget(d0, s0, r, w);
    return {
      state: STATE.RELEARNING,
      stability: ns,
      difficulty: nextDifficulty(d0, g, w),
      intervalDays: 1,           // 答错明天再来，不进长间隔
      lapses: lapses + 1
    };
  }

  const ns = nextStabilityRecall(d0, s0, r, g, w);
  return {
    state: STATE.REVIEW,
    stability: ns,
    difficulty: nextDifficulty(d0, g, w),
    intervalDays: nextInterval(ns, retention, maxInterval),
    lapses
  };
}

/**
 * 由旧的固定间隔进度（只有 stage）推断一个等效记忆状态。
 * 用于老数据升级：stage 1~6 对应 1/2/4/7/15/30 天，稳定度直接取这个间隔，
 * 难度取中性值 5。这样老用户不会因为换算法而"重新开始"。
 */
function fromStage(stage) {
  const STAGE_INTERVAL = [0, 1, 2, 4, 7, 15, 30];
  const s = STAGE_INTERVAL[clamp(Number(stage) || 1, 1, 6)];
  return {
    state: STATE.REVIEW,
    stability: Math.max(s, MIN_STABILITY),
    difficulty: 5,
    lapses: 0
  };
}

module.exports = {
  DECAY,
  FACTOR,
  DEFAULT_W,
  DEFAULT_RETENTION,
  DEFAULT_MAX_INTERVAL,
  RATING,
  STATE,
  MAX_STABILITY,
  MIN_STABILITY,
  clamp,
  retrievability,
  nextInterval,
  initStability,
  initDifficulty,
  nextDifficulty,
  nextStabilityRecall,
  nextStabilityForget,
  schedule,
  fromStage
};
