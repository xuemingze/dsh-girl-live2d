/**
 * visual_hands/change_detector.js
 * 
 * 移植封装自桌面灵 (zhuomianling) 的高效轻量屏幕差分变动检测器
 * 原理：将截取的像素帧降采样为 32x18 RGB 特征散列（仅 1728 字节），
 * 绝不在内存中积攒全分辨率大图。
 * 计算相邻特征单元的色差比率，剔除微小动画抖动（noiseThreshold），
 * 仅在发生实质性稳定变更（candidateThreshold & stableWaitMs）时发出信号。
 */

import crypto from 'node:crypto'

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

  // 综合考量平均色差与显著变动单元格比例
  return Math.max(totalDifference / cellCount, changedCells / cellCount)
}

export class ScreenChangeDetector {
  constructor(options = {}) {
    this.stableWaitMs = options.stableWaitMs ?? 1200 // 判定稳定持续时间（毫秒）
    this.noiseThreshold = options.noiseThreshold ?? 0.02 // 低于 2% 视为动态噪点直接忽略
    this.candidateThreshold = options.candidateThreshold ?? 0.08 // 超过 8% 视为有效画面切换
    this.lastStableSignature = null
    this.pendingCandidate = null // { signature, sourceKey, firstSeenAt }
  }

  reset() {
    this.lastStableSignature = null
    this.pendingCandidate = null
  }

  /**
   * 提交已处理/已播报的参考帧
   */
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
   * @returns {{changed: boolean, ratio: number, reason?: string}}
   */
  evaluate(currentSignature, sourceKey = 'foreground', now = Date.now()) {
    if (!currentSignature || currentSignature.length !== SIGNATURE_BYTE_LENGTH) {
      return { changed: false, ratio: 0 }
    }

    // 初始首帧建立基准
    if (!this.lastStableSignature) {
      this.lastStableSignature = Buffer.from(currentSignature)
      return { changed: false, ratio: 0, reason: 'init_baseline' }
    }

    const diffWithStable = calculateDifferenceRatio(currentSignature, this.lastStableSignature)

    // 变动微弱，属于光标微闪或小动画噪点，直接放过
    if (diffWithStable < this.noiseThreshold) {
      this.pendingCandidate = null
      return { changed: false, ratio: diffWithStable, reason: 'noise' }
    }

    // 达到候选阈值，进入防抖稳定计时
    if (diffWithStable >= this.candidateThreshold) {
      if (!this.pendingCandidate || this.pendingCandidate.sourceKey !== sourceKey) {
        this.pendingCandidate = {
          signature: Buffer.from(currentSignature),
          sourceKey,
          firstSeenAt: now,
        }
        return { changed: false, ratio: diffWithStable, reason: 'candidate_starting' }
      }

      // 检查当前候选帧与最初捕获的候选帧是否保持相对稳定
      const candidateJitter = calculateDifferenceRatio(currentSignature, this.pendingCandidate.signature)
      if (candidateJitter > 0.15) {
        // 如果候选内容还在剧烈大范围变化（例如正在极速翻页或切窗口），重置稳定计时
        this.pendingCandidate.signature = Buffer.from(currentSignature)
        this.pendingCandidate.firstSeenAt = now
        return { changed: false, ratio: diffWithStable, reason: 'candidate_jitter' }
      }

      // 稳定超过设定时间（如 1200ms），确认发生实质性稳定变更
      if (now - this.pendingCandidate.firstSeenAt >= this.stableWaitMs) {
        this.lastStableSignature = Buffer.from(currentSignature)
        this.pendingCandidate = null
        return { changed: true, ratio: diffWithStable, reason: 'stable_scene_changed' }
      }

      return { changed: false, ratio: diffWithStable, reason: 'waiting_stable' }
    }

    return { changed: false, ratio: diffWithStable, reason: 'below_threshold' }
  }
}
