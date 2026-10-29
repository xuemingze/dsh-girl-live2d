/**
 * desktop/perception/sources/web.js
 * 
 * 网页场景感知源 (WebPagePerceptionSource)
 * 接收来自 Chrome/Edge 浏览器扩展同步的 URL 与标题数据。
 * 遵循“单次关怀提问，无视即彻底静默”铁律：
 * - 识别出行、租房、购物等场景后，伴侣仅在气泡中主动问一句
 * - 用户无回复，超时（20s）后自动复位静默，绝不重复追问骚扰用户！
 */

import { PerceptionSource } from './base.js'

export class WebPagePerceptionSource extends PerceptionSource {
  constructor(options = {}) {
    super('web', {
      syncToDsh: options.syncToDsh ?? true,
      allowProactiveSpeak: options.allowProactiveSpeak ?? true,
    })
    this.inquiryCooldownMs = options.inquiryCooldownMs || 15 * 60 * 1000 // 同类场景至少间隔 15 分钟
    this._lastInquiryAt = new Map() // category -> timestamp
    this._waitingReply = false
    this._silenceTimer = null
    this._pendingCategory = null
  }

  /**
   * 接收浏览器扩展上报的网页事件
   * @param {string} url 网页地址
   * @param {string} title 网页标题
   */
  processPageVisit(url, title) {
    if (!url || typeof url !== 'string') return null
    const lowerUrl = url.toLowerCase()
    const lowerTitle = (title || '').toLowerCase()

    let category = null
    let inquiryPrompt = null

    // 1. 出行/机票/火车/酒店 (携程、飞猪、12306、去哪儿、Booking 等)
    if (/ctrip|fliggy|12306|qunar|booking|trip\.com|airbnb|flights|hotel/i.test(lowerUrl) ||
        /机票|航班|高铁|预订酒店|订票|出行|民宿/.test(lowerTitle)) {
      category = 'travel'
      inquiryPrompt = '主人是在看去哪里的行程机票呀？'
    }
    // 2. 租房/买房 (贝壳、安居客、链家、自如、58同城等)
    else if (/ke\.com|anjuke|lianjia|ziroom|fang\.com/i.test(lowerUrl) ||
             /租房|整租|合租|买房|房源/.test(lowerTitle)) {
      category = 'rental'
      inquiryPrompt = '主人是在看新房源或者租房信息吗？'
    }
    // 3. 购物/比价 (淘宝、京东、拼多多、美团、Amazon 等)
    else if (/taobao|jd\.com|pinduoduo|meituan|amazon/i.test(lowerUrl) ||
             /购物车|订单详情|商品详情/.test(lowerTitle)) {
      category = 'shopping'
      inquiryPrompt = '主人是在挑什么心仪的好物呀？'
    }

    const eventData = { url, title, category, ts: Date.now() }
    this.emit('page_visit', eventData)

    // 检查是否触发单次主动询问
    if (category && this.allowProactiveSpeak && !this._waitingReply) {
      const now = Date.now()
      const lastAt = this._lastInquiryAt.get(category) || 0
      if (now - lastAt >= this.inquiryCooldownMs) {
        this._lastInquiryAt.set(category, now)
        this.triggerSingleInquiry(category, inquiryPrompt, eventData)
      }
    }

    return eventData
  }

  /**
   * 发起单次轻量询问
   */
  triggerSingleInquiry(category, questionText, meta = {}) {
    this._waitingReply = true
    this._pendingCategory = category
    clearTimeout(this._silenceTimer)

    this.emit('proactive_inquiry', {
      category,
      questionText,
      meta,
    })

    // 启动 20 秒无视倒计时：用户不理会则自动复位并永久静默
    this._silenceTimer = setTimeout(() => {
      this.onUserIgnored()
    }, 20000)
    if (this._silenceTimer.unref) this._silenceTimer.unref()
  }

  /**
   * 模拟触发测试询问（绕过冷却限制，供面板一键体验）
   */
  triggerTestInquiry(category = 'travel') {
    const prompts = {
      travel: '主人是在看去哪里的行程机票呀？',
      rental: '主人是在看新房源或者租房信息吗？',
      shopping: '主人是在挑什么心仪的好物呀？',
    }
    const questionText = prompts[category] || prompts.travel
    this.triggerSingleInquiry(category, questionText, { test: true })
    return { ok: true, category, questionText }
  }

  /**
   * 用户回复了当前询问
   */
  onUserReplied(userText) {
    if (!this._waitingReply) return
    clearTimeout(this._silenceTimer)
    this._waitingReply = false
    const cat = this._pendingCategory
    this._pendingCategory = null
    this.emit('inquiry_answered', { category: cat, userText })
  }

  /**
   * 用户无视了询问，立即回归静默
   */
  onUserIgnored() {
    clearTimeout(this._silenceTimer)
    this._waitingReply = false
    this._pendingCategory = null
    this.emit('inquiry_silenced', { reason: 'user_ignored_timeout' })
  }
}
