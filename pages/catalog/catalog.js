const dict = require('../../services/dict');
const user = require('../../services/user');

Page({
  data: {
    publishers: [],
    grades: [],
    terms: ['上', '下'],
    filter: { publisher: '', grade: '', term: '' },
    textbooks: [],
    keyword: '',
    searchResults: [],
    searching: false,
    dictVersion: ''
  },

  onShow() {
    this.setData({ dictVersion: dict.getVersion() });
    this.refreshFilters();
    this.loadTextbooks();
  },

  refreshFilters() {
    this.setData({
      publishers: dict.getPublishers(),
      grades: dict.getGrades(this.data.filter.publisher)
    });
  },

  loadTextbooks() {
    const list = dict.getTextbooks(this.data.filter).map((t) => {
      const stats = user.getBookStats(t.id);
      return Object.assign({}, t, stats, { inShelf: user.isInShelf(t.id) });
    });
    this.setData({ textbooks: list });
  },

  /* ===== 筛选 ===== */

  pickPublisher(e) {
    const v = e.currentTarget.dataset.value;
    const filter = this.data.filter;
    filter.publisher = filter.publisher === v ? '' : v;
    // 切版本后年级可能不存在，重置
    filter.grade = '';
    this.setData({ filter });
    this.refreshFilters();
    this.loadTextbooks();
  },

  pickGrade(e) {
    const v = e.currentTarget.dataset.value;
    const filter = this.data.filter;
    filter.grade = String(filter.grade) === String(v) ? '' : v;
    this.setData({ filter });
    this.loadTextbooks();
  },

  pickTerm(e) {
    const v = e.currentTarget.dataset.value;
    const filter = this.data.filter;
    filter.term = filter.term === v ? '' : v;
    this.setData({ filter });
    this.loadTextbooks();
  },

  resetFilter() {
    this.setData({ filter: { publisher: '', grade: '', term: '' } });
    this.refreshFilters();
    this.loadTextbooks();
  },

  /* ===== 搜索 ===== */

  onKeyword(e) {
    const kw = e.detail.value;
    this.setData({ keyword: kw });
    if (!kw.trim()) {
      this.setData({ searching: false, searchResults: [] });
      return;
    }
    this.setData({
      searching: true,
      searchResults: dict.searchWords(kw, 50)
    });
  },

  clearSearch() {
    this.setData({ keyword: '', searching: false, searchResults: [] });
  },

  /* ===== 书架操作 ===== */

  addToShelf(e) {
    const id = e.currentTarget.dataset.id;
    const ok = user.addBook(id);
    if (ok) {
      wx.showToast({ title: '已加入书架', icon: 'success' });
    } else {
      wx.showToast({ title: '已在书架中', icon: 'none' });
    }
    this.loadTextbooks();
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    const t = dict.getTextbook(id);
    if (!t) return;
    const units = dict.getUnits(id).map((u) => {
      const words = dict.getWords(id).filter((w) => w.unitId === u.id);
      const map = user.getProgressMap();
      const learned = words.filter((w) => map[w.id]).length;
      return Object.assign({}, u, { learned, total: words.length });
    });
    const content = units.map((u) => u.order + '. ' + u.name + '（' + u.total + ' 词）').join('\n');
    wx.showModal({
      title: t.name,
      content: content || '暂无单元数据',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
