const user = require('../../services/user');
const storage = require('../../utils/storage');
const srs = require('../../services/srs');
const speech = require('../../services/speech');
const sfx = require('../../services/sfx');

Page({
  data: {
    plan: null,
    modeList: [],
    passRateOptions: [60, 70, 80, 90],
    speechReady: false
  },

  onShow() {
    const plan = user.getPlan();
    this.setData({
      plan,
      speechReady: speech.isAvailable(),
      modeList: srs.MODE_KEYS.map((k) => {
        const m = srs.MODES[k];
        return { key: k, label: m.label, hint: m.hint, on: plan.modes.indexOf(k) >= 0 };
      })
    });
  },

  /* ===== 数值项 ===== */

  onNewCount(e) {
    this.save({ dailyNewCount: Number(e.detail.value) });
  },

  onReviewLimit(e) {
    this.save({ dailyReviewLimit: Number(e.detail.value) });
  },

  onPassModeCount(e) {
    this.save({ passModeCount: Number(e.detail.value) });
  },

  onMore() {
    const n = this.data.plan.passModeCount;
    this.save({ passModeCount: Math.min(n + 1, 4) });
  },

  onLess() {
    const n = this.data.plan.passModeCount;
    this.save({ passModeCount: Math.max(n - 1, 1) });
  },

  /* ===== 题型 ===== */

  toggleMode(e) {
    const key = e.currentTarget.dataset.key;
    const modes = this.data.plan.modes.slice();
    const i = modes.indexOf(key);
    if (i >= 0) {
      if (modes.length === 1) {
        wx.showToast({ title: '至少保留一种题型', icon: 'none' });
        return;
      }
      modes.splice(i, 1);
    } else {
      modes.push(key);
    }
    this.save({ modes });
  },

  /* ===== 抽查门槛 ===== */

  pickPassRate(e) {
    this.save({ passRate: Number(e.currentTarget.dataset.value) });
  },

  onStrict(e) {
    this.save({ strictMode: e.detail.value });
  },

  onAutoSpeak(e) {
    this.save({ autoSpeak: e.detail.value });
    if (e.detail.value) {
      // 打开时立刻读一个词，让用户确认有没有声音
      speech.speak('apple');
    }
  },

  onSfx(e) {
    const on = e.detail.value;
    this.save({ sfxOn: on });
    sfx.setEnabled(on);
    // 打开时立刻放一声，让用户当场确认音效通了没
    if (on) sfx.correct();
  },

  // 真机排查用：点了还听不到，就能确定是设备/静音的问题而不是代码没接上
  testSfx() {
    if (!this.data.plan.sfxOn) {
      this.save({ sfxOn: true });
      sfx.setEnabled(true);
      this.setData({ plan: Object.assign({}, this.data.plan, { sfxOn: true }) });
    }
    sfx.correct();
    wx.showToast({ title: '若没听到声音，请检查手机是否是静音/媒体音量为 0', icon: 'none', duration: 2600 });
  },

  /* ===== 保存 ===== */

  save(patch) {
    const plan = user.savePlan(patch);
    this.setData({
      plan,
      modeList: this.data.modeList.map((m) => Object.assign({}, m, { on: plan.modes.indexOf(m.key) >= 0 }))
    });
  },

  /* ===== 危险操作 ===== */

  clearData() {
    wx.showModal({
      title: '清除全部学习数据',
      content: '将删除书架、学习进度、错词本与打卡记录，不可恢复。确定继续？',
      confirmText: '清除',
      confirmColor: '#C0392B',
      success: (res) => {
        if (!res.confirm) return;
        storage.clearAll();
        this.onShow();
        wx.showToast({ title: '已清除', icon: 'success' });
      }
    });
  }
});
