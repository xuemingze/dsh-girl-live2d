import assert from 'node:assert/strict'
import { SpeechArbitrator, Priority } from '../lib/speech-arbitrator.js'

console.log('--- 测试 1: 发言权获取与独占 ---')
const arbitrator = new SpeechArbitrator()
const token1 = arbitrator.acquire(Priority.USER_INTERACTION, 'tap_companion')
assert.ok(token1, '成功获取信标')
assert.strictEqual(arbitrator.isBusy(), true, '当前处于忙碌状态')

console.log('--- 测试 2: 低优先级打断被拒 ---')
const tokenLow = arbitrator.acquire(Priority.IDLE_ROUTINE, 'idle_tick')
assert.strictEqual(tokenLow, null, '低优先级发言必须被拒')
assert.strictEqual(arbitrator.getCurrentPriority(), Priority.USER_INTERACTION, '优先级保持原有水平')

console.log('--- 测试 3: 高优先级打断并触发强断回调 ---')
let preemptedCalled = false
let preemptedByPri = 0
const arbitrator2 = new SpeechArbitrator()
const tapToken = arbitrator2.acquire(Priority.USER_INTERACTION, 'tap', (pri) => {
  preemptedCalled = true
  preemptedByPri = pri
})

// 注入高优先级 ASSISTANT_REPLY 打断
const replyToken = arbitrator2.acquire(Priority.ASSISTANT_REPLY, 'dsh_reply')
assert.ok(replyToken, '高优先级成功抢占信标')
assert.strictEqual(preemptedCalled, true, '旧发言者收到强断回调')
assert.strictEqual(preemptedByPri, Priority.ASSISTANT_REPLY, '打断源优先级正确传递')

console.log('--- 测试 4: 释放与状态复位 ---')
arbitrator2.release(replyToken)
assert.strictEqual(arbitrator2.isBusy(), false, '释放后不再忙碌')

console.log('\n🎉 SpeechArbitrator 发言权仲裁器全部单元测试通过！')
