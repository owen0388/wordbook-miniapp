const srs = require('../../services/srs');
const user = require('../../services/user');
const dict = require('../../services/dict');
const sfx = require('../../services/sfx');

Page({
  data: {
    dateText: '',
    weekdayText: '',
    plan: null,
    reviewCount: 0,
    newCount: 0,
    reduced: false,
    estimateText: '',
    hasShelf: false,
    todaySummary: null,
    primaryBook: null,
    overall: { learned: 0, mastered: 0, streak: 0 },
    recentDays: [],
    doneToday: false
  },

  onShow() {
    this.refresh();
  },

  // 首页开启了 enablePullDownRefresh，必须有回调，否则下拉后转圈不会停
  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },

  refresh() {
    const s = srs.buildDailySession();
    const overall = user.getOverallStats();
    const primary = user.getPrimaryBook();
    const log = user.getLog();

    const d = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];

    // 时长估算：把"多少词"翻译成"几分钟"，让人敢点进去。
    // 复习每词 1 屏；新词每词 1 张卡 + passModeCount 道题。单屏实测约 18 秒。
    const perWord = 1 + (s.plan.passModeCount || 2);
    const screens = s.reviewCount + s.newCount * perWord;
    const minutes = Math.max(1, Math.round((screens * 18) / 60));

    // 今日已完成：任务卡切换成"完成态"，把结算页那句情绪文案搬到首页。
    // 结算页只在学完那一刻出现一次，之后找不到了；把这句话留在首页，
    // 用户每次打开都能看到"我今天做到了什么"。
    const doneToday = !!(log && log.finished);
    let todaySummary = null;
    if (doneToday) {
      const correct = log.correct || 0;
      const wrong = log.wrong || 0;
      const answered = correct + wrong;
      const newN = log.newCount || 0;
      todaySummary = {
        newCount: newN,
        reviewCount: log.reviewCount || 0,
        accuracy: answered ? Math.round((correct / answered) * 100) : 0,
        durationText: this.fmtSec(log.durationSec || 0),
        title: newN > 0 ? '拿下 ' + newN + ' 个新词' : '把旧词又过了一遍'
      };
    }

    this.setData({
      dateText: (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日',
      weekdayText: '星期' + week,
      plan: s.plan,
      reviewCount: s.reviewCount,
      newCount: s.newCount,
      reduced: !!s.reduced,
      estimateText: screens > 0 ? minutes + ' 分钟' : '',
      hasShelf: s.hasShelf,
      todaySummary,
      primaryBook: primary
        ? Object.assign({}, primary, user.getBookStats(primary.textbookId))
        : null,
      overall,
      recentDays: user.getRecentDays(7),
      doneToday
    });
  },

  fmtSec(sec) {
    if (!sec) return '0 分钟';
    if (sec < 60) return sec + ' 秒';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? m + ' 分 ' + s + ' 秒' : m + ' 分钟';
  },

  startStudy() {
    sfx.tap();
    const total = this.data.reviewCount + this.data.newCount;
    if (!this.data.hasShelf) {
      wx.switchTab({ url: '/pages/catalog/catalog' });
      return;
    }
    if (total === 0) {
      wx.showToast({ title: '今日任务已完成', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/study/session/session' });
  },

  goRecords() {
    sfx.tap();
    wx.navigateTo({ url: '/pages/records/records' });
  },

  goResult() {
    sfx.tap();
    wx.navigateTo({ url: '/pages/study/result/result' });
  },

  goWrongBook() {
    sfx.tap();
    wx.switchTab({ url: '/pages/wrongbook/wrongbook' });
  },

  goPlan() {
    sfx.tap();
    wx.navigateTo({ url: '/pages/plan/plan' });
  },

  goBookshelf() {
    sfx.tap();
    wx.switchTab({ url: '/pages/bookshelf/bookshelf' });
  }
});
