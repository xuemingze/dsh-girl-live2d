/**
 * character-asset-analyzer.js
 * 
 * 动态可扩展的角色资产分析器。
 * 支持任意新导入的 Live2D 模型（Cubism / VTube Studio / 自定义）：
 * 1. 深度递归扫描模型根目录及子目录 (motions/, expressions/ 等)
 * 2. 深度解析 .model3.json 中的 FileReferences (Expressions, Motions, DisplayInfo)
 * 3. 深度解析 .cdi3.json (参数组与中文参数命名)
 * 4. 深度解析 .vtube.json (热键、文件夹与动作配置)
 * 5. 自动归类：装饰 (decor)、场景 (scene)、动作 (action)、表情 (emotion)
 * 6. 智能自动生成标准情绪 (happy, love, etc.) 与动作槽位 (idle, click, done)
 * 7. 支持 character.json 持久化自定义分类覆盖与扩展规则
 */

import fs from 'fs'
import path from 'path'

// 基础分类识别正则（可扩展，模型作者中英文习惯兼顾）
const DEFAULT_RULES = {
  decor: [
    /发[型色带]?|双马尾|后发|前发|白发|黑发|金发|粉发|棕发|蓝发|紫发|长发|短发/i,
    /头纱|黑纱|面纱|帽子|发卡|发箍|头饰|耳环|项链|眼镜|墨镜|眼罩/i,
    /衣|服|裙|外套|内衣|泳装|旗袍|女仆|白丝|黑丝|丝袜|袜|鞋/i,
    /瞳孔|美瞳|眼色|换色|变色|蓝|紫|粉|红|金|白|黑/i,
    /兔耳|猫耳|兽耳|尾巴|翅膀|变小|人妻/i,
    /cloth|hair|dress|outfit|costume|glasses|socks|tail|ear|decor/i
  ],
  scene: [
    /扇子|扇|开扇/i,
    /话筒|麦克风|吉他|乐器/i,
    /菜单|餐盘|奶茶|茶杯|咖啡|酒杯|饮料|蛋糕|食物|蛋包饭/i,
    /桌|椅|床|背景|地毯|电脑|键盘|鼠标|手机|书|本子|笔/i,
    /狐狸|兔兔|猫|狗|宠物|玩偶|公仔|鱼|伞|道具|场景/i,
    /prop|scene|item|table|desk|drink|food|cup|fan|mic|pet/i
  ],
  action: [
    /比耶|点唇|飞头|前倾|施法|拉弓|射箭|勾手|掏耳|俯身|按键/i,
    /插手|点单|点击|触碰|摸|抱|嘘|挥手|挥拳|拔剑|敬礼|招手/i,
    /脚捕捉|脚点击|抬手|伸手|拍手|点头|摇头/i,
    /action|pose|gesture|motion|spell|bow|hand|arm|attack/i
  ],
  emotion: [
    /开心|笑|兴奋|星星眼|黄色瞳孔|0\.0/i,
    /爱心|心心|喜欢|love|heart/i,
    /脸红|红脸|害羞|blush/i,
    /调皮|傲娇|得意|吐舌|眯眼/i,
    /难过|悲伤|委屈|哭|流泪|眼泪|cry|tear/i,
    /生气|怒|鼓脸|angry/i,
    /黑脸|阴暗|长蘑菇|gloomy/i,
    /流汗|汗|冷汗|sweat/i,
    /问号|疑惑|疑问|confused/i,
    /感叹号|受惊|alert/i,
    /zzz|睡|困|口水|sleep/i,
    /吐魂|灵魂|瘫|dead/i,
    /呆呆眼|晕晕|dizzy|eye|mouth|brow|cheek|face|exp/i
  ]
}

// 情绪与动作智能槽位匹配字典
const SLOT_MATCH_RULES = {
  expressions: {
    happy: /开心|笑|兴奋|喜|joy|happy|smile/i,
    love: /爱心|心心|喜欢|love|heart/i,
    shy: /脸红|红脸|害羞|blush|shy/i,
    sad: /难过|悲伤|委屈|流泪|眼泪|cry|sad|tear/i,
    angry: /生气|怒|鼓脸|脸黑|黑脸|angry|mad/i,
    sleepy: /zzz|睡|困|口水|蚊香眼|sleep|dizzy/i,
    excited: /星星眼|兴奋|激萌|star|excited/i,
    thinking: /思考|想|点唇|戳脸|think/i,
    confused: /问号|疑惑|疑问|扇子|confused|what/i,
    tongue: /舌头|吐舌|调皮|OUT|tongue/i,
  },
  motions: {
    idle: /待机|idle|Scene1|wait|normal/i,
    walk: /走路|行走|散步|跑步|跑|walk|run/i,
    click: /点击|触摸|互动|摸|抱|click|tap/i,
    done: /打瞌睡|完成|结束|睡觉|done|sleep|finish/i,
  }
}

/**
 * 递归扫描目录下所有文件
 * @param {string} dir 扫描根目录
 * @param {string} baseDir 相对基准目录
 * @returns {Array<{full: string, rel: string, name: string}>}
 */
function scanFilesRecursively(dir, baseDir = dir) {
  let results = []
  if (!fs.existsSync(dir)) return results
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results = results.concat(scanFilesRecursively(full, baseDir))
      } else if (entry.isFile()) {
        const rel = path.relative(baseDir, full).replace(/\\/g, '/')
        results.push({ full, rel, name: entry.name })
      }
    }
  } catch (err) {}
  return results
}

/**
 * 分析指定角色目录中的所有资产
 * @param {string} charDir 角色根目录 (含 character.json 和 model 子目录)
 * @returns {object} { expressions, motions, categories, displayName, modelFile, currentMappings }
 */
export function analyzeCharacterAssets(charDir) {
  const modelDir = path.join(charDir, 'model')
  const cfgPath = path.join(charDir, 'character.json')

  let cfg = {}
  try {
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  } catch (e) {}

  const savedCategories = cfg.categories || {}
  const customRules = cfg.customCategoryRules || {}

  let modelFile = cfg.modelFile || null
  let cdiData = null
  let vtubeData = null
  let model3Data = null

  const allScannedFiles = scanFilesRecursively(modelDir)

  // 1. 寻找核心配置文件 (model3, cdi3, vtube)
  for (const f of allScannedFiles) {
    if (!modelFile && f.name.endsWith('.model3.json') && !f.name.includes('generated')) {
      modelFile = f.rel
    }
    if (!cdiData && f.name.endsWith('.cdi3.json')) {
      try { cdiData = JSON.parse(fs.readFileSync(f.full, 'utf8')) } catch (e) {}
    }
    if (!vtubeData && f.name.endsWith('.vtube.json')) {
      try { vtubeData = JSON.parse(fs.readFileSync(f.full, 'utf8')) } catch (e) {}
    }
  }

  // 2. 解析 .model3.json
  if (modelFile) {
    const mPath = path.join(modelDir, modelFile)
    if (fs.existsSync(mPath)) {
      try {
        model3Data = JSON.parse(fs.readFileSync(mPath, 'utf8'))
      } catch (e) {}
    }
  }

  const fRefs = (model3Data && model3Data.FileReferences) || {}

  // 检查是否在 model3 FileReferences 中指定了 DisplayInfo
  if (!cdiData && fRefs.DisplayInfo) {
    const cdiPath = path.join(modelDir, fRefs.DisplayInfo)
    if (fs.existsSync(cdiPath)) {
      try { cdiData = JSON.parse(fs.readFileSync(cdiPath, 'utf8')) } catch (e) {}
    }
  }

  // 构建 cdi3 参数字典
  const cdiParams = new Map()
  const cdiGroups = new Map()
  if (cdiData) {
    if (Array.isArray(cdiData.ParameterGroups)) {
      for (const g of cdiData.ParameterGroups) {
        cdiGroups.set(g.Id, g.Name)
      }
    }
    if (Array.isArray(cdiData.Parameters)) {
      for (const p of cdiData.Parameters) {
        cdiParams.set(p.Id, {
          name: p.Name,
          groupId: p.GroupId,
          groupName: cdiGroups.get(p.GroupId) || ''
        })
      }
    }
  }

  // 构建 vtube hotkey 字典
  const vtubeHotkeys = new Map()
  if (vtubeData && Array.isArray(vtubeData.Hotkeys)) {
    for (const h of vtubeData.Hotkeys) {
      if (h.File) {
        const cleanFile = h.File.replace(/\\/g, '/')
        const base = path.basename(cleanFile)
        const info = {
          name: h.Name,
          folder: h.Folder || '',
          action: h.Action || ''
        }
        vtubeHotkeys.set(cleanFile, info)
        vtubeHotkeys.set(base, info)
      }
    }
  }

  const expressions = []
  const motions = []

  const categories = {
    decor: [],
    scene: [],
    action: [],
    emotion: []
  }

  // 3. 处理所有动画动作文件 (.motion3.json)
  const motionFilesMap = new Map() // relPath -> { name, group, file }

  // 3a. 先从 model3.json 的 FileReferences.Motions 收集
  if (fRefs.Motions && typeof fRefs.Motions === 'object') {
    for (const [groupName, mList] of Object.entries(fRefs.Motions)) {
      if (Array.isArray(mList)) {
        for (const item of mList) {
          if (item && item.File) {
            const rel = item.File.replace(/\\/g, '/')
            motionFilesMap.set(rel, {
              file: rel,
              name: groupName || path.basename(rel, '.motion3.json'),
              group: groupName
            })
          }
        }
      }
    }
  }

  // 3b. 补充递归扫描到的所有 .motion3.json 文件
  for (const f of allScannedFiles) {
    if (f.name.endsWith('.motion3.json')) {
      if (!motionFilesMap.has(f.rel)) {
        motionFilesMap.set(f.rel, {
          file: f.rel,
          name: f.name.replace(/\.motion3\.json$/, ''),
          group: ''
        })
      }
    }
  }

  for (const [relPath, mMeta] of motionFilesMap.entries()) {
    let duration = 2.0
    const fullPath = path.join(modelDir, relPath)
    if (fs.existsSync(fullPath)) {
      try {
        const mData = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
        if (mData.Meta && mData.Meta.Duration) duration = mData.Meta.Duration
      } catch (e) {}
    }
    const motItem = {
      file: relPath,
      name: mMeta.name,
      duration,
      category: 'action'
    }
    motions.push(motItem)
    categories.action.push(relPath)
  }

  // 4. 处理所有表情与姿势文件 (.exp3.json)
  const expFilesMap = new Map() // relPath -> { file, name }

  // 4a. 先从 model3.json 的 FileReferences.Expressions 收集
  if (Array.isArray(fRefs.Expressions)) {
    for (const e of fRefs.Expressions) {
      if (e && e.File) {
        const rel = e.File.replace(/\\/g, '/')
        expFilesMap.set(rel, {
          file: rel,
          name: e.Name || path.basename(rel, '.exp3.json')
        })
      }
    }
  }

  // 4b. 补充递归扫描到的所有 .exp3.json 文件
  for (const f of allScannedFiles) {
    if (f.name.endsWith('.exp3.json')) {
      if (!expFilesMap.has(f.rel)) {
        expFilesMap.set(f.rel, {
          file: f.rel,
          name: f.name.replace(/\.exp3\.json$/, '')
        })
      }
    }
  }

  for (const [relPath, eMeta] of expFilesMap.entries()) {
    let params = []
    const fullPath = path.join(modelDir, relPath)
    if (fs.existsSync(fullPath)) {
      try {
        const expData = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
        params = (expData.Parameters || []).map((p) => ({
          id: p.Id,
          value: p.Value,
          blend: p.Blend || 'Add'
        }))
      } catch (e) {}
    }

    const baseName = path.basename(relPath, '.exp3.json')
    let resolvedName = eMeta.name || baseName
    let extraContext = ''

    // 智能提取名称：从 VTube Studio 热键或 CDI3 参数提取
    const vth = vtubeHotkeys.get(relPath) || vtubeHotkeys.get(baseName + '.exp3.json') || vtubeHotkeys.get(baseName)
    if (vth && vth.name && vth.name.trim()) {
      resolvedName = vth.name.trim()
      extraContext += ' ' + vth.folder
    } else if (params.length > 0) {
      const pInfo = cdiParams.get(params[0].id)
      if (pInfo && pInfo.name) {
        if (/^expression\d*$/i.test(resolvedName) || /^exp\d*$/i.test(resolvedName) || resolvedName === baseName) {
          resolvedName = pInfo.name
        }
        extraContext += ' ' + pInfo.groupName
      }
    }

    // 智能分类识别
    let detectedCategory = 'emotion'

    // A. 检查 character.json 中的用户持久化分类
    if (savedCategories.decor && (savedCategories.decor.includes(relPath) || savedCategories.decor.includes(baseName + '.exp3.json'))) {
      detectedCategory = 'decor'
    } else if (savedCategories.scene && (savedCategories.scene.includes(relPath) || savedCategories.scene.includes(baseName + '.exp3.json'))) {
      detectedCategory = 'scene'
    } else if (savedCategories.action && (savedCategories.action.includes(relPath) || savedCategories.action.includes(baseName + '.exp3.json'))) {
      detectedCategory = 'action'
    } else if (savedCategories.emotion && (savedCategories.emotion.includes(relPath) || savedCategories.emotion.includes(baseName + '.exp3.json'))) {
      detectedCategory = 'emotion'
    } else {
      // B. 规则分析 (结合自定义规则与默认规则)
      const textToAnalyze = `${resolvedName} ${baseName} ${extraContext}`
      const checkRule = (cat) => {
        const rules = (customRules[cat] || []).concat(DEFAULT_RULES[cat] || [])
        return rules.some((r) => {
          if (typeof r === 'string') return textToAnalyze.toLowerCase().includes(r.toLowerCase())
          if (r instanceof RegExp) return r.test(textToAnalyze)
          return false
        })
      }

      if (checkRule('action')) detectedCategory = 'action'
      else if (checkRule('scene')) detectedCategory = 'scene'
      else if (checkRule('emotion')) detectedCategory = 'emotion'
      else if (checkRule('decor')) detectedCategory = 'decor'
      else detectedCategory = 'emotion'
    }

    const expItem = {
      file: relPath,
      name: resolvedName,
      category: detectedCategory,
      params
    }
    expressions.push(expItem)
    if (!categories[detectedCategory].includes(relPath)) {
      categories[detectedCategory].push(relPath)
    }
  }

  // 5. 智能生成默认映射（若角色尚未配置或配置为空）
  const curExp = Object.assign({}, cfg.expressions || {})
  const curMot = Object.assign({}, cfg.motions || {})

  let shouldSaveConfig = false

  // 自动填充基础表情映射
  for (const [slot, pattern] of Object.entries(SLOT_MATCH_RULES.expressions)) {
    if (!curExp[slot]) {
      const match = expressions.find((e) => pattern.test(e.name) || pattern.test(e.file))
      if (match) {
        curExp[slot] = match.file
        shouldSaveConfig = true
      }
    }
  }

  // 自动填充动作映射 (idle, click, done)
  for (const [slot, pattern] of Object.entries(SLOT_MATCH_RULES.motions)) {
    if (!curMot[slot]) {
      const match = motions.find((m) => pattern.test(m.name) || pattern.test(m.file))
      if (match) {
        curMot[slot] = match.file
        shouldSaveConfig = true
      } else if (motions.length > 0 && slot === 'idle') {
        curMot[slot] = motions[0].file
        shouldSaveConfig = true
      }
    }
  }

  if (shouldSaveConfig && fs.existsSync(cfgPath)) {
    try {
      cfg.expressions = curExp
      cfg.motions = curMot
      cfg.categories = categories
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
    } catch (e) {}
  }

  return {
    characterId: path.basename(charDir),
    expressions,
    motions,
    categories,
    modelFile,
    currentMappings: {
      expressions: curExp,
      motions: curMot
    }
  }
}

/**
 * 保存用户自定义的资产分类映射到 character.json
 */
export function saveCharacterCategories(charDir, newCategories) {
  const cfgPath = path.join(charDir, 'character.json')
  let cfg = {}
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch (e) {}
  }
  cfg.categories = Object.assign(cfg.categories || {}, newCategories)
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
  return cfg.categories
}
