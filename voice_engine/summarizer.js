/**
 * dsh-girl-live2d - voice_engine/summarizer.js
 * 
 * 核心逻辑：语音不需要完整复述长文，而是提取伴侣视角的「概括性回复与口播点评」
 * 严格控制在 2 句话、80 字以内，让 TTS 朗读清爽自然，拒绝长篇大论背诵代码。
 */

export function extractCompanionVoiceText(rawText, characterId = 'whale') {
  if (!rawText || typeof rawText !== 'string') return ''

  // 1. 彻底剔除思考链和不可读语法块（支持未闭合流式思考）
  let text = rawText
    .replace(/<\s*(?:think|thought|reasoning|analysis|reflection)(?:\s[^>]*)?>[\s\S]*?(?:<\/\s*(?:think|thought|reasoning|analysis|reflection)\s*>|$)/gi, '')
    .replace(/<\|(?:thought|think|reasoning|analysis)\|>[\s\S]*?(?:<\|\/(?:thought|think|reasoning|analysis)\|>|$)/gi, '')
    .replace(/:::thinking[\s\S]*?(?::::|$)/gi, '')
    .replace(/```(?:thought|thinking)[\s\S]*?(?:```|$)/gi, '')
    .replace(/\[\/?(?:THINK|THOUGHT|REASONING)\][\s\S]*?(?:\[\/(?:THINK|THOUGHT|REASONING)\]|$)/gi, '')
    .replace(/^(?:thought process|thinking process|思考过程|思考路径)\s*[:：][\s\S]*?(?:\n\n|$)/gi, '')
    .replace(/```[\s\S]*?```/gi, '代码块')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[#*>\-_~]/g, '')
    .trim()

  // 过滤系统路由元数据、执行耗时及内部调度标签行
  text = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false
      if (/^(?:已完成|完成|耗时|用时|执行完毕|运行完毕)/.test(line)) return false
      if (/^(?:Route|Routing|路由|Intent|意图|Status|状态|Phase|阶段|Step|步骤)\s*[:：]/i.test(line)) return false
      if (/^\[(?:Route|Status|System|Info|Fast-path)\]/i.test(line)) return false
      return true
    })
    .join('\n')
    .trim()

  if (!text) return ''

  // 2. 如果原本就是短句 (<= 45 字)，直接使用原句进行伴侣口播
  if (text.length <= 45 && !text.includes('\n')) {
    return formatPersonaVoice(text, characterId)
  }

  // 3. 针对不同类型的长文场景，提取伴侣专属口述摘要
  // 场景 A: 包含代码生成（基于清洗后的正文匹配，避免思考块误判）
  if (/代码|function|def |class |const |import |npm |pip /i.test(text)) {
    const codePhrases = {
      tutu: '主人，核心代码已经为你写好啦，快看看屏幕气泡里的代码块吧~',
      yuyu: '代码已经整理完毕，重点逻辑已呈现在屏幕面板中。',
      xiaoxiao: '主人，代码已经写好了哦，先喝口水再仔细看吧~',
      keke: '报告主人！代码任务处理完毕，详细实现已展开在气泡中！',
      whale: '核心代码已生成完毕，请查阅屏幕面板中的详细实现。',
    }
    return codePhrases[characterId] || codePhrases.whale
  }

  // 场景 B: 搜索/分析/报告类
  if (/分析|总结|查询|找到|报告|结果/i.test(text.slice(0, 100))) {
    // 尝试提取首句（通常是结论）
    const firstSentence = text.split(/[。！？\n]/).map(s => s.trim()).filter(Boolean)[0]
    if (firstSentence && firstSentence.length >= 8 && firstSentence.length <= 50) {
      return formatPersonaVoice(firstSentence, characterId)
    }
  }

  // 场景 C: 普通长篇回答，提取前 1~2 个完整句子作为概括
  const sentences = text.split(/[。！？\n]/).map(s => s.trim()).filter(Boolean)
  if (sentences.length > 0) {
    let summary = sentences[0]
    if (summary.length < 25 && sentences.length > 1) {
      summary += '，' + sentences[1]
    }
    if (summary.length > 60) {
      summary = summary.slice(0, 58) + '...'
    }
    return formatPersonaVoice(summary, characterId)
  }

  return formatPersonaVoice('主人，任务已经为你完成啦，请看屏幕详情~', characterId)
}

function formatPersonaVoice(text, characterId) {
  let cleaned = text.replace(/^[，、：；]/, '').trim()
  if (!/[。！？~]$/.test(cleaned)) {
    cleaned += '。'
  }
  return cleaned
}
