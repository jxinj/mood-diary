/**
 * 心晴手记 · 本地情绪分析引擎 (emotion-engine.js)
 * ------------------------------------------------------------
 * 设计思路（对应实验报告「技术原理」部分）：
 * 1. 情感词典法：内置正面 / 负面词及权重，对文本做情感极性打分；
 * 2. 情绪分类：按「喜悦 / 平静 / 焦虑 / 悲伤 / 愤怒 / 疲惫 / 感动」七类
 *    关键词库累加得分，取最高分作为主导情绪；
 * 3. 否定与程度处理：识别「不、没、很、非常、超级」等词，对极性做反转或增强；
 * 4. 生成式回应：依据主导情绪 + 用户自评心情分 + 强度，从回应模板库中
 *    组合出共情式回复与三条个性化建议。
 *
 * 该引擎完全在浏览器端运行，无需后端与 API Key，因此可直接部署到
 * GitHub Pages。若配置了大模型 API，app.js 会优先调用大模型生成回应。
 */
(function (global) {
  'use strict';

  /* ---------- 1. 情感词典（词 : 权重，正数为正向，负数为负向） ---------- */
  const SENTIMENT = {
    // 正向
    开心: 2, 快乐: 2, 高兴: 2, 开心极了: 3, 惊喜: 2, 兴奋: 2, 满足: 2, 幸福: 3,
    顺利: 2, 成功: 2, 通过: 2, 完成了: 2, 收获: 2, 进步: 2, 鼓励: 2, 感谢: 2,
    喜欢: 2, 爱: 2, 温暖: 2, 舒服: 1.5, 轻松: 1.5, 期待: 1.5, 好玩: 2, 有趣: 2,
    漂亮: 1.5, 棒: 2, 优秀: 2, 厉害: 2, 赞: 2, 美好: 2, 希望: 1.5, 加油: 1.5,
    治愈: 2, 感激: 2, 自豪: 2, 惊喜: 2, 幸运: 2, 放松: 1.5, 圆满: 2,
    // 负向
    难过: -2, 伤心: -2, 委屈: -2, 失落: -2, 沮丧: -2, 崩溃: -3, 想哭: -2.5,
    焦虑: -2, 紧张: -1.5, 压力: -2, 担心: -1.5, 害怕: -2, 慌: -2, 不安: -1.5,
    生气: -2, 愤怒: -2.5, 烦: -1.5, 讨厌: -2, 气死: -3, 不公平: -2,
    累: -1.5, 疲惫: -2, 疲倦: -2, 困: -1, 撑不住: -2.5, 熬夜: -1,
    失败: -2, 搞砸: -2.5, 被否: -2, 批评: -1.5, 出错: -1.5, 麻烦: -1.5,
    孤独: -2, 寂寞: -2, 没人: -1.5, 不想: -1.5, 无聊: -1.5, 空虚: -2,
    病: -1.5, 疼: -1.5, 难受: -2, 失眠: -2, 后悔: -2, 遗憾: -1.5,
  };

  /* ---------- 2. 七类情绪关键词库 ---------- */
  const EMOTION_LEXICON = {
    喜悦: ['开心', '快乐', '高兴', '幸福', '兴奋', '惊喜', '大笑', '哈哈', '太好了', '棒', '完美', '满意', '喜欢', '爱', '赞', '庆祝', '好运'],
    平静: ['平静', '安静', '还行', '一般', '正常', '淡淡', '平稳', '舒缓', ' relax', '放松', '悠闲', '慢慢', '照常', '习惯'],
    焦虑: ['焦虑', '紧张', '担心', '压力', '害怕', '慌', '不安', 'deadline', '考试', '面试', '面试', '完成不了', '来不及', '怎么办', '万一', '纠结', '忐忑'],
    悲伤: ['难过', '伤心', '委屈', '失落', '沮丧', '想哭', '哭', '遗憾', '后悔', '孤独', '寂寞', '想念', '告别', '离开', '失望', '心碎', 'emo'],
    愤怒: ['生气', '愤怒', '烦', '讨厌', '气死', '不公平', '凭什么', '无语', '气人', '恼火', '抓狂', '忍不了', '反感', '吐槽'],
    疲惫: ['累', '疲惫', '疲倦', '困', '熬夜', '撑不住', '没力气', '倦', '懒', '休息', '睡', '加班', '忙碌', ' verbose'],
    感动: ['感动', '温暖', '感谢', '感激', '谢谢', '被爱', '陪伴', '帮助', '支持', '鼓励', '泪目', '治愈', '贴心', '珍惜'],
  };

  const EMOTION_META = {
    喜悦: { emoji: '😄', color: '#e0a35c', label: '喜悦' },
    平静: { emoji: '😌', color: '#8fb39c', label: '平静' },
    焦虑: { emoji: '😰', color: '#c98a9d', label: '焦虑' },
    悲伤: { emoji: '😢', color: '#8ba6c4', label: '悲伤' },
    愤怒: { emoji: '😠', color: '#d97766', label: '愤怒' },
    疲惫: { emoji: '😮‍💨', color: '#a99bb5', label: '疲惫' },
    感动: { emoji: '🥹', color: '#d99b8e', label: '感动' },
  };

  /* ---------- 3. 程度副词与否定词 ---------- */
  const INTENSIFIERS = { 很: 1.5, 非常: 2, 特别: 2, 超级: 2.2, 太: 1.8, 极其: 2.5, 有点: 0.6, 稍微: 0.5, 略: 0.5 };
  const NEGATIONS = ['不', '没', '没有', '别', '无', '非', '未'];

  /* ---------- 4. 停用词（用于关键词提取） ---------- */
  const STOPWORDS = new Set([
    '今天', '现在', '这个', '那个', '我', '我们', '你', '他', '她', '它', '的', '了', '是', '在', '和', '与', '就', '都', '也', '还', '很', '有', '被', '把', '让', '给', '对', '从', '到', '而', '但', '因为', '所以', '如果', '虽然', '可以', '自己', '一个', '一些', '什么', '怎么', '真的', '感觉', '觉得', '有点', '一下', '一直', '已经', '可能', '只是', '这样', '那样',
  ]);

  /* ---------- 5. 共情回应模板库 ---------- */
  const REPLIES = {
    喜悦: [
      '读到你的文字，树洞也跟着亮了起来 🌤️。这份开心很值得被认真记住——不管是小事还是大喜，都说明你正在用心生活。',
      '太好了！你愿意把这份快乐写下来，它就像被保存进了一个小玻璃瓶。希望这份好心情能延续到接下来的日子里。',
    ],
    平静: [
      '平平淡淡的一天，也值得被记录。情绪不总是大风大浪，能安稳地过好"还行"的一天，本身就是一种能力 🍃。',
      '谢谢你在忙碌里停下来写几句。平静不是无聊，而是给自己留白的空间，树洞陪你一起慢慢呼吸。',
    ],
    焦虑: [
      '树洞感受到你心里那根弦绷得有点紧了 🫧。担心说明你在乎，但你也值得喘口气。把大事情拆成一小步一小步，先完成眼前最小的一件事就好。',
      '听起来脑子里有很多声音在同时说话。别急，你不需要一次解决全部。先深呼吸三次，把最担心的那一件写下来，我们一起看着它。',
    ],
    悲伤: [
      '读完你的文字，树洞想轻轻拍拍你的肩膀 🤍。难过不需要被"修好"，它可以只是被看见。你愿意写出来，已经很勇敢了。',
      '有些委屈是说不出口的，你愿意在这里放下，就很好。今天不必强迫自己振作，允许自己慢慢缓一缓也是一种照顾。',
    ],
    愤怒: [
      '气成这样，一定是有件事触碰到了你的底线 🔥。愤怒在提醒你：有些东西对你很重要。先让情绪落地，再决定怎么处理，不着急。',
      '树洞听见了你的不平。你不必立刻原谅或释怀，先承认"我确实很生气"，这本身就是一种诚实。',
    ],
    疲惫: [
      '感觉你像一块用了很久的电池，需要好好充充电了 🌙。累了不是懒，是身体在提醒你该歇一歇。今晚尽量早点睡，好不好？',
      '撑了很久吧？辛苦了。不是所有事都要今天做完，给自己一个"什么都不用做"的小小空隙，恢复了再出发。',
    ],
    感动: [
      '字里行间都是暖暖的 🥹。能被这样温柔地对待，说明你身边也有在意你的人。把这份感动收好，它会成为往日的底气。',
      '这份温暖透过屏幕都感受到了。记得也把这些善意传递下去，哪怕只是一个微笑、一句谢谢。',
    ],
  };

  /* ---------- 6. 建议库 ---------- */
  const SUGGESTIONS = {
    喜悦: [
      { t: '记录小确幸', d: '把今天开心的事写进"开心清单"，低落时翻出来看看。' },
      { t: '分享出去', d: '把好消息告诉一个你在意的人，快乐会加倍。' },
      { t: '给自己奖励', d: '用一件喜欢的小事庆祝一下，你值得。' },
    ],
    平静: [
      { t: '保持节奏', d: '顺着现在的节奏继续，不必刻意寻找波澜。' },
      { t: '五分钟正念', d: '闭上眼，只注意呼吸，让注意力回到此刻。' },
      { t: '整理小空间', d: '收拾一下桌面或房间，外面的秩序也会带来内心的安稳。' },
    ],
    焦虑: [
      { t: '拆解任务', d: '把最担心的事写成 3 个可执行的小步骤，只做第一步。' },
      { t: '4-7-8 呼吸', d: '吸气 4 秒、屏息 7 秒、呼气 8 秒，重复 3 轮。' },
      { t: '限定担忧时间', d: '告诉自己"我只担心 15 分钟"，时间到就先停下。' },
    ],
    悲伤: [
      { t: '允许自己难过', d: '情绪没有期限，想哭就哭，不必急着"正常起来"。' },
      { t: '找人说说话', d: '给信任的人发一条消息，哪怕只是"我今天有点难过"。' },
      { t: '做一件小事', d: '喝杯热水、晒晒太阳、出门走十分钟，让身体先动起来。' },
    ],
    愤怒: [
      { t: '先暂停六秒', d: '情绪上头时先深呼吸六次，给理性一点时间赶上来。' },
      { t: '写下来不发出', d: '把想说的话写在备忘录里，过一小时再决定要不要说。' },
      { t: '动一动身体', d: '快走、跑步或捶打枕头，让身体的紧张有出口。' },
    ],
    疲惫: [
      { t: '今晚早睡半小时', d: '把手机放远一点，给自己一个完整的睡眠周期。' },
      { t: '列"不做什么"清单', d: '划掉今天可以不做的事，先给精力减负。' },
      { t: '补充水分和阳光', d: '喝一大杯水，到窗边或户外待十分钟。' },
    ],
    感动: [
      { t: '写封感谢信', d: '把这份感动写下来发给对方，善意需要被回应。' },
      { t: '记录细节', d: '记下具体是哪一个瞬间打动了你，它会在以后反复温暖你。' },
      { t: '传递下去', d: '今天对一个人多一点耐心，让温暖流动起来。' },
    ],
  };

  /* ---------- 7. 情绪调节素材（工具箱使用） ---------- */
  const GROUNDING_STEPS = [
    { n: 5, sense: '看', tip: '说出你此刻能看到的 5 样东西：台灯、水杯、窗帘……越具体越好。' },
    { n: 4, sense: '触', tip: '感受 4 样能触摸到的东西，留意它们的温度和质地。' },
    { n: 3, sense: '听', tip: '仔细听，找出 3 种声音，哪怕很细微：风扇、键盘、自己的呼吸。' },
    { n: 2, sense: '闻', tip: '留意 2 种气味，或者你喜欢的两种味道。' },
    { n: 1, sense: '尝', tip: '感受 1 种味道。喝口水、含一颗糖，都算数。' },
  ];

  const CALM_QUOTES = [
    '情绪像天气，会来，也会走。你不需要赶走它，只要照顾好自己。',
    '你已经在很努力地生活了，偶尔停下来，不是落后。',
    '不必把今天过满分。喝水、呼吸、好好睡一觉，就已经很好。',
    '难过的时候，先照顾身体，再处理事情。顺序很重要。',
    '你不需要一个人扛着所有。说出来，本身就是一种松开。',
  ];

  /* ---------- 工具函数 ---------- */
  function countOccurrences(text, word) {
    if (!word || !word.trim()) return 0;
    let count = 0, pos = 0;
    while ((pos = text.indexOf(word, pos)) !== -1) { count++; pos += word.length; }
    return count;
  }

  /** 关键词提取：中文滑窗切词 + 停用词过滤（供分析与词云共用） */
  function extractKeywords(text, limit) {
    const freq = {};
    String(text || '').replace(/[，。！？、；：""''()\[\]{}《》\s\d.,!?;:"'-]/g, ' ').split(/\s+/).forEach((seg) => {
      for (let len = 4; len >= 2; len--) {
        for (let i = 0; i + len <= seg.length; i++) {
          const w = seg.slice(i, i + len);
          if (STOPWORDS.has(w)) continue;
          freq[w] = (freq[w] || 0) + 1;
        }
      }
    });
    return Object.entries(freq)
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit || 6)
      .map(([w]) => w);
  }

  /** 计算情感极性与关键词 */
  function analyzeSentiment(text) {
    let score = 0;
    let hitWords = [];
    const chars = text.split('');

    Object.keys(SENTIMENT).forEach((word) => {
      const count = countOccurrences(text, word);
      if (!count) return;
      let weight = SENTIMENT[word];
      const idx = text.indexOf(word);
      const prev2 = chars.slice(Math.max(0, idx - 2), idx).join('');
      const prev1 = idx > 0 ? chars[idx - 1] : '';

      // 否定词反转
      if (NEGATIONS.some((n) => prev2.includes(n))) weight = -weight * 0.8;
      // 程度副词增强 / 减弱
      Object.keys(INTENSIFIERS).forEach((adv) => {
        if (prev2.includes(adv)) weight *= INTENSIFIERS[adv];
      });
      score += weight * count;
      hitWords.push({ word, count, weight });
    });

    const keywords = extractKeywords(text, 6);
    // 补充情感命中词
    hitWords.slice(0, 3).forEach((h) => { if (!keywords.includes(h.word)) keywords.push(h.word); });

    return { score, hitWords, keywords: keywords.slice(0, 5) };
  }

  /** 主导情绪分类 */
  function classifyEmotion(text) {
    const scores = {};
    Object.entries(EMOTION_LEXICON).forEach(([emotion, words]) => {
      scores[emotion] = words.reduce((sum, w) => sum + countOccurrences(text, w), 0);
    });
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const top = sorted[0];
    const confidence = total > 0 ? Math.min(0.95, 0.45 + (top[1] / total) * 0.5) : 0.4;
    return {
      emotion: top[1] > 0 ? top[0] : '平静',
      confidence: top[1] > 0 ? confidence : 0.4,
      distribution: scores,
    };
  }

  /** 把情感极性映射到 1-5 分 */
  function scoreToLevel(raw, userScore) {
    let level = 3;
    if (raw > 4) level = 5;
    else if (raw > 1.5) level = 4;
    else if (raw > -1.5) level = 3;
    else if (raw > -4) level = 2;
    else level = 1;
    // 用户自评权重更大（60% 用户 + 40% 文本）
    return Math.max(1, Math.min(5, Math.round(level * 0.4 + userScore * 0.6)));
  }

  /** 主分析入口 */
  function analyze(text, userScore, intensity) {
    const textScore = analyzeSentiment(text || '');
    const cls = classifyEmotion(text || '');
    const level = scoreToLevel(textScore.score, userScore || 3);
    const meta = EMOTION_META[cls.emotion] || EMOTION_META['平静'];

    // 根据强度微调回应语气
    let reply = REPLIES[cls.emotion][Math.floor(Math.random() * REPLIES[cls.emotion].length)];
    if ((intensity || 3) >= 4) reply += '\n\n这份感受这么强烈，说明它对你很重要。如果愿意，可以再多写几句，树洞会一直听着。';
    if (level <= 2 && cls.emotion !== '悲伤' && cls.emotion !== '疲惫') {
      reply += '\n\n如果你愿意，也可以把它当作一次小小的休息——今天已经够努力了。';
    }

    return {
      emotion: cls.emotion,
      emoji: meta.emoji,
      color: meta.color,
      confidence: cls.confidence,
      polarity: textScore.score,
      score: level,
      keywords: textScore.keywords,
      reply,
      suggestions: SUGGESTIONS[cls.emotion],
      distribution: cls.distribution,
      method: 'local',
    };
  }

  /** 供大模型使用的系统提示词（app.js 调用 API 时传入） */
  function buildLLMPrompt(text, userScore, intensity, localResult) {
    return [
      { role: 'system', content: '你是一个温柔、专业的情绪陪伴助手"心晴手记"。请用中文回应，语气共情、具体、不说教，不提供医疗诊断，不鼓励自伤。先认可用户感受，再给出可操作的小建议。回答控制在 150 字以内。' },
      { role: 'user', content: '我今天的日记是：' + text + '\n我自评的心情分（1-5）：' + userScore + '\n情绪强度（1-5）：' + intensity + '\n本地引擎初步判断的情绪是：' + localResult.emotion + '\n请给出你的共情回应。' },
    ];
  }

  global.EmotionEngine = {
    analyze,
    buildLLMPrompt,
    extractKeywords,
    pickCalmQuote: () => CALM_QUOTES[Math.floor(Math.random() * CALM_QUOTES.length)],
    EMOTION_META,
    GROUNDING_STEPS,
    CALM_QUOTES,
    REPLIES,
    SUGGESTIONS,
    version: '1.1.0',
  };
})(window);
