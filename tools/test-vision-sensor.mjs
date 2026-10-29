import assert from 'node:assert/strict'
import { ScreenChangeDetector, calculateDifferenceRatio, SIGNATURE_BYTE_LENGTH } from '../visual_hands/change_detector.js'
import { ScreenSensorManager } from '../visual_hands/screen_sensor.js'

console.log('--- 测试 1: 32x18 RGB 特征散列差分计算 ---')
const frameA = Buffer.alloc(SIGNATURE_BYTE_LENGTH, 100)
const frameB = Buffer.alloc(SIGNATURE_BYTE_LENGTH, 100)
assert.strictEqual(calculateDifferenceRatio(frameA, frameB), 0, '相同画面差分为 0')

// 制造大幅变动
const frameC = Buffer.alloc(SIGNATURE_BYTE_LENGTH, 250)
const diff = calculateDifferenceRatio(frameA, frameC)
assert.ok(diff > 0.5, '大幅度画面色彩变动差分 > 0.5')
console.log('✅ 差分计算算法验证通过，差分值:', diff)

console.log('--- 测试 2: 动态噪点过滤与稳定切换判定 ---')
const detector = new ScreenChangeDetector({
  stableWaitMs: 300,
  noiseThreshold: 0.02,
  candidateThreshold: 0.08,
})

// 初始帧建立基准
const initRes = detector.evaluate(frameA, 'w1', 1000)
assert.strictEqual(initRes.changed, false, '首帧建立基准')

// 注入微动噪点 (只改动 5 个字节)
const noiseFrame = Buffer.from(frameA)
noiseFrame[0] = 120
noiseFrame[1] = 120
const noiseRes = detector.evaluate(noiseFrame, 'w1', 1050)
assert.strictEqual(noiseRes.changed, false, '微动噪点被过滤')
assert.strictEqual(noiseRes.reason, 'noise')

// 注入候选切换
const t0 = 2000
const startRes = detector.evaluate(frameC, 'w2', t0)
assert.strictEqual(startRes.changed, false, '首个大幅切换帧进入防抖等待')
assert.strictEqual(startRes.reason, 'candidate_starting')

// 保持稳定满 350ms
const stableRes = detector.evaluate(frameC, 'w2', t0 + 350)
assert.strictEqual(stableRes.changed, true, '画面保持稳定后确认切换成功')
assert.strictEqual(stableRes.reason, 'stable_scene_changed')
console.log('✅ 移植自桌面灵的稳定防抖特征差分算法验证通过！')

console.log('--- 测试 3: ScreenSensorManager 探测与开箱即用状态 ---')
const manager = new ScreenSensorManager({ hostPort: 59999 })
const status = await manager.getStatus()
assert.strictEqual(status.enabled, true, '感官默认开启')
assert.strictEqual(status.mode, 'builtin_standalone', '未探测到外部插件时无缝走内置原生模式')
console.log('✅ ScreenSensorManager 状态探测验证通过:', status)

console.log('\n🎉 视觉感官神经单元测试全部通过！')
