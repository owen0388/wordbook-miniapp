const user = require('../../services/user');

Page({
  data: {
    list: [],
    total: 0
  },

  onShow() {
    const list = user.getWrongList();
    this.setData({ list, total: list.length });
  },

  startWrongOnly() {
    if (!this.data.total) {
      wx.showToast({ title: '错词本是空的', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/study/session/session?mode=wrong' });
  },

  removeOne(e) {
    const id = e.currentTarget.dataset.id;
    user.clearWrong(id);
    this.onShow();
    wx.showToast({ title: '已移出错词本', icon: 'none' });
  },

  clearAll() {
    wx.showModal({
      title: '清空错词本',
      content: '将移除全部错词记录，不影响已学进度。确定继续？',
      confirmText: '清空',
      confirmColor: '#C0392B',
      success: (res) => {
        if (!res.confirm) return;
        this.data.list.forEach((w) => user.clearWrong(w.id));
        this.onShow();
        wx.showToast({ title: '已清空', icon: 'success' });
      }
    });
  }
});
