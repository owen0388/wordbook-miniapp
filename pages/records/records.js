const user = require('../../services/user');

const WD = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function fmtSec(sec) {
  if (!sec) return '0 分钟';
  if (sec < 60) return sec + ' 秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? m + ' 分 ' + s + ' 秒' : m + ' 分钟';
}

Page({
  data: {
    monthText: '',
    weekDays: WD,
    cells: [],
    todayLabel: '',
    today: null,
    stats: { streak: 0, monthDone: 0, mastered: 0 }
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const todayStr = y + '-' + pad2(m + 1) + '-' + pad2(now.getDate());

    // 最近 31 天足够覆盖本月（最多 31 天）
    const recent = user.getRecentDays(31);
    const map = {};
    recent.forEach((r) => { map[r.date] = r; });

    // ---- 月历格子 ----
    const firstWeekday = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push({ d: 0, s: 'blank', today: false });

    let monthDone = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = y + '-' + pad2(m + 1) + '-' + pad2(d);
      const log = map[ds];
      let s = 'none';
      if (ds > todayStr) s = 'future';
      else if (log && log.finished) { s = 'done'; monthDone++; }
      else if (log && (log.newCount || log.reviewCount)) s = 'partial';
      cells.push({ d, s, today: ds === todayStr });
    }

    // ---- 今日总结 ----
    const tlog = map[todayStr];
    let today = null;
    if (tlog) {
      const correct = tlog.correct || 0;
      const wrong = tlog.wrong || 0;
      const tot = correct + wrong;
      today = {
        newCount: tlog.newCount || 0,
        reviewCount: tlog.reviewCount || 0,
        accuracy: tot ? Math.round((correct / tot) * 100) : 0,
        durationText: fmtSec(tlog.durationSec || 0),
        finished: !!tlog.finished
      };
    }

    const overall = user.getOverallStats();

    this.setData({
      monthText: y + ' 年 ' + (m + 1) + ' 月',
      todayLabel: (m + 1) + ' 月 ' + now.getDate() + ' 日 · 星期' + WD[now.getDay()],
      cells,
      today,
      stats: {
        streak: user.getStreak(),
        monthDone,
        mastered: overall.mastered
      }
    });
  },

  // 今天没学时，直接从记录页去学习
  goStudy() {
    wx.navigateBack();
  }
});
