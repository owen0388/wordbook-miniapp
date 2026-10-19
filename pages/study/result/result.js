const sfx = require('../../../services/sfx');
const user = require('../../../services/user');

function fmtSec(sec) {
  if (!sec) return '0 分钟';
  if (sec < 60) return sec + ' 秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? m + ' 分 ' + s + ' 秒' : m + ' 分钟';
}

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
    let report = null;
    try {
      if (query && query.data) report = JSON.parse(decodeURIComponent(query.data));
    } catch (e) {
      console.error('report parse failed', e);
    }

    // 从首页「查看今日总结」进来时没有参数，用本地记录重算一遍。
    // 结算页不该只在学完那一刻存在一次 —— 一天结束前想再看一眼是正常需求。
    if (!report) report = this._fromToday();

    // 两种来源的 accuracy 口径不同，能直接给就直接用
    let accuracy = report.accuracy;
    if (accuracy === undefined || accuracy === null) {
      const answered = report.reviewTotal + report.newPassed;
      accuracy = answered
        ? Math.round(((report.reviewTotal - report.wrongCount + report.newPassed) / answered) * 100)
        : 100;
    }

    // 标题说"做到了什么"，不说"正确率多少" —— 成就感来自具体的事，不是百分比
    let title;
    if (report.newPassed > 0) title = '拿下 ' + report.newPassed + ' 个新词';
    else if (report.reviewTotal > 0) title = '把 ' + report.reviewTotal + ' 个旧词过了一遍';
    else title = '今天到这里';

    let remark = '';
    if (report.wrongCount === 0 && (report.reviewTotal + report.newPassed) > 0) remark = '一个都没错，状态很好';
    else if (accuracy < 70) remark = '错得有点多，明天抽查会重点照顾这些词';

    this.setData({ report, accuracy, title, remark });
  },

  /** 用今天的本地记录拼一份战报（从首页进入时用） */
  _fromToday() {
    const log = user.getLog() || {};
    const correct = log.correct || 0;
    const wrong = log.wrong || 0;
    const answered = correct + wrong;
    const overall = user.getOverallStats();

    return {
      reviewTotal: log.reviewCount || 0,
      reviewCorrect: correct,
      newPassed: log.newCount || 0,
      wrongCount: wrong,
      durationText: fmtSec(log.durationSec || 0),
      streak: user.getStreak(),
      mastered: overall.mastered,
      longestDays: user.getLongestRememberedDays(),
      finishedTask: !!log.finished,
      accuracy: answered ? Math.round((correct / answered) * 100) : 0
    };
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
