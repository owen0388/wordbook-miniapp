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
    hasShelf: false,
    primaryBook: null,
    overall: { learned: 0, mastered: 0, streak: 0 },
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

    this.setData({
      dateText: (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日',
      weekdayText: '星期' + week,
      plan: s.plan,
      reviewCount: s.reviewCount,
      newCount: s.newCount,
      hasShelf: s.hasShelf,
      primaryBook: primary
        ? Object.assign({}, primary, user.getBookStats(primary.textbookId))
        : null,
      overall,
      doneToday: !!(log && log.finished)
    });
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
