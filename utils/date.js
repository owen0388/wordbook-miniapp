/**
 * 日期工具：全部按"本地自然日"处理，跨天边界以 00:00 为准。
 * 小程序里所有"今天/明天"的判断都必须走这里，避免时区与时间戳混乱。
 */

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 本地日期字符串：2026-10-15 */
function dateStr(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

/** 今天 */
function today() {
  return dateStr(new Date());
}

/** 在某个日期上加减天数，返回新的日期字符串 */
function addDays(baseStr, days) {
  const parts = String(baseStr).split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() + days);
  return dateStr(d);
}

/** 昨天 */
function yesterday() {
  return addDays(today(), -1);
}

/** 两个日期相差天数（a - b），按自然日算 */
function diffDays(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  const ta = new Date(pa[0], pa[1] - 1, pa[2]).getTime();
  const tb = new Date(pb[0], pb[1] - 1, pb[2]).getTime();
  return Math.round((ta - tb) / 86400000);
}

module.exports = { pad, dateStr, today, yesterday, addDays, diffDays };
