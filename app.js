const storage = require('./utils/storage');
const sfx = require('./services/sfx');
const user = require('./services/user');

App({
  globalData: {
    // 本次学习会话结束后的战报，供结算页读取
    lastSession: null
  },

  onLaunch() {
    // 本地数据结构版本迁移，结构升级时在这里做就地转换
    storage.migrate();

    // 预建音效实例：放到 onLaunch 而不是首次播放时，
    // 避免真机第一次点按钮才开始加载，出现"晚半拍"的空窗感
    try {
      sfx.init();
      sfx.setEnabled(user.getPlan().sfxOn !== false);
    } catch (e) { /* 音效不可用不影响主流程 */ }
  },

  onShow() {
    // 跨天后 CHECK：把 nextReviewAt 到期的词暴露给首页
    storage.rolloverIfNeeded();
    // 用户在「学习计划」里改过开关后，回到前台要立即生效
    try { sfx.setEnabled(user.getPlan().sfxOn !== false); } catch (e) { /* 忽略 */ }
  }
});
