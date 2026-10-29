/**
 * desktop/perception/sources/media.js
 * 
 * 媒体与音乐播放感知源 (MediaPerceptionSource)
 * 监听 Windows SMTC (System Media Transport Controls) 媒体播放状态。
 * 支持网易云音乐、QQ音乐、Spotify、Edge 浏览器等主流播放器的曲目识别。
 */

import { PerceptionSource } from './base.js'

export class MediaPerceptionSource extends PerceptionSource {
  constructor(options = {}) {
    super('media', {
      syncToDsh: options.syncToDsh ?? true,
      allowProactiveSpeak: options.allowProactiveSpeak ?? true,
    })
    this.currentTrack = null // { title, artist, album }
    this.lastNoticedAt = 0
    this.commentCooldownMs = options.commentCooldownMs || 20 * 60 * 1000 // 换歌评论至少间隔 20 分钟
  }

  /**
   * 更新当前播放的曲目信息
   */
  updateTrack(title, artist = '', album = '') {
    if (!title) return
    const key = `${title}__${artist}`
    if (this.currentTrack && this.currentTrack.key === key) return

    this.currentTrack = { title, artist, album, key, updatedAt: Date.now() }
    this.emit('track_changed', this.currentTrack)

    const now = Date.now()
    if (this.allowProactiveSpeak && now - this.lastNoticedAt >= this.commentCooldownMs) {
      this.lastNoticedAt = now
      this.emit('proactive_music_comment', {
        title,
        artist,
        suggestedLine: `正在放《${title}》呀，这首歌好听呢~`,
      })
    }
  }
}
