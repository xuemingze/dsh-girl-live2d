/**
 * visual_hands/change_detector.js
 * 
 * 移植封装自桌面灵 (zhuomianling) 的高效轻量屏幕差分变动检测器
 * 原理：将截取的像素帧降采样为 32x18 RGB 特征散列（仅 1728 字节），
 * 绝不在内存中积攒全分辨率大图。
 * 计算相邻特征单元的色差比率，剔除微小动画抖动（noiseThreshold）。
 * 
 * 🌟 电影/视频/游戏高频动态画面抑制增强 (Dynamic Motion Flood Suppression)：
 * - 针对视频播放（Bilibili、YouTube、PotPlayer）或 3D 游戏画面的高频连贯变动，
 *   建立滑动窗口变动频率检测机制。
 * - 当检测到连续剧烈晃动（如 4 秒内多次连续抖动）时，自动标记进入「动态多媒体流 (Dynamic Motion Stream) 模式」。
 * - 在动态流模式下，即使电影镜头出现短暂 1~2 秒的静止特写，也不会被误判为“有效工作场景变更”，
 *   必须在画面彻底恢复连续静止（平稳期超过 3.5 秒）后，才解除动态流抑制。
 */

export const SIGNATURE_WIDTH = 32
export const SIGNATURE_HEIGHT = 18
export const SIGNATURE_CHANNELS = 3
export const SIGNATURE_BYTE_LENGTH = SIGNATURE_WIDTH * SIGNATURE_HEIGHT * SIGNATURE_CHANNELS // 1728 bytes

const CHANGED_CELL_THRESHOLD = 0.12 // 单个 RGB 单元格触发显著变动的阈值

/**
 * 计算两个 1728 字节特征签名之间的差分比率 (0.0 ~ 1.0)
 */
export function calculateDifferenceRatio(left, right) {
  if (!left || !right || left.length !== SIGNATURE_BYTE_LENGTH || right.length !== SIGNATURE_BYTE_LENGTH) {
    return 1.0
  }

  const cellCount = SIGNATURE_WIDTH * SIGNATURE_HEIGHT
  let totalDifference = 0
  let changedCells = 0

  for (let i = 0; i < SIGNATURE_BYTE_LENGTH; i += SIGNATURE_CHANNELS) {
    const diff = (
      Math.abs(left[i] - right[i]) +
      Math.abs(left[i + 1] - right[i + 1]) +
      Math.abs(left[i + 2] - right[i + 2])
    ) / (SIGNATURE_CHANNELS * 255)

    totalDifference += diff
    if (diff >= CHANGED_CELL_THRESHOLD) {
      changedCells += 1
    }
  }

  return Math.max(totalDifference / cellCount, changedCells / cellCount)
}

export class ScreenChangeDetector {
  constructor(options = {}) {
    this.stableWaitMs = options.stableWaitMs ?? 1200 // 判定稳定持续时间（毫秒）
    this.noiseThreshold = options.noiseThreshold ?? 0.02 // 低于 2% 视为动态噪点直接忽略
    this.candidateThreshold = options.candidateThreshold ?? 0.08 // 超过 8% 视为有效画面切换
    
    // 动态多媒体（电影/视频/游戏）抑制配置
    this.motionWindowMs = options.motionWindowMs ?? 5000 // 5 秒观察窗口
    this.motionFreqThreshold = options.motionFreqThreshold ?? 3 // 窗口内超过 3 次连续抖动即判定为视频/游戏流
    this.calmDurationMs = options.calmDurationMs ?? 3500 // 需要静止 3.5 秒才能解除视频流抑制

    this.lastStableSignature = null
    this.pendingCandidate = null // { signature, sourceKey, firstSeenAt }
    
    this.recentMotionHistory = [] // 记录高频变动的时间戳
    this.isDynamicStream = false // 是否处于视频/游戏动态流中
    this.lastMotionAt = 0 // 上次剧烈变动的时间戳
  }

  reset() {
    this.lastStableSignature = null
    this.pendingCandidate = null
    this.recentMotionHistory = []
    this.isDynamicStream = false
    this.lastMotionAt = 0
  }

  commitStableSignature(signature) {
    if (signature && signature.length === SIGNATURE_BYTE_LENGTH) {
      this.lastStableSignature = Buffer.from(signature)
      this.pendingCandidate = null
    }
  }

  /**
   * 评估当前特征帧
   * @param {Buffer} currentSignature 32x18x3 字节签名
   * @param {string} sourceKey 来源标识（例如前台窗口 HWND 或标题）
   * @param {number} now 时间戳
   * @returns {{changed: boolean, ratio: number, reason?: string, isDynamicStream: boolean}}
   */
  evaluate(currentSignature, sourceKey = 'foreground', now = Date.now()) {
    if (!currentSignature || currentSignature.length !== SIGNATURE_BYTE_LENGTH) {
      return { changed: false, ratio: 0, isDynamicStream: this.isDynamicStream }
    }

    // 初始首帧建立基准
    if (!this.lastStableSignature) {
      this.lastStableSignature = Buffer.from(currentSignature)
      return { changed: false, ratio: 0, reason: 'init_baseline', isDynamicStream: false }
    }

    const diffWithStable = calculateDifferenceRatio(currentSignature, this.lastStableSignature)

    // 1. 变动微弱，属于光标微闪或小动画噪点，直接放过
    if (diffWithStable < this.noiseThreshold) {
      this.pendingCandidate = null
      // 检查是否持续平静足够长时间，若是则退出动态流抑制
      if (this.isDynamicStream && (now - this.lastMotionAt >= this.calmDurationMs)) {
        this.isDynamicStream = false
      }
      return { changed: false, ratio: diffWithStable, reason: 'noise', isDynamicStream: this.isDynamicStream }
    }

    // 2. 达到候选阈值，记录变动频率
    if (diffWithStable >= this.candidateThreshold) {
      this.lastMotionAt = now
      this.recentMotionHistory.push(now)
      // 清理超过窗口的历史记录
      this.recentMotionHistory = this.recentMotionHistory.filter((t) => now - t <= this.motionWindowMs)

      // 判断是否触发高频视频/游戏动态流抑制
      if (this.recentMotionHistory.length >= this.motionFreqThreshold) {
        this.isDynamicStream = true
      }

      if (!this.pendingCandidate || this.pendingCandidate.sourceKey !== sourceKey) {
        this.pendingCandidate = {
          signature: Buffer.from(currentSignature),
          sourceKey,
          firstSeenAt: now,
        }
        return {
          changed: false,
          ratio: diffWithStable,
          reason: this.isDynamicStream ? 'video_stream_suppressed' : 'candidate_starting',
          isDynamicStream: this.isDynamicStream,
        }
      }

      // 检查当前候选帧与最初捕获的候选帧是否保持相对稳定
      const candidateJitter = calculateDifferenceRatio(currentSignature, this.pendingCandidate.signature)
      if (candidateJitter > 0.15) {
        // 候选内容还在剧烈变化（视频画面、高速切屏）
        this.isDynamicStream = true
        this.pendingCandidate.signature = Buffer.from(currentSignature)
        this.pendingCandidate.firstSeenAt = now
        return {
          changed: false,
          ratio: diffWithStable,
          reason: 'video_stream_jitter',
          isDynamicStream: this.isDynamicStream,
        }
      }

      // 如果当前正处于视频/游戏动态流中，暂不触发稳定变更（防止电影中人物短暂停顿 1 秒造成误触发）
      if (this.isDynamicStream) {
        return {
          changed: false,
          ratio: diffWithStable,
          reason: 'dynamic_stream_holding',
          isDynamicStream: true,
        }
      }

      // 稳定超过设定时间（如 1200ms），确认发生实质性稳定变更
      if (now - this.pendingCandidate.firstSeenAt >= this.stableWaitMs) {
        this.lastStableSignature = Buffer.from(currentSignature)
        this.pendingCandidate = null
        return {
          changed: true,
          ratio: diffWithStable,
          reason: 'stable_scene_changed',
          isDynamicStream: false,
        }
      }

      return {
        changed: false,
        ratio: diffWithStable,
        reason: 'waiting_stable',
        isDynamicStream: false,
      }
    }

    return { changed: false, ratio: diffWithStable, reason: 'below_threshold', isDynamicStream: this.isDynamicStream }
  }
}
