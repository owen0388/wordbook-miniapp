const user = require('../../services/user');

Page({
  data: {
    books: []
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const books = user.getBookshelf().map((b) => {
      const s = user.getBookStats(b.textbookId);
      return Object.assign({}, b, s);
    });
    this.setData({ books });
  },

  setPrimary(e) {
    user.setPrimary(e.currentTarget.dataset.id);
    this.refresh();
    wx.showToast({ title: '已设为主学教材', icon: 'none' });
  },

  moveUp(e) {
    if (user.moveBook(e.currentTarget.dataset.id, -1)) this.refresh();
  },

  moveDown(e) {
    if (user.moveBook(e.currentTarget.dataset.id, 1)) this.refresh();
  },

  remove(e) {
    const id = e.currentTarget.dataset.id;
    const book = this.data.books.find((b) => b.textbookId === id);
    wx.showModal({
      title: '移出书架',
      content: '将「' + (book ? book.name : '') + '」移出书架？\n你的学习进度会保留，重新加入后可继续。',
      confirmText: '移出',
      confirmColor: '#C0392B',
      success: (res) => {
        if (!res.confirm) return;
        user.removeBook(id);
        this.refresh();
        wx.showToast({ title: '已移出书架', icon: 'none' });
      }
    });
  },

  goCatalog() {
    wx.switchTab({ url: '/pages/catalog/catalog' });
  }
});
