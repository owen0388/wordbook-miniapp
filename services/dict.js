/**
 * 词库访问层（只读）
 *
 * 这是整个项目唯一的"取词"入口。页面和业务逻辑都不要直接 require 词库文件，
 * 一律走这里 —— 将来词库从"打进包"改成"云端下载"，只需改本文件，页面代码零改动。
 *
 * 当前实现：直接读取构建产物 assets/dict/bundle.js（scripts/build-dict.mjs 生成）。
 * 换云端时把 _load() 换成 wx.cloud.downloadFile + 本地文件缓存即可。
 */

const RAW = require('../assets/dict/bundle.js');

let _cache = null;     // 归一化后的词库（每个词条带上 textbookId）
let _wordIndex = null; // wordId -> word，惰性构建

/**
 * 归一化词库：给每个词条补上 textbookId，
 * 这样从 wordId 就能直接反查所属教材，统计与错词本都用得上。
 */
function _load() {
  if (_cache) return _cache;
  const words = {};
  const rawWords = RAW.words || {};
  Object.keys(rawWords).forEach((bookId) => {
    words[bookId] = rawWords[bookId].map((w) => (w.textbookId ? w : Object.assign({ textbookId: bookId }, w)));
  });
  _cache = {
    version: RAW.version,
    textbooks: RAW.textbooks || [],
    units: RAW.units || {},
    words
  };
  return _cache;
}

/** 构建 wordId 索引（同一个单词跨教材共享同一个 id） */
function _index() {
  if (_wordIndex) return _wordIndex;
  _wordIndex = {};
  const words = _load().words;
  Object.keys(words).forEach((bookId) => {
    words[bookId].forEach((w) => {
      if (!_wordIndex[w.id]) _wordIndex[w.id] = w;
    });
  });
  return _wordIndex;
}

/** 词库版本号，用于将来做缓存失效判断 */
function getVersion() {
  return _load().version;
}

/** 筛选教材。filters: { publisher, grade, term } 任意项可省略 */
function getTextbooks(filters) {
  const f = filters || {};
  return (_load().textbooks || []).filter((t) =>
    (!f.publisher || t.publisher === f.publisher) &&
    (!f.grade || Number(t.grade) === Number(f.grade)) &&
    (!f.term || t.term === f.term)
  );
}

function getTextbook(textbookId) {
  return (_load().textbooks || []).find((t) => t.id === textbookId) || null;
}

/** 取某本教材的全部教材列表里的版本名（供筛选器用） */
function getPublishers() {
  const set = {};
  (_load().textbooks || []).forEach((t) => { if (t.publisher) set[t.publisher] = 1; });
  return Object.keys(set);
}

/** 取某本教材的年级列表 */
function getGrades(publisher) {
  const set = {};
  getTextbooks(publisher ? { publisher } : null).forEach((t) => { set[t.grade] = 1; });
  return Object.keys(set).map(Number).sort((a, b) => a - b);
}

/** 单元列表 */
function getUnits(textbookId) {
  return ((_load().units || {})[textbookId] || []).slice();
}

/** 某本教材的全部词条（按单元、词序排列） */
function getWords(textbookId) {
  return ((_load().words || {})[textbookId] || []).slice();
}

function getWord(wordId) {
  return _index()[wordId] || null;
}

/** 按 id 批量取词 */
function getWordsByIds(ids) {
  const idx = _index();
  return ids.map((id) => idx[id]).filter(Boolean);
}

/**
 * 关键词检索：命中英文拼写或中文释义。
 * limit 默认 50，避免一次性渲染过多节点。
 */
function searchWords(keyword, limit) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const max = limit || 50;
  const out = [];
  const texts = _load().textbooks || [];
  texts.forEach((t) => {
    const words = (_load().words || {})[t.id] || [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.word.toLowerCase().indexOf(kw) >= 0 || w.meaningCn.indexOf(kw) >= 0) {
        out.push(Object.assign({ textbookId: t.id, textbookName: t.name }, w));
        if (out.length >= max) return;
      }
    }
  });
  return out;
}

/** 全库去重后的单词总数 */
function getTotalWordCount() {
  return Object.keys(_index()).length;
}

module.exports = {
  getVersion,
  getTextbooks,
  getTextbook,
  getPublishers,
  getGrades,
  getUnits,
  getWords,
  getWord,
  getWordsByIds,
  searchWords,
  getTotalWordCount
};
