import assert from 'node:assert/strict'
import { PersonaRephraseEngine } from '../voice_engine/rephraser.js'

console.log('--- 测试 1: 读取角色传记 lore.md ---')
const engine = new PersonaRephraseEngine({ voiceMode: 'template' })
const tutuLore = engine.getCharacterLore('tutu')
assert.ok(tutuLore.includes('雪山之巅的灵兔少女'), 'tutu lore 包含灵兔少女设定')
const whaleLore = engine.getCharacterLore('whale')
assert.ok(whaleLore.includes('万米深海'), 'whale lore 包含万米深海设定')
console.log('✅ 角色 lore.md 读取与缓存通过')

console.log('--- 测试 2: 传统模板模式 (voiceMode: template) ---')
const templateRes = await engine.rephrase('这里有一段长代码实现：\n```js\nfunction calculateSomethingComplex() { return 1 + 2; }\n```\n请主人查阅代码。', 'tutu')
assert.ok(templateRes, '模板模式应产出结果')
assert.ok(templateRes.bubbleText.includes('代码已经为你写好啦'), '输出伴侣代码提示')
console.log('✅ 模板模式验证通过')

console.log('--- 测试 3: 严禁隐式降级铁律 (voiceMode: rephrase + 故障) ---')
// 构造一个故意超时的引擎
const brokenEngine = new PersonaRephraseEngine({
  voiceMode: 'rephrase',
  apiBaseUrl: 'http://127.0.0.1:59999', // 不存在的端口
  timeoutMs: 400,
  apiKeyResolver: async () => 'test_key',
})
const failedRes = await brokenEngine.rephrase('这是一个重要的工作成果汇报', 'tutu')
assert.strictEqual(failedRes, null, '大模型报错或超时必须保持静默，严禁隐式回退到 template 模板!')
console.log('✅ 严禁隐式自动降级铁律验证通过：调用失败即静默，杜绝抢权与回声！')

console.log('--- 测试 4: 关闭模式 (voiceMode: off) ---')
engine.setVoiceMode('off')
const offRes = await engine.rephrase('你好主人', 'tutu')
assert.strictEqual(offRes, null, '关闭模式下必须返回 null')
console.log('✅ 关闭模式验证通过')

console.log('\n🎉 PersonaRephraseEngine 全部单元测试通过！')
