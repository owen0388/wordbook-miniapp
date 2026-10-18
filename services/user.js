/**
 * 用户数据层：书架、计划、掌握进度、错词本、每日日志、收藏。
 * 全部落在本地 Storage，答题过程零网络。
 */

const storage = require('../utils/storage');
const K = storage.KEYS;
const { today, yesterday, addDays, diffDays } = require('../utils/date');
const dict = require('./dict');

/* ============ 书架 ============ */

function getBookshelf() {
  const list = storage.get(K.BOOKSHELF, []);
  return list.slice().sort((a, b) => a.sort - b.sort);
}

function _saveBookshelf(list) {
  list.forEach((b, i) => { b.sort = i; });
  storage.set(K.BOOKSHELF, list);
}

function isInShelf(textbookId) {
  return getBookshelf().some((b) => b.textbookId === textbookId);
}

function addBook(textbookId) {
  const list = getBookshelf();
  if (list.some((b) => b.textbookId === textbookId)) return false;
  const t = dict.getTextbook(textbookId);
  if (!t) return false;
  list.push({
    textbookId,
    name: t.name,
    publisher: t.publisher,
    grade: t.grade,
    term: t.term,
    isPrimary: list.length === 0, // 第一本自动成为主学教材
    addedAt: today()
  });
  _saveBookshelf(list);
  return true;
}

/** 移出书架：只从书架移除，进度数据保留，避免误删学习记录 */
function removeBook(textbookId) {
  let list = getBookshelf().filter((b) => b.textbookId !== textbookId);
  const hadPrimary = getBookshelf().find((b) => b.textbookId === textbookId);
  if (hadPrimary && hadPrimary.isPrimary && list.length) list[0].isPrimary = true;
  _saveBookshelf(list);
  return true;
}

/**
 * 设为主学教材，并把它移到书架首位。
 * 这样"书架上看到的顺序"与"新词实际出题顺序"始终一致，避免两套顺序让用户困惑。
 */
function setPrimary(textbookId) {
  const list = getBookshelf();
  const i = list.findIndex((b) => b.textbookId === textbookId);
  if (i < 0) return false;
  const target = list.splice(i, 1)[0];
  list.forEach((b) => { b.isPrimary = false; });
  target.isPrimary = true;
  list.unshift(target);
  _saveBookshelf(list);
  return true;
}

function moveBook(textbookId, dir) {
  const list = getBookshelf();
  const i = list.findIndex((b) => b.textbookId === textbookId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return false;
  const tmp = list[i];
  list[i] = list[j];
  list[j] = tmp;
  _saveBookshelf(list);
  return true;
}

function getPrimaryBook() {
  const list = getBookshelf();
  return list.find((b) => b.isPrimary) || list[0] || null;
}

/* ============ 学习计划 ============ */

function getPlan() {
  return Object.assign({}, storage.DEFAULT_PLAN, storage.get(K.PLAN, {}));
}

function savePlan(patch) {
  const plan = Object.assign(getPlan(), patch || {});
  storage.set(K.PLAN, plan);
  return plan;
}

/* ============ 单词掌握进度 ============ */

function getProgressMap() {
  return storage.get(K.PROGRESS, {});
}

function getWordProgress(wordId) {
  return getProgressMap()[wordId] || null;
}

function saveWordProgress(wordId, p) {
  const map = getProgressMap();
  map[wordId] = p;
  storage.set(K.PROGRESS, map);
  return p;
}

/** 首次学习：建立进度记录 */
function initWordProgress(wordId, textbookId) {
  const existing = getWordProgress(wordId);
  if (existing) return existing;
  return saveWordProgress(wordId, {
    textbookId,
    status: 'learning',
    // FSRS 字段。state=1 为 LEARNING；stability=0 表示"尚未调度过"，
    // 首次作答时由 services/fsrs.js 按实际表现初始化（此处不引 fsrs，避免层次倒置）
    state: 1,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    correctCount: 0,
    wrongCount: 0,
    streak: 0,
    lastResult: 'correct',
    learnedAt: today(),
    lastReviewAt: today(),
    nextReviewAt: addDays(today(), 1) // 明天进入抽查队列
  });
}

/** 某本教材的完成情况 */
function getBookStats(textbookId) {
  const words = dict.getWords(textbookId);
  const map = getProgressMap();
  let learned = 0;
  let mastered = 0;
  words.forEach((w) => {
    const p = map[w.id];
    if (p) {
      learned++;
      if (p.status === 'mastered') mastered++;
    }
  });
  const total = words.length;
  return {
    total,
    learned,
    mastered,
    percent: total ? Math.round((learned / total) * 100) : 0
  };
}

/** 全局统计 */
function getOverallStats() {
  const map = getProgressMap();
  const ids = Object.keys(map);
  let mastered = 0;
  let learning = 0;
  ids.forEach((id) => {
    if (map[id].status === 'mastered') mastered++;
    else learning++;
  });
  return {
    totalLibrary: dict.getTotalWordCount(),
    learned: ids.length,
    mastered,
    learning,
    streak: getStreak()
  };
}

/* ============ 错词本 ============ */

function getWrongBook() {
  return storage.get(K.WRONG_BOOK, {});
}

function recordWrong(wordId, textbookId) {
  const book = getWrongBook();
  const prev = book[wordId] || { wrongCount: 0 };
  book[wordId] = {
    wrongCount: prev.wrongCount + 1,
    lastWrongAt: today(),
    textbookId: textbookId || prev.textbookId || ''
  };
  storage.set(K.WRONG_BOOK, book);
}

function clearWrong(wordId) {
  const book = getWrongBook();
  delete book[wordId];
  storage.set(K.WRONG_BOOK, book);
}

/** 错词列表：按错误次数倒序，附带词条详情 */
function getWrongList() {
  const book = getWrongBook();
  const ids = Object.keys(book);
  return ids
    .map((id) => {
      const w = dict.getWord(id);
      return w ? Object.assign({}, w, { wrongCount: book[id].wrongCount, lastWrongAt: book[id].lastWrongAt }) : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.wrongCount - a.wrongCount);
}

/* ============ 复习明细（FSRS 的数据燃料） ============ */

/**
 * 每次作答记一条：[词 id, 日期, 评分, 耗时ms, 题型]
 *
 * 为什么单独存明细而不是只存聚合后的 stage：
 *   FSRS 的输入是"每次复习发生在哪天、当时记得的概率多大、表现如何"。
 *   只存最终状态等于把过程丢掉了，之后想校准参数、复盘遗忘曲线都无从下手。
 *   这个数据有「不记就永远补不回来」的性质，所以优先级高于算法本身。
 *
 * 按月分片（wb_rlog_YYYY-MM）：wx.setStorageSync 单 key 上限 1MB，
 * 一年两千多条挤在一个 key 里会顶到天花板。每条用数组而非对象，省约四成体积。
 */
const RLOG_PREFIX = 'wb_rlog_';

function rlogKey(month) {
  return RLOG_PREFIX + month;
}

function addReviewLog(wordId, rating, ms, mode, date) {
  const t = date || today();
  const key = rlogKey(t.slice(0, 7));
  const arr = storage.get(key, []);
  arr.push([wordId, t, rating, Math.max(0, Math.round(ms || 0)), mode || '']);
  if (arr.length > 20000) arr.splice(0, arr.length - 20000); // 异常膨胀时截断
  return storage.set(key, arr);
}

function getReviewLogs(month) {
  return storage.get(rlogKey(month || today().slice(0, 7)), []);
}

function listReviewLogMonths() {
  const out = [];
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || []).forEach((k) => {
      if (k.indexOf(RLOG_PREFIX) === 0) out.push(k.slice(RLOG_PREFIX.length));
    });
  } catch (e) { /* ignore */ }
  return out.sort();
}

/** 累计复习条数。FSRS 参数优化一般需要 1000 条以上样本 */
function countReviewLogs() {
  return listReviewLogMonths().reduce((n, m) => n + getReviewLogs(m).length, 0);
}

/* ============ 每日日志 ============ */

function getLog(date) {
  const all = storage.get(K.DAILY_LOG, {});
  return all[date || today()] || null;
}

function addLog(date, delta, finished) {
  const all = storage.get(K.DAILY_LOG, {});
  const d = date || today();
  const cur = all[d] || { newCount: 0, reviewCount: 0, correct: 0, wrong: 0, durationSec: 0, finished: false };
  cur.newCount += delta.newCount || 0;
  cur.reviewCount += delta.reviewCount || 0;
  cur.correct += delta.correct || 0;
  cur.wrong += delta.wrong || 0;
  cur.durationSec += delta.durationSec || 0;
  if (finished !== undefined) cur.finished = finished;
  all[d] = cur;
  storage.set(K.DAILY_LOG, all);
  return cur;
}

/** 连续打卡天数：从今天（或昨天）往前数连续完成的天数 */
function getStreak() {
  const all = storage.get(K.DAILY_LOG, {});
  let cursor = today();
  // 今天还没完成时，从昨天开始算，避免"今天还没背就断签"
  if (!(all[cursor] && all[cursor].finished)) cursor = addDays(cursor, -1);
  let streak = 0;
  while (all[cursor] && all[cursor].finished) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** 最近 n 天的学习量，用于统计图表（从早到晚） */
function getRecentDays(n) {
  const all = storage.get(K.DAILY_LOG, {});
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = addDays(today(), -i);
    const log = all[d];
    out.push({
      date: d,
      label: d.slice(5),
      newCount: log ? log.newCount : 0,
      reviewCount: log ? log.reviewCount : 0,
      finished: !!(log && log.finished)
    });
  }
  return out;
}

/* ============ 收藏 ============ */

function getFavorites() {
  return storage.get(K.FAVORITES, []);
}

function toggleFavorite(wordId) {
  const list = getFavorites();
  const i = list.indexOf(wordId);
  if (i >= 0) list.splice(i, 1); else list.push(wordId);
  storage.set(K.FAVORITES, list);
  return i < 0;
}

module.exports = {
  // 书架
  getBookshelf, isInShelf, addBook, removeBook, setPrimary, moveBook, getPrimaryBook,
  // 计划
  getPlan, savePlan,
  // 进度
  getProgressMap, getWordProgress, saveWordProgress, initWordProgress,
  getBookStats, getOverallStats,
  // 错词本
  getWrongBook, recordWrong, clearWrong, getWrongList,
  // 日志
  getLog, addLog, getStreak, getRecentDays,
  // 复习明细（FSRS 数据基础）
  addReviewLog, getReviewLogs, listReviewLogMonths, countReviewLogs,
  // 收藏
  getFavorites, toggleFavorite
};
