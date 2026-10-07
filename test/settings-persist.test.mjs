/**
 * Settings persistence contract tests（回归「点保存配置→重启 dsh 回默认」）。
 *
 * 三块契约：
 *  1. 自持 settings.json 的解析与文件层优先级（不依赖宿主通道的持久化路径）；
 *  2. 导出的 Config 必须满足宿主 dsh-settings@0.2.0-rc.2 的判定
 *     （schema() 要求 "toJSON" in schema；volatileForm 要求存在 volatile 子节点；
 *     isVolatilePath 决定字段能否写回）——Config 为 undefined 正是原 bug 的根因；
 *  3. 自铸 Config（schemastery 缺失/过旧时的兜底）必须与该契约等价，
 *     否则降级路径会把同一个 bug 带回来。
 *
 * 下面的 plainSchema / volatileForm / isVolatilePath / projectForm 与宿主
 * app/node_modules/@deepseek-ai/dsh-settings/lib/index.js 逐行一致（仅去掉
 * redactSecrets 等与本契约无关的部分）。宿主里这些函数用 schemastery 实例，
 * 本仓库可能装不上 schemastery（无 node_modules），因此额外提供一份只用
 * 普通 JSON 的等价实现，保证断言在任何环境下都能跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mod = require('../src/index.js')
const I = mod.__internals
const DEFAULTS = I.DEFAULT_SYNC_SETTINGS

let z = null
try { z = require('@deepseek-ai/schemastery') } catch { z = null }
if (!z && typeof I.Schema === 'function') z = I.Schema

// ── 宿主 dsh-settings 的等价逻辑 ────────────────────────────────────────
function plainSchema(schema) {
  const result = new z(schema.toJSON())
  const walk = (node) => {
    delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === void 0 ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? void 0 : z.object(dict)
  }
  return undefined
}
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : (schema.dict ?? {})[key]
  return child !== undefined && isVolatilePath(child, rest)
}
function projectForm(schema, value) {
  if (value === undefined) return undefined
  if (schema.type !== 'object') return value
  const out = {}
  for (const [key, child] of Object.entries(schema.dict ?? {})) {
    const projected = projectForm(child, value[key])
    if (projected !== undefined) out[key] = projected
  }
  return out
}
// 宿主 settings.write() 的 schema 判定（lib/index.js L538-541 + L503-504）
const hostAcceptsSchema = (schema) => schema !== undefined && 'toJSON' in schema && volatileForm(schema) !== undefined

// 无 schemastery 时用普通 JSON 节点复刻同一判定（自铸 Config 的 toJSON 就是普通嵌套 JSON）
const plainVolatileForm = (node) => {
  if (node.meta && node.meta.volatile) return node
  if (node.type !== 'object') return undefined
  const dict = {}
  for (const [key, child] of Object.entries(node.dict ?? {})) {
    const field = plainVolatileForm(child)
    if (field !== undefined) dict[key] = field
  }
  return Object.keys(dict).length === 0 ? undefined : { type: 'object', meta: { ...(node.meta || {}) }, dict }
}
const isVolatilePathPlain = (node, path) => {
  if (node.meta && node.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : (node.dict ?? {})[key]
  return child !== undefined && isVolatilePathPlain(child, rest)
}
const isRefJson = (json) => json !== null && typeof json === 'object' && json.type === undefined && json.uid !== undefined

// toJSON() 可能是 schemastery 的 {uid,refs} 紧凑格式，也可能是自铸的普通嵌套 JSON
function rootJson(json) {
  if (isRefJson(json)) return json.refs[json.uid]
  return json
}
// 把 refs 紧凑格式展开成普通嵌套 JSON（自铸 Config 已经是普通格式，直接返回）
function resolveRefJson(json) {
  if (!isRefJson(json)) return json
  const seen = new Set()
  const walk = (node) => {
    if (typeof node === 'number') return walk(json.refs[node])
    if (!node || typeof node !== 'object' || seen.has(node)) return node
    seen.add(node)
    const out = { type: node.type, meta: { ...(node.meta || {}) } }
    if (node.dict) { out.dict = {}; for (const [k, v] of Object.entries(node.dict)) out.dict[k] = walk(v) }
    return out
  }
  return walk(json.refs[json.uid])
}

// ── 1. 自持设置文件 ────────────────────────────────────────────────────
test('parseSettingsFile: 只接受已知字段且类型一致的值', () => {
  assert.deepEqual(I.parseSettingsFile('not json'), {})
  assert.deepEqual(I.parseSettingsFile('[]'), {})
  assert.deepEqual(I.parseSettingsFile(JSON.stringify({ sync: null })), {})
  const raw = JSON.stringify({ version: 1, sync: {
    repoUrl: 'https://gitcode.com/me/private.git',
    token: 'tok',
    intervalMinutes: 45,
    autoSync: false,
    unknownField: 'x',
    branch: 42,            // 类型不符 → 丢弃（回落默认）
    webdavPassword: null,  // null → 丢弃
  } })
  assert.deepEqual(I.parseSettingsFile(raw), {
    repoUrl: 'https://gitcode.com/me/private.git',
    token: 'tok',
    intervalMinutes: 45,
    autoSync: false,
  })
})

test('parseSettingsFile: 空文件/损坏文件不会抛错', () => {
  assert.deepEqual(I.parseSettingsFile(''), {})
  assert.deepEqual(I.parseSettingsFile('{'), {})
  assert.deepEqual(I.parseSettingsFile('{"sync":{"repoUrl":"r"}}'), { repoUrl: 'r' })
})

test('pickFileSettingsLayer: 宿主文档晚于文件时让位，否则文件层生效', () => {
  const file = { repoUrl: 'r', intervalMinutes: 7 }
  assert.deepEqual(I.pickFileSettingsLayer(file, 0, 0), {})            // 文件未落盘
  assert.deepEqual(I.pickFileSettingsLayer({}, 1000, 0), {})           // 空文件层
  assert.deepEqual(I.pickFileSettingsLayer(file, 1000, 0), file)       // 无宿主写入 → 文件优先（重启恢复的关键）
  assert.deepEqual(I.pickFileSettingsLayer(file, 1000, 900), file)     // 宿主写入更早 → 文件仍优先
  assert.deepEqual(I.pickFileSettingsLayer(file, 1000, 1200), {})      // 宿主设置页刚写过 → 文档优先
})

// ── 2. Config 契约（原 bug 的根因面）────────────────────────────────────
test('Config 已导出且满足宿主 settings.write() 的 schema 判定', () => {
  assert.notEqual(mod.Config, undefined, 'Config 为 undefined ⟹ 宿主报 No configurable plugin entry')
  assert.equal('toJSON' in mod.Config, true)
  const info = I.getSchemaInfo()
  assert.ok(['schemastery', 'fallback', 'fallback-forced'].includes(info.schemaKind), 'schemaKind=' + info.schemaKind)
  if (info.schemaKind !== 'schemastery') {
    assert.ok(info.lastSchemasteryError, '降级原因必须可见（diag/日志都用它）')
  }
})

test('Config 暴露 sync 为 volatile 子对象且字段与默认值一一对应', () => {
  const root = resolveRefJson(mod.Config.toJSON())
  assert.equal(root.type, 'object')
  const sync = root.dict.sync
  assert.ok(sync, 'sync 子对象缺失 ⟹ volatileForm 返回 undefined ⟹ describe 不列出本插件')
  assert.equal(sync.meta.volatile, true)
  assert.deepEqual(Object.keys(sync.dict).sort(), Object.keys(DEFAULTS).sort())
  for (const [key, def] of Object.entries(DEFAULTS)) {
    assert.equal(sync.dict[key].type, typeof def === 'number' ? 'number' : typeof def === 'boolean' ? 'boolean' : 'string', key)
  }
})

// ── 3. 自铸 Config 与真实 schema 契约等价 ───────────────────────────────
const hostContract = (schema, label) => {
  assert.notEqual(schema, undefined, label + ': undefined')
  assert.equal('toJSON' in schema, true, label + ': 缺少 toJSON')
  const json = schema.toJSON()
  if (z) {
    const rebuilt = new z(json)   // 宿主 plainSchema 第一步
    assert.equal(rebuilt.type, 'object', label + ': rebuild 失败')
    assert.equal(rebuilt.dict.sync.meta.volatile, true, label + ': rebuild 后 sync 非 volatile')
    const form = volatileForm(schema)
    assert.notEqual(form, undefined, label + ': volatileForm 为空 ⟹ 宿主认为没有可写字段')
    assert.equal(isVolatilePath(schema, ['sync', 'repoUrl']), true, label + ': repoUrl 不可写')
    assert.equal(isVolatilePath(schema, ['repoUrl']), false, label + ': 根字段不应可写')
    const projected = projectForm(form, { sync: { repoUrl: 'r', intervalMinutes: 5 } })
    assert.deepEqual(projected, { sync: { repoUrl: 'r', intervalMinutes: 5 } }, label + ': projectForm 投影')
    assert.equal(hostAcceptsSchema(schema), true, label + ': 宿主 schema() 判定')
  } else {
    assert.equal(isRefJson(json), false, label + ': 无 schemastery 时 toJSON 必须是普通嵌套 JSON')
    assert.equal(plainVolatileForm(rootJson(json)) !== undefined, true, label + ': volatileForm(plain) 为空')
    assert.equal(isVolatilePathPlain(rootJson(json), ['sync', 'repoUrl']), true, label + ': repoUrl 不可写')
    assert.equal(isVolatilePathPlain(rootJson(json), ['repoUrl']), false, label + ': 根字段不应可写')
  }
}

test('自铸 Config（fallback）与导出的 Config 满足同一宿主契约', () => {
  hostContract(I.buildFallbackConfig(), 'fallback')
  hostContract(mod.Config, 'Config(' + I.getSchemaInfo().schemaKind + ')')
})

test('自铸 Config 的 validate 是同步 {value}（cordis resolveConfig 契约）', () => {
  const fallback = I.buildFallbackConfig()
  const std = fallback['~standard']
  assert.equal(typeof std.validate, 'function')
  const result = std.validate({ sync: { repoUrl: 'r' } })
  assert.equal(typeof result.then, 'undefined', '异步校验会被 cordis 拒绝')
  assert.deepEqual(result.value, { sync: { repoUrl: 'r' } })
  assert.equal(fallback['~standard'].validate(undefined).value instanceof Object, true)
})

test('parseClearedKeys: 墓碑只接受已知设置键', () => {
  assert.deepEqual(I.parseClearedKeys(JSON.stringify({ version: 1, sync: {}, cleared: ['repoUrl', 'token', 'nope', 42, null] })), ['repoUrl', 'token'])
  assert.deepEqual(I.parseClearedKeys(JSON.stringify({ version: 1, sync: {} })), [])
  assert.deepEqual(I.parseClearedKeys('{ 坏 JSON'), [])
  assert.deepEqual(I.parseClearedKeys(''), [])
  // 清除后再保存同键 ⇒ 墓碑必须被撤销（PUT 内 clearedKeys.delete）
  assert.deepEqual(I.parseClearedKeys(JSON.stringify({ version: 1, sync: { repoUrl: 'r' }, cleared: [] })), [])
})
