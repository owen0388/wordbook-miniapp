/**
 * 答题音效服务（小程序端）
 * ============================================================
 * 背景：浏览器预览版用 Web Audio 实时合成，小程序端此前**完全没有音效实现**，
 * 导致"电脑上听得见、手机上没声音"。这里改成预置 mp3 + innerAudioContext。
 *
 * 为什么不直接照搬浏览器的 Web Audio：
 *   1) wx.createWebAudioContext 需要基础库 2.19.0+，低版本直接没有这个 API，
 *      且没有可用的降级路径 → 老机型/旧微信上永远静音
 *   2) AudioContext 首次必须在用户手势中 resume，页面 onShow 里创建会停在
 *      suspended，表现为"第一次不响、第二次才响"
 *   3) iOS 上 Web Audio 是否受系统静音拨片影响，官方文档没有结论，行为不稳定
 *
 * 真机静音的三个真凶（按出现频率）：
 *   ① 手机侧面的静音拨片：innerAudioContext 默认 obeyMuteSwitch = true，
 *      拨到静音档后连单词朗读也一起哑掉。→ 显式设成 false
 *   ② 音效实例被 gc / 重复 play 未 stop：表现为只有第一声有效。
 *      → 每种音效固定一个实例池，stop() 后再 play()
 *   ③ 微信整体音量走"媒体音量"而非"铃声音量"，某些安卓机媒体音量为 0。
 *      → 这个代码救不了，只能提示用户；因此额外配了震动反馈做兜底
 */

/* 每种音效的实例数。总数控制在 6 个以内：
 * innerAudioContext 同时存在的实例数在部分机型上有上限（约 10 个），
 * 单词朗读还要占 1 个，留足余量。 */
const POOL = {
  tap: 1,
  correct: 2,
  wrong: 2,
  finish: 1
};

const SRC = {
  tap: '/assets/sfx/tap.mp3',
  correct: '/assets/sfx/correct.mp3',
  wrong: '/assets/sfx/wrong.mp3',
  finish: '/assets/sfx/finish.mp3'
};

let _on = true;        // 用户开关（学习计划 → 答题音效）
let _inited = false;
let _pools = {};       // name -> [InnerAudioContext]
let _cursor = {};      // name -> 轮询下标
let _optApplied = false;

/* ============ 全局音频选项 ============ */

/**
 * 关键一步：让音频在手机静音档下也能出声。
 * 单词朗读与答题音效都受益——孩子以为"坏了"的情况，九成是这里。
 * 只调用一次；失败也不影响功能（只是继续遵循静音开关）。
 */
function applyGlobalOption() {
  if (_optApplied) return;
  _optApplied = true;
  try {
    if (typeof wx.setInnerAudioOption === 'function') {
      wx.setInnerAudioOption({
        obeyMuteSwitch: false,   // 不遵循系统静音（iOS）
        mixWithOther: true,      // 不打断用户正在听的音乐/播客
        success() {},
        fail() {}
      });
    }
  } catch (e) { /* 低版本基础库无此 API，忽略 */ }
}

/* ============ 实例池 ============ */

function poolOf(name) {
  if (_pools[name]) return _pools[name];
  const n = POOL[name] || 1;
  const list = [];
  for (let i = 0; i < n; i++) {
    try {
      const a = wx.createInnerAudioContext();
      a.src = SRC[name];
      a.obeyMuteSwitch = false;   // 单个实例再设一次，双保险
      a.volume = 1;
      // 错误一律吞掉：音效只是锦上添花，绝不能让它影响答题
      a.onError(() => {});
      list.push(a);
    } catch (e) { /* 创建失败则跳过 */ }
  }
  _pools[name] = list;
  _cursor[name] = 0;
  return list;
}

/* ============ 对外接口 ============ */

/** 初始化（App.onLaunch 调一次即可，重复调用无副作用） */
function init() {
  if (_inited) return;
  _inited = true;
  applyGlobalOption();
  // 预创建全部实例：真机上首次 play 才建实例会有几十毫秒加载延迟，
  // 表现为"点了没声，过一会儿才响"，听起来像坏了。
  Object.keys(SRC).forEach((name) => poolOf(name));
}

/** 开关（跟随「学习计划 → 答题音效」） */
function setEnabled(on) {
  _on = !!on;
}

function isEnabled() {
  return _on;
}

/**
 * 播放音效
 * @param {'tap'|'correct'|'wrong'|'finish'} name
 */
function play(name) {
  if (!_on) return;
  if (!SRC[name]) return;
  if (!_inited) init();

  const list = _pools[name] || poolOf(name);
  if (!list.length) return;

  // 轮流使用实例：连续快速点击时避免"上一声还没放完就打断自己"
  const i = (_cursor[name] = ((_cursor[name] || 0) + 1) % list.length);
  const a = list[i];
  try {
    a.stop();      // 同一实例重复 play 前必须 stop，否则部分机型不响应
    a.play();
  } catch (e) { /* 忽略 */ }
}

/** 轻震动：静音/音量为 0 时唯一的反馈通道，也是"手感"的一部分 */
function vibrate(kind) {
  if (!_on) return;
  try {
    if (typeof wx.vibrateShort !== 'function') return;
    wx.vibrateShort({ type: kind === 'wrong' ? 'medium' : 'light' });
  } catch (e) { /* 忽略 */ }
}

/** 答对：音效 + 轻震 */
function correct() {
  play('correct');
  vibrate('correct');
}

/** 答错：更轻的音效 + 更短的震动 */
function wrong() {
  play('wrong');
  vibrate('wrong');
}

function tap() {
  play('tap');
}

function finish() {
  play('finish');
}

function destroy() {
  Object.keys(_pools).forEach((name) => {
    _pools[name].forEach((a) => {
      try { a.destroy(); } catch (e) { /* 忽略 */ }
    });
  });
  _pools = {};
  _cursor = {};
  _inited = false;
}

module.exports = {
  init,
  setEnabled,
  isEnabled,
  play,
  correct,
  wrong,
  tap,
  finish,
  vibrate,
  destroy
};
