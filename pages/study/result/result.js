const sfx = require('../../services/sfx');

Page({
  data: {
    report: {
      reviewTotal: 0,
      reviewCorrect: 0,
      newPassed: 0,
      wrongCount: 0,
      durationText: '0 秒',
      streak: 0,
      mastered: 0,
      longestDays: 0
    },
    accuracy: 0,
    title: '',
    remark: ''
  },

  onLoad(query) {
    let report = this.data.report;
    try {
      if (query && query.data) report = JSON.parse(decodeURIComponent(query.data));
    } catch (e) {
      console.error('report parse failed', e);
    }

    const answered = report.reviewTotal + report.newPassed;
    const accuracy = answered
      ? Math.round(((report.reviewTotal - report.wrongCount + report.newPassed) / answered) * 100)
      : 100;

    // 标题说"做到了什么"，不说"正确率多少" —— 成就感来自具体的事，不是百分比
    let title;
    if (report.newPassed > 0) title = '拿下 ' + report.newPassed + ' 个新词';
    else if (report.reviewTotal > 0) title = '把 ' + report.reviewTotal + ' 个旧词过了一遍';
    else title = '今天到这里';

    let remark = '';
    if (report.wrongCount === 0 && answered > 0) remark = '一个都没错，状态很好';
    else if (accuracy < 70) remark = '错得有点多，明天抽查会重点照顾这些词';

    this.setData({ report, accuracy, title, remark });
  },

  onShow() {
    // 放在 onShow 而不是 onLoad：页面切换动画期间播会被系统压低音量，
    // 也容易和上一页的"答对"音叠在一起。
    try { sfx.finish(); } catch (e) { /* 忽略 */ }
  },

  goHome() {
    sfx.tap();
    wx.switchTab({ url: '/pages/index/index' });
  },

  goWrongBook() {
    sfx.tap();
    wx.switchTab({ url: '/pages/wrongbook/wrongbook' });
  }
});
