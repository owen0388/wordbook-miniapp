const dict = require('../../../services/dict');
const user = require('../../../services/user');
const srs = require('../../../services/srs');
const speech = require('../../../services/speech');
const sfx = require('../../../services/sfx');

Page({
  data: {
    loading: true,
    phase: 'review',          // review | new | gate | finished
    phaseLabel: '',
    round: 1,

    // 当前题目
    kind: 'quiz',             // card | quiz
    mode: 'choice',
    modeLabel: '',
    modeHint: '',
    word: null,
    options: [],
    selected: '',
    input: '',
    answered: false,
    lastCorrect: false,
    correctAnswer: '',

    // 进度
    done: 0,
    total: 0,
    percent: 0,
    segWidth: 0,              // 复习段在整条进度里的宽度占比（用于分段上色）
    phaseNote: '',            // 「先复习 N 个，做完就学新词」这类结构提示
    sourceNote: '',           // 复习来源拆分：「昨天学的 8 个 · 到期 12 个」
    milestone: '',            // 中途飘一句「还剩多少」，2 秒后自动消失

    // 输入
    inputWarn: '',            // 英文题里输了中文时的即时提示

    // 复习抽查结果
    reviewCorrect: 0,
    reviewTotal: 0,
    reviewAccuracy: 0,
    passRate: 80,
    wrongCount: 0,

    // 战报
    report: null
  },

  onLoad(query) {
    this.queue = [];
    this.idx = 0;
    this.newItems = [];
    this.pendingByWord = {};
    this.newWordIds = [];
    this.stats = { reviewCorrect: 0, reviewTotal: 0, newCorrect: 0, newTotal: 0, wrongIds: [] };
    this.startTs = Date.now();
    this.round = 1;
    this.mode = (query && query.mode) || 'daily'; // daily | wrong
    speech.resetDedup();  // 新一轮学习，第一个词要能读出来

    this.build();
  },

  onUnload() {
    if (this._mt) clearTimeout(this._mt);
    if (!this.finished) this.flushLog(false);
    speech.destroy();   // 释放播放器，否则页面退出后仍在响
  },

  /* ============ 构建会话 ============ */

  build() {
    const session = this.mode === 'wrong'
      ? srs.buildWrongOnlyItems(30)
      : srs.buildSessionItems();
    this.isWrongOnly = this.mode === 'wrong';

    if (!session.hasShelf) {
      wx.showToast({ title: '请先选择教材', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    if (!session.reviewItems.length && !session.newItems.length) {
      wx.showToast({ title: this.isWrongOnly ? '错词本是空的' : '今日任务已完成', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    this.session = session;
    this.newItems = session.newItems;   // 拆分前的全量，用于统计每个词要过几道题
    this.setData({ passRate: session.plan.passRate });

    // 热身：同时有新词和复习时，把**前 3 个新词**提到复习之前。
    // 复习是最枯燥的抽查，新词才有新鲜感；把枯燥的全堆在开头，
    // 用户往往在最累的环节就退出了，永远到不了有趣的部分。
    // 只提 3 个（新词不足 6 个时不拆），既让有趣的部分提前，
    // 又不破坏「抽查过关才解锁新词」—— 3 个的量算尝鲜，不算解锁。
    let warmupItems = [];
    if (session.reviewItems.length && session.newItems.length >= 6) {
      const cut = this._cutAtWord(session.newItems, 3);
      warmupItems = session.newItems.slice(0, cut);
      session.newItems = session.newItems.slice(cut);
    }
    this.warmupItems = warmupItems;

    // 全局进度：复习块与新词块合并成一条。
    // 之前进度是按"当前阶段"算的，复习走完 20/20 后进新词块又从 1/60 开始，
    // 用户会以为"怎么又从头来、永远走不完"。合并成一条才符合直觉。
    this.grandTotal = session.reviewItems.length + session.newItems.length + warmupItems.length;
    this.grandDone = 0;
    this.reviewLen = session.reviewItems.length;

    // 统计每个新词需要答对几道题
    this.newItems.forEach((it) => {
      if (it.kind === 'new') {
        this.pendingByWord[it.wordId] = (this.pendingByWord[it.wordId] || 0) + 1;
      }
    });
    this.newWordIds = Object.keys(this.pendingByWord);

    if (warmupItems.length) {
      this.enterPhase('warmup', warmupItems);
    } else if (session.reviewItems.length) {
      this.enterPhase('review', session.reviewItems);
    } else {
      this.enterPhase('new', session.newItems);
    }
  },

  /**
   * 找出前 n 个词在条目数组里的切割位置。
   * newItems 是「词1卡、词1题、词1题、词2卡、…」这样按词连续排列的，
   * 所以要按 wordId 数到第 n+1 个词才开始切，不能简单按条数切。
   */
  _cutAtWord(items, n) {
    const seen = [];
    for (let i = 0; i < items.length; i++) {
      if (seen.indexOf(items[i].wordId) < 0) {
        seen.push(items[i].wordId);
        if (seen.length > n) return i;
      }
    }
    return items.length;
  },

  enterPhase(phase, items) {
    this.queue = items.slice();
    this.idx = 0;
    this.phase = phase;

    // 复习段在整条进度里的占比。只在复习阶段展示：
    // 进入新词段后，剩余的整段都是新词，不需要再分色。
    const segWidth = (phase === 'review' && this.grandTotal)
      ? Math.round((items.length / this.grandTotal) * 100)
      : 0;

    let label = this.isWrongOnly ? '错词专项'
      : phase === 'warmup' ? '先看几个新词'
        : phase === 'review' ? '抽查复习' : '新词学习';

    this.setData({
      loading: false,
      phase,
      phaseLabel: label,
      phaseNote: this._phaseNote(phase, items.length),
      sourceNote: (phase === 'review' && this.round === 1) ? this._sourceNote(items.length) : '',
      total: this.grandTotal,
      done: this.grandDone,
      percent: this._percent(),
      segWidth,
      round: this.round
    });
    this.render();
  },

  /**
   * 复习词的来源拆分。
   * 用户之前反馈"复习里冒出大量没见过的词"，本质是两种来源混在一个数字里：
   * 昨天刚学的（理应抽查）和更早该复习的（算法排期）。拆开显示，
   * 用户才知道每个词为什么在这儿，而不是怀疑数据错乱。
   */
  _sourceNote(shown) {
    const f = this.session && this.session.reviewFrom;
    if (!f || !f.total) return '';
    const parts = [];
    if (f.yesterdayNew) parts.push('昨天学的 ' + f.yesterdayNew + ' 个');
    if (f.due) parts.push('到期该复习的 ' + f.due + ' 个');
    if (!parts.length) return '';
    const head = '这 ' + shown + ' 个里有 ' + parts.join('、');
    return f.total > shown ? head + '（共 ' + f.total + ' 个，今天先做一部分）' : head;
  },

  /** 全局完成百分比（跨阶段累计，不随阶段重置） */
  _percent() {
    const total = Math.max(this.grandTotal, 1);
    return Math.min(100, Math.round((this.grandDone / total) * 100));
  },

  /**
   * 顶部那句结构提示。
   * 目的是把"还剩什么"提前告诉用户 —— 知道后面是新词，比看见任何动效都提气。
   */
  _phaseNote(phase, count) {
    if (this.isWrongOnly) return '只做错词，做完就结束';

    const rest = (this.session && this.session.newItems.length) || 0;

    if (phase === 'warmup') return '这几个学完，接着复习昨天和到期的词';
    if (phase === 'review') {
      if (this.round > 1) return `再巩固这 ${count} 个错词`;
      return rest ? `复习 ${count} 个，之后还有 ${rest} 个新词` : '今天只复习，没有新词';
    }
    return rest ? `最后一段了，新词 ${rest} 个` : '最后一段了';
  },

  /* ============ 渲染当前条目 ============ */

  render() {
    if (this.idx >= this.queue.length) return this.endPhase();

    const item = this.queue[this.idx];
    const word = dict.getWord(item.wordId);
    if (!word) { this.idx++; return this.render(); }

    const isCard = item.kind === 'card';
    const mode = item.mode || 'choice';
    const meta = srs.MODES[mode] || srs.MODES.choice;

    let options = [];
    if (!isCard && mode === 'choice') {
      // 干扰项优先从"自己答错过的词"里挑 —— 那是最真实的混淆证据。
      // 错词本每次重算太浪费，本轮会话缓存一次。
      if (!this._wrongIds) {
        this._wrongIds = user.getWrongList().map((w) => w.id);
      }
      options = srs.buildChoiceOptions(word, dict.getWords(this._bookOf(item)), this._wrongIds);
    }

    // 只有"题面是英文"的题才给喇叭并自动朗读。
    // 拼写 / 中译英的题面是中文，这时候读出英文等于直接给答案。
    const showSpeak = isCard || mode === 'en2cn' || mode === 'choice';

    // 记下本题开始时间，答完后算耗时写进复习明细（FSRS 的参考量）
    this._qStart = Date.now();

    this.setData({
      kind: isCard ? 'card' : 'quiz',
      mode,
      modeLabel: meta.label,
      modeHint: meta.hint,
      word,
      options,
      selected: '',
      input: '',
      answered: false,
      lastCorrect: false,
      correctAnswer: '',
      showSpeak,
      canSpeak: speech.hasAudio(word.word, this._bookOf(item))
    }, () => {
      if (showSpeak && this._autoSpeakOn()) {
        // 用 speakOnce：同一个词的后续题目不再重复播，避免"读重了"
        speech.speakOnce(word.word, this._bookOf(item));
      }
    });
  },

  _autoSpeakOn() {
    return user.getPlan().autoSpeak !== false;
  },

  onSpeak() {
    sfx.tap();
    const w = this.data.word;
    const item = this.queue[this.idx];
    if (w && w.word) speech.speak(w.word, item ? this._bookOf(item) : '');
  },

  _bookOf(item) {
    if (item.textbookId) return item.textbookId;
    const w = dict.getWord(item.wordId);
    if (w && w.textbookId) return w.textbookId;
    const primary = user.getPrimaryBook();
    return primary ? primary.textbookId : '';
  },

  /* ============ 交互 ============ */

  // 学习卡：记住了，去做题
  onCardNext() {
    sfx.tap();
    this.idx++;
    this.bumpProgress();
    this.render();
  },

  /**
   * 输入框内容变化。
   *
   * 英文题（中译英 / 拼写）只接受英文字母：中文、数字、符号直接丢掉。
   * 这是"限制输入框"能做到的最强效果 —— 小程序没有切换系统输入法的 API，
   * 但"打不进去"比任何文案提示都清楚：用户一敲中文发现没反应，自然切回英文键盘。
   * 中文题（英译中）反过来没法强制，只能靠 placeholder 说清楚。
   */
  onInput(e) {
    const item = this.queue[this.idx];
    const mode = item && item.mode;
    const raw = (e && e.detail && e.detail.value !== undefined && e.detail.value !== null)
      ? String(e.detail.value) : '';

    if (mode === 'cn2en' || mode === 'spell') {
      const cleaned = srs.sanitizeEnInput(raw);
      if (cleaned !== raw) {
        this.setData({ input: cleaned, inputWarn: '这一题只能填英文字母' });
        if (this._wt) clearTimeout(this._wt);
        this._wt = setTimeout(() => this.setData({ inputWarn: '' }), 2000);
        return;
      }
    }

    this.setData({ input: raw, inputWarn: '' });
  },

  onPickOption(e) {
    if (this.data.answered) return;
    const val = e.currentTarget.dataset.value;
    this.submit(val);
  },

  onSubmitInput() {
    if (this.data.answered) return;
    const v = this.data.input;
    if (!String(v).trim()) {
      wx.showToast({ title: '请输入答案', icon: 'none' });
      return;
    }
    this.submit(v);
  },

  submit(answer) {
    const item = this.queue[this.idx];
    const word = this.data.word;
    const correct = srs.judge(item.mode, word, answer);

    // 音效必须在用户手势的同一个同步调用栈里触发。
    // 真机上音频播放需要"用户激活"上下文，放进 setData 回调或 setTimeout
    // 里会被判定为非用户触发，iOS 直接静音（这是很常见的隐形坑）。
    if (correct) sfx.correct(); else sfx.wrong();

    // 写入记忆状态（耗时与题型一并记录，供 FSRS 与后续复盘使用）
    const ms = this._qStart ? Date.now() - this._qStart : 0;
    srs.applyAnswer(item.wordId, correct, this._bookOf(item), { ms, mode: item.mode });

    if (item.kind === 'review') {
      this.stats.reviewTotal++;
      if (correct) this.stats.reviewCorrect++;
    } else {
      this.stats.newTotal++;
      if (correct) {
        this.stats.newCorrect++;
        this.pendingByWord[item.wordId] = (this.pendingByWord[item.wordId] || 1) - 1;
        if (this.pendingByWord[item.wordId] <= 0) {
          // 该词全部题型通过 —— 计入"已学"，明天进入抽查队列
          user.initWordProgress(item.wordId, this._bookOf(item));
        }
      }
    }

    if (!correct) {
      this.stats.wrongIds.push(item.wordId);
    }

    this.setData({
      answered: true,
      selected: typeof answer === 'string' ? answer : '',
      lastCorrect: correct,
      correctAnswer: item.mode === 'choice' ? word.meaningCn : word.word
    });

    // 答完补读一次，但只在"题面是中文、本题还没读过"时补。
    // 英文题面（新词卡 / 英译中 / 词义选择）已经读过这个词了，再读就是重复。
    if (this._autoSpeakOn() && !this.data.showSpeak) {
      speech.speakOnce(word.word, this._bookOf(item));
    }
  },

  // 反馈面板：继续
  onContinue() {
    sfx.tap();
    const item = this.queue[this.idx];
    const wasCorrect = this.data.lastCorrect;

    if (!wasCorrect && item.kind === 'new') {
      // 新词答错：回到本轮队尾重来（pendingByWord 不变，所以该词仍算未过关）
      this.queue.push({
        kind: 'new',
        wordId: item.wordId,
        textbookId: item.textbookId,
        mode: srs.pickModes(1, this.session.plan)[0]
      });
      // 总量跟着涨一屏，否则进度条会在还剩题时提前走满
      this.grandTotal += 1;
    }

    this.idx++;
    this.bumpProgress();
    this.render();
  },

  bumpProgress() {
    this.grandDone += 1;
    const patch = {
      done: this.grandDone,
      total: this.grandTotal,
      percent: this._percent()
    };

    // 中途鼓励：每 10 屏飘一句，只说"走到哪了"，不打断答题。
    // 之前这里写的是「已过 10 个 · 还剩 20」这种冷冰冰的进度，
    // 真机上又小又短，几乎注意不到；改成一句有温度的话并放大字号。
    const remain = this.grandTotal - this.grandDone;
    if (this.grandDone > 0 && this.grandDone % 10 === 0 && remain > 0) {
      patch.milestone = this._encourage(this.grandDone, remain);
      this._flashMilestone();
    }

    this.setData(patch);
  },

  /** 按进度给一句鼓励，不浮夸、不虚假 —— 真有进度才夸 */
  _encourage(done, remain) {
    const pct = Math.round((done / Math.max(this.grandTotal, 1)) * 100);
    if (pct >= 80) return '就剩 ' + remain + ' 个了，收个尾';
    if (pct >= 50) return '过半了，还剩 ' + remain + ' 个';
    if (pct >= 25) return '已经 ' + done + ' 个了，节奏不错';
    return '开了个头，' + done + ' 个了';
  },

  _flashMilestone() {
    if (this._mt) clearTimeout(this._mt);
    this._mt = setTimeout(() => this.setData({ milestone: '' }), 2600);
  },

  /* ============ 阶段切换 ============ */

  endPhase() {
    if (this.phase === 'warmup') {
      // 热身的几个新词做完，接着抽查；没有复习就直接学剩下的
      if (this.session.reviewItems.length) {
        return this.enterPhase('review', this.session.reviewItems);
      }
      return this.enterPhase('new', this.session.newItems);
    }

    if (this.phase === 'review') {
      const total = this.stats.reviewTotal || 0;
      const acc = total ? Math.round((this.stats.reviewCorrect / total) * 100) : 100;

      const blocked = this.session.plan.strictMode
        && acc < this.session.plan.passRate
        && this.session.newItems.length > 0;

      if (blocked && this.round < 3) {
        return this.setData({
          phase: 'gate',
          reviewCorrect: this.stats.reviewCorrect,
          reviewTotal: total,
          reviewAccuracy: acc
        });
      }

      if (this.session.newItems.length) {
        this.round = 1;
        return this.enterPhase('new', this.session.newItems);
      }
      return this.finish();
    }

    return this.finish();
  },

  // 抽查未过关：再巩固一轮错词
  onRetry() {
    sfx.tap();
    const wrongIds = this.stats.wrongIds.slice();
    const seen = {};
    const items = [];
    wrongIds.forEach((id) => {
      if (seen[id]) return;
      seen[id] = 1;
      items.push({
        kind: 'review',
        wordId: id,
        textbookId: (dict.getWord(id) || {}).textbookId || '',
        mode: srs.pickModes(1, this.session.plan)[0]
      });
    });
    if (!items.length) return this.finish();

    // 巩固轮也要计入全局总量，否则进度条会倒退
    this.grandTotal += items.length;
    this.reviewLen = items.length;
    this.round++;
    this.stats.reviewCorrect = 0;
    this.stats.reviewTotal = 0;
    this.stats.wrongIds = [];
    this.enterPhase('review', items);
  },

  // 抽查未过关：今天先到这里，不学新词
  onSkipNew() {
    sfx.tap();
    this.finish();
  },

  /* ============ 结算 ============ */

  finish() {
    this.finished = true;
    const newPassed = this.newWordIds.filter((id) => (this.pendingByWord[id] || 0) <= 0).length;
    const durationSec = Math.round((Date.now() - this.startTs) / 1000);

    this.flushLog(true, durationSec);

    const log = user.getLog();
    const overall = user.getOverallStats();
    const report = {
      reviewTotal: this.stats.reviewTotal,
      reviewCorrect: this.stats.reviewCorrect,
      newPassed,
      wrongCount: this.stats.wrongIds.length,
      durationText: this.formatDuration(durationSec),
      streak: user.getStreak(),
      // 战报用的两个"讲故事"数据：累计记住了多少、最久的一个多久没忘
      mastered: overall.mastered,
      longestDays: user.getLongestRememberedDays(),
      finishedTask: !!(log && log.finished)
    };

    wx.redirectTo({
      url: '/pages/study/result/result?data=' + encodeURIComponent(JSON.stringify(report))
    });
  },

  flushLog(finished, durationSec) {
    if (this._flushed) return;
    this._flushed = true;
    // 错词专项属于额外练习，不计入当日任务日志，避免影响打卡判定
    if (this.isWrongOnly) return;
    const newPassed = this.newWordIds.filter((id) => (this.pendingByWord[id] || 0) <= 0).length;
    user.addLog(null, {
      newCount: newPassed,
      reviewCount: this.stats.reviewTotal,
      correct: this.stats.reviewCorrect + this.stats.newCorrect,
      wrong: this.stats.wrongIds.length,
      durationSec: durationSec || 0
    }, finished);
  },

  formatDuration(sec) {
    if (sec < 60) return sec + ' 秒';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ' 分 ' + s + ' 秒';
  }
});
