/**
 * 单词朗读服务（本地音频版）
 *
 * 音频由 scripts/build-audio.py 预先生成：
 *   微软神经语音 en-US-AriaNeural（语速 -15%）→ 24kHz/32kbps 单声道 → 去首尾静音
 *   输出 assets/audio/<textbookId>/<word>.mp3，随小程序包分发
 *
 * 为什么不用微信同声传译插件：
 *   该插件类目为「IT科技 > 软件服务提供商」，个人主体小程序没有此类目，
 *   在后台根本搜不到、也加不了。预生成 mp3 反而更优：
 *   离线可用、无调用配额、音质固定、不受插件停服或审核政策影响。
 *
 * 为什么不用「云端按需合成」：
 *   需要后端与域名备案，且每次播放都有网络延迟；单词音频体积极小（约 2.5KB/词），
 *   全部预置进包只有 1.2MB 左右，一次下载永久离线。
 */

const manifest = require('../assets/audio/manifest.js');

let _audio = null;
const _sets = {};   // textbookId → { 音频名: 1 }

/** 词 → 音频文件名（不含扩展名）。必须与 scripts/build-audio.py 的 audio_name 完全一致 */
function audioName(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function setOf(textbookId) {
  if (!_sets[textbookId]) {
    const map = {};
    (manifest[textbookId] || []).forEach((w) => { map[audioName(w)] = 1; });
    _sets[textbookId] = map;
  }
  return _sets[textbookId];
}

/** 该词是否备有音频（没有就静默跳过，不产生报错） */
function hasAudio(word, textbookId) {
  if (!textbookId) return false;
  return !!setOf(textbookId)[audioName(word)];
}

/** 包内音频路径 */
function srcOf(word, textbookId) {
  const name = audioName(word);
  if (!name || !hasAudio(word, textbookId)) return '';
  return `/assets/audio/${textbookId}/${name}.mp3`;
}

/** 是否具备发音能力（有任何一本带音频即视为可用） */
function isAvailable() {
  const keys = Object.keys(manifest);
  for (let i = 0; i < keys.length; i++) {
    if (manifest[keys[i]] && manifest[keys[i]].length) return true;
  }
  return false;
}

function ensureAudio() {
  if (!_audio) {
    _audio = wx.createInnerAudioContext();
    // 学习场景下静音键不该让发音失效，否则孩子以为坏了
    _audio.obeyMuteSwitch = false;
    _audio.onError(() => { /* 个别词缺音频时静默，不影响答题 */ });
  }
  return _audio;
}

/**
 * 朗读一个单词
 * @param {string} word       单词本身
 * @param {string} textbookId 教材 id（音频按教材分目录存放）
 */
function speak(word, textbookId) {
  const src = srcOf(word, textbookId);
  if (!src) return;
  const a = ensureAudio();
  try { a.stop(); } catch (e) { /* 未播放过时 stop 会抛错 */ }
  a.src = src;
  a.play();
}

/* 自动朗读的闸门：同一个词只读一次。
 * 一个新词会连续出「卡片 → 词义选择 → 中译英 → 拼写」好几道题，
 * 逐题播放就是复读机——孩子听到的是一遍遍重复，而不是新的信息。
 * 手动点喇叭走 speak()，不受这道闸门限制：想听就一定给他听。 */
let _lastSpoken = '';

function speakOnce(word, textbookId) {
  const key = audioName(word) + '|' + (textbookId || '');
  if (!key) return;
  if (key === _lastSpoken) return;
  _lastSpoken = key;
  speak(word, textbookId);
}

/** 新一轮学习开始时调用，让第一个词总能读出来 */
function resetDedup() {
  _lastSpoken = '';
}

/** 兼容旧接口：本地音频无需预取，保留空实现避免调用方报错 */
function prefetch() {}

function stop() {
  if (_audio) {
    try { _audio.stop(); } catch (e) { /* 忽略 */ }
  }
}

function destroy() {
  if (_audio) {
    try { _audio.destroy(); } catch (e) { /* 忽略 */ }
    _audio = null;
  }
}

module.exports = {
  isAvailable,
  hasAudio,
  speak,
  speakOnce,
  resetDedup,
  prefetch,
  stop,
  destroy
};
