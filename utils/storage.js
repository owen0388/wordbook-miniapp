/**
 * 本地存储层：所有用户数据的唯一出入口。
 *
 * 设计原则
 *  - 用户数据全部落本地，答题过程零网络，离线可用。
 *  - 统一 wb_ 前缀，方便一键清理与调试。
 *  - SCHEMA_VERSION 变更时在 migrate() 里做就地升级，避免老用户缓存直接报错。
 *
 * 容量说明
 *  wx.setStorageSync 总量约 10MB、单个 key 约 1MB。
 *  本项目全量词条约 2291 个，进度对象约 350KB，单 key 放得下。
 *  若将来词库扩大到上万词，把 PROGRESS 拆成 wb_progress_<textbookId> 分片存储。
 */

const { today, yesterday, diffDays } = require('./date');

const SCHEMA_VERSION = 2;

const KEYS = {
  SCHEMA: 'wb_schema_ver',
  BOOKSHELF: 'wb_bookshelf',
  PLAN: 'wb_plan',
  PROGRESS: 'wb_progress',
  DAILY_LOG: 'wb_daily_log',
  WRONG_BOOK: 'wb_wrong_book',
  FAVORITES: 'wb_favorites',
  SESSION_TMP: 'wb_session_tmp',
  META: 'wb_meta'
};

function get(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return (v === '' || v === null || v === undefined) ? fallback : v;
  } catch (e) {
    console.error('[storage] read failed', key, e);
    return fallback;
  }
}

function set(key, value) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (e) {
    console.error('[storage] write failed', key, e);
    wx.showToast({ title: '本地存储写入失败', icon: 'none' });
    return false;
  }
}

function remove(key) {
  try { wx.removeStorageSync(key); } catch (e) { /* ignore */ }
}

/* ===== 默认值 ===== */

const DEFAULT_PLAN = {
  // 每日新词量：一个词要过「1 张卡 + passModeCount 道题」= 3 屏，
  // 10 个词就是 30 屏（约 9 分钟），落在小学生单次注意力窗口内。
  // 之前是 20（60 屏 / 约 18 分钟），实测几乎没人能坚持做完。
  dailyNewCount: 10,        // 每日新词量
  dailyReviewLimit: 100,    // 每日复习上限
  passModeCount: 2,         // 每个词需要通过的题型数
  modes: ['choice', 'en2cn', 'cn2en', 'spell'], // 参与出题的题型
  passRate: 80,             // 抽查通过线（%），低于此值不解锁新词
  strictMode: true,         // 严格模式：抽查不过则今日只复习不学新词
  autoSpeak: true,          // 自动朗读发音（题面显示英文时读一遍，答完再读一遍）
  sfxOn: true               // 答题音效（触感反馈；关掉后连震动一起停）
};

/* ===== 迁移 ===== */

function migrate() {
  const ver = get(KEYS.SCHEMA, 0);
  if (ver === SCHEMA_VERSION) return;

  // 结构升级在这里按版本号逐级处理。当前为初始版本，只做默认值补全。
  if (!get(KEYS.PLAN, null)) {
    set(KEYS.PLAN, DEFAULT_PLAN);
  } else {
    // 补全后续新增的配置项，避免老用户缺字段
    const plan = Object.assign({}, DEFAULT_PLAN, get(KEYS.PLAN, {}));

    // v1 → v2：每日新词默认值 20 → 10。
    // 老用户的 plan 里躺着的是旧默认值 20（Object.assign 会让它盖住新默认值），
    // 所以这里要主动下调一次。只动「恰好等于旧默认值」的，用户自己调过的（如 15/30）不碰。
    if (ver < 2 && plan.dailyNewCount === 20) plan.dailyNewCount = 10;

    set(KEYS.PLAN, plan);
  }

  if (!get(KEYS.BOOKSHELF, null)) set(KEYS.BOOKSHELF, []);
  if (!get(KEYS.PROGRESS, null)) set(KEYS.PROGRESS, {});
  if (!get(KEYS.DAILY_LOG, null)) set(KEYS.DAILY_LOG, {});
  if (!get(KEYS.WRONG_BOOK, null)) set(KEYS.WRONG_BOOK, {});
  if (!get(KEYS.FAVORITES, null)) set(KEYS.FAVORITES, []);

  set(KEYS.SCHEMA, SCHEMA_VERSION);
}

/* ===== 跨天处理 ===== */

/**
 * 记录"最近一次访问日期"。跨天后清掉当天残留的会话临时数据，
 * 保证第二天进来是一个干净的开始。
 */
function rolloverIfNeeded() {
  const meta = get(KEYS.META, {});
  const t = today();
  if (meta.lastVisit === t) return;

  const prev = meta.lastVisit;
  meta.lastVisit = t;
  set(KEYS.META, meta);

  // 跨天：丢弃上一轮没做完的会话缓存（进度已即时写入 PROGRESS，不会丢）
  if (prev) remove(KEYS.SESSION_TMP);
}

/** 清空全部本机数据（设置页的"清除数据"用） */
function clearAll() {
  Object.keys(KEYS).forEach((k) => remove(KEYS[k]));
  // 复习日志按月分片（wb_rlog_YYYY-MM），不在固定 KEYS 里，单独扫一遍
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || []).forEach((k) => {
      if (k.indexOf('wb_') === 0) remove(k);
    });
  } catch (e) { /* 取不到就只清固定 key */ }
  migrate();
}

module.exports = {
  SCHEMA_VERSION,
  KEYS,
  DEFAULT_PLAN,
  get,
  set,
  remove,
  migrate,
  rolloverIfNeeded,
  clearAll,
  today,
  yesterday,
  diffDays
};
