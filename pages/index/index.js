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
    doneToday: false,
    // 吉祥物交互
    pupLine: '',
    pupHop: false,
    pupLove: false
  },

  onShow() {
    this.refresh();
    this.maybeGreetPup();
  },

  onHide() {
    this.clearPupTimers();
  },

  onUnload() {
    this.clearPupTimers();
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

  /* ===== 吉祥物 =====
   * 交互只有一层：点一下 → 跳一下 + 说一句话（+ 音效）。
   * 连点三下 → 额外冒三颗爱心。
   *
   * 刻意不做的事：
   *   - 不做"喂食/亲密值/等级"这类养成数值。那是挂在学习外面的第二套目标，
   *     孩子会为了养狗而打开小程序，狗饿了他就焦虑 —— 与"用完就走"相反。
   *   - 不给奖励：戳狗不掉币、不加经验。它只是陪着你，不兑换任何东西。
   *   - 每天只在第一次打开时主动说一句话，之后要用户主动戳才说话。
   *     每次进页面都说话会很快变成噪音。
   */

  /** 这些台词按当天状态取，轮着说不重复 */
  pupLines() {
    const d = this.data;
    const total = d.reviewCount + d.newCount;
    if (!d.hasShelf) {
      return ['先去书架挑一本教材吧', '放一本书进来，我就有活干了', '我等着跟你背单词'];
    }
    if (d.doneToday) {
      return ['今天做完啦，厉害！', '明天见，我等你', '你比昨天记得更牢'];
    }
    if (d.reduced) {
      return ['昨天没做完也没关系', '今天少一点，我们慢慢来', '就 ' + total + ' 件小事'];
    }
    return ['今天还有 ' + total + ' 件，一会儿就完', '我陪你，一个一个来', '背完我给你摇尾巴'];
  },

  onPupTap() {
    sfx.pup();

    const pool = this.pupLines();
    const i = (this._pupIdx || 0) % pool.length;
    this._pupIdx = i + 1;
    this.sayPup(pool[i]);

    this._pupTaps = (this._pupTaps || 0) + 1;
    const love = this._pupTaps % 3 === 0;

    // 动画重播：必须先摘类名、隔一帧再加回来，否则类名没变化动画不会重跑
    this.setData({ pupHop: false });
    if (this._hopOn) clearTimeout(this._hopOn);
    if (this._hopOff) clearTimeout(this._hopOff);
    this._hopOn = setTimeout(() => this.setData({ pupHop: true }), 20);
    this._hopOff = setTimeout(() => this.setData({ pupHop: false }), 560);

    if (love) {
      this.setData({ pupLove: true });
      if (this._loveOff) clearTimeout(this._loveOff);
      this._loveOff = setTimeout(() => this.setData({ pupLove: false }), 1100);
    }
  },

  sayPup(line, ms) {
    if (this._sayOff) clearTimeout(this._sayOff);
    this.setData({ pupLine: line });
    this._sayOff = setTimeout(() => {
      this._sayOff = null;
      this.setData({ pupLine: '' });
    }, ms || 2600);
  },

  /** 当天第一次打开首页时打个招呼。只写一次标记，之后整天不再主动出声 */
  maybeGreetPup() {
    if (!user.greetPupOnce()) return;
    this._greet = setTimeout(() => {
      this._greet = null;
      this.sayPup(this.data.doneToday ? '今天已经做完啦' : '你来啦', 3000);
    }, 700);
  },

  clearPupTimers() {
    ['_sayOff', '_hopOn', '_hopOff', '_loveOff', '_greet'].forEach((k) => {
      if (this[k]) {
        clearTimeout(this[k]);
        this[k] = null;
      }
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
