/**
 * voice_engine/rephraser.js
 * 
 * 伴侣嘴巴层：AI 人设转述引擎 (PersonaRephraseEngine)
 * 核心准则：
 * 1. DSH 是唯一大脑，转述器只负责将 DSH 的事实事实转述为符合伴侣个性的台词与 Live2D 动作标签。
 * 2. 严禁隐式自动降级：若 voiceMode 为 'rephrase' 且请求失败，直接返回 null 并记录日志，
 *    严禁悄悄切回 template 模板发声，坚决杜绝争抢音频通道与重复回声。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractCompanionVoiceText } from './summarizer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHARACTERS_DIR = path.resolve(__dirname, '..', 'characters')

export class PersonaRephraseEngine {
  constructor(options = {}) {
    this.voiceMode = options.voiceMode || 'rephrase' // 'rephrase' | 'template' | 'off'
    this.apiKeyResolver = options.apiKeyResolver || null
    this.apiBaseUrl = options.apiBaseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'
    this.modelName = options.modelName || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
    this.timeoutMs = options.timeoutMs || 4500
    this._loreCache = new Map()
  }

  setVoiceMode(mode) {
    if (['rephrase', 'template', 'off'].includes(mode)) {
      this.voiceMode = mode
    }
  }

  /**
   * 读取指定角色的传记规则 (lore.md)
   */
  getCharacterLore(characterId) {
    if (this._loreCache.has(characterId)) {
      return this._loreCache.get(characterId)
    }
    const lorePath = path.join(CHARACTERS_DIR, characterId, 'lore.md')
    let loreText = ''
    try {
      if (fs.existsSync(lorePath)) {
        loreText = fs.readFileSync(lorePath, 'utf8')
      }
    } catch (e) {
      console.warn(`[rephraser] 读取角色 ${characterId} 的 lore.md 失败:`, e.message)
    }
    this._loreCache.set(characterId, loreText)
    return loreText
  }

  /**
   * 核心转述方法
   * @param {string} rawText DSH 大脑输出的事实全文
   * @param {string} characterId 当前伴侣角色 ID
   * @param {object} context 附加场景上下文（如 intent: 'REPLY' | 'ALERT' | 'TRAVEL_INQUIRY'）
   * @returns {Promise<{bubbleText: string, speechText: string, actionCue: string}|null>}
   */
  async rephrase(rawText, characterId = 'tutu', context = {}) {
    if (!rawText || typeof rawText !== 'string') return null
    const text = rawText.trim()
    if (!text) return null

    // 模式 1: 完全关闭
    if (this.voiceMode === 'off') {
      return null
    }

    // 模式 2: 传统规则模板模式
    if (this.voiceMode === 'template') {
      const templateText = extractCompanionVoiceText(text, characterId)
      if (!templateText) return null
      return {
        bubbleText: templateText,
        speechText: templateText,
        actionCue: '',
      }
    }

    // 模式 3: AI 人设转述模式 (rephrase)
    try {
      const apiKey = typeof this.apiKeyResolver === 'function' 
        ? await this.apiKeyResolver() 
        : (process.env.DEEPSEEK_API_KEY || '')

      if (!apiKey) {
        console.warn('[rephraser] 未检测到 API_KEY，根据“严禁隐式降级”准则保持静默')
        return null
      }

      const lore = this.getCharacterLore(characterId)
      const systemPrompt = `你不是 AI 助手，你是桌面伴侣【${characterId}】的嘴巴与外貌表情层。
主人的 AI 大脑（DSH）刚刚产出了一段任务内容或回复。你的职责是：
1. 用你专属的人设风格、语气、自称与口癖，将核心事实或结论向主人转述。
2. 必须保留 DSH 原文的客观事实、数字与选择（不得擅自篡改事实或承诺）。
3. 必须在句子开头或中间自然携带一个与心情对应的 Live2D 动作标签（用全角括号包围，如：（脸红揉眼睛）、（得意地抖了抖耳朵）、（轻轻递过温水））。
4. 语言极度口语化自然，严格控制在 1~2 句话（不超过 40 个字），适合气泡展示与朗读。
5. 只输出你对主人说的那句话，严禁带有任何解释、前后缀标记或思考过程。

【你的人设规则如下】：
${lore || '性格活泼可爱，自称兔兔，称呼主人，说话常带~、呀。'}`

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)

      const url = `${this.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `【DSH 原文如下】:\n${text.slice(0, 1500)}` },
          ],
          max_tokens: 120,
          temperature: 0.7,
        }),
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 100)}`)
      }

      const data = await resp.json()
      const reply = data?.choices?.[0]?.message?.content?.trim() || ''

      if (!reply) {
        console.warn('[rephraser] AI 转述返回空内容，保持静默')
        return null
      }

      // 解析动作括号与纯台词
      const cueMatch = reply.match(/（([^）]+)）|\(([^)]+)\)/)
      const actionCue = cueMatch ? (cueMatch[1] || cueMatch[2]).trim() : ''
      const speechText = reply.replace(/（[^）]+）|\([^)]+\)/g, '').trim()

      return {
        bubbleText: reply,
        speechText: speechText || reply,
        actionCue,
      }
    } catch (err) {
      // 核心工程准则：AI 失败了就是失败了，绝对不隐式自动降级到 summarizer 抢权！
      console.warn(`[rephraser] AI 人设转述失败 [${err.name || 'Error'}]: ${err.message}。遵循严禁隐式降级铁律，本次保持静默。`)
      return null
    }
  }
}
