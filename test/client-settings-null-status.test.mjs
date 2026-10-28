/**
 * 回归测试（issue #14）：设置面板首帧 status 尚未就绪时必须渲染加载态，
 * 而不是让 generalEl 构造读 status.instanceId 抛 TypeError、整页退化成错误卡。
 *
 * client/index.js 在纯 Node 下可加载（文件头注释即为此设计），这里用带状态的
 * ordered-hooks React shim 经 __boot 拿到根组件后直接调用渲染，断言：
 *   1. status === null：渲染 sk-spin 加载态，__skErrors 无渲染错误；
 *   2. status 到达后：页签内容出现 instanceId（早退分支未吞掉正常渲染）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client', 'index.js'), 'utf8')

// 带状态的最小 React：useState 按 hook 顺序存到模块级数组，每次渲染前
// hookIdx 归零；setter 落盘后再次调用组件函数即为重渲染。
const hookState = []
let hookIdx = 0
let firstSetter = null
const MiniReact = {
  createElement(type, props, ...kids) {
    return { type, props: props || {}, kids: kids.flat(9).filter(k => k !== null && k !== undefined && k !== false) }
  },
  useState(init) {
    const i = hookIdx++
    if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init
    const setter = v => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }
    if (firstSetter === null) firstSetter = setter
    return [hookState[i], setter]
  },
  useEffect() {},
  useMemo(fn) { return fn() },
  useRef(v = null) { return { current: v } },
}

function bootClient() {
  const mod = { exports: {} }
  let renderedEl = null
  const fakeRequire = (name) => {
    if (name === 'react') return MiniReact
    if (name === 'react-dom/client') return { createRoot: () => ({ render: el => { renderedEl = el } }) }
    throw new Error('unexpected require: ' + name)
  }
  new Function('require', 'module', 'exports', 'window', src)(fakeRequire, mod, mod.exports, undefined)
  const t = (key, vars) => {
    let out = mod.exports.__internals.EN[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
    return out
  }
  mod.exports.__boot({ innerHTML: '' }, { t })
  assert.ok(renderedEl, '__boot 应触发根组件渲染')
  const render = () => { hookIdx = 0; return renderedEl.type(renderedEl.props) }
  return { render, setStatus: () => firstSetter }
}

// 深度收集渲染树里的 className 与文本
function collect(node, acc = { classes: new Set(), text: '' }) {
  if (node && typeof node === 'object' && (node.type || node.props)) {
    if (node.props && node.props.className) acc.classes.add(node.props.className)
    for (const k of node.kids || []) collect(k, acc)
    for (const v of Object.values(node.props || {})) if (typeof v === 'string') acc.text += ' ' + v
  } else if (typeof node === 'string' || typeof node === 'number') {
    acc.text += ' ' + String(node)
  }
  return acc
}

test('设置面板首帧（status=null）渲染加载态且无渲染错误（issue #14 回归）', () => {
  hookState.length = 0; hookIdx = 0; firstSetter = null
  const originalErrors = globalThis.__skErrors
  globalThis.__skErrors = []
  try {
    const { render } = bootClient()
    const acc = collect(render())
    assert.ok(acc.classes.has('sk-spin'), '首帧应渲染加载态 sk-spin，实际 classNames: ' + [...acc.classes].join(','))
    assert.ok(!acc.text.includes('⚠️'), '首帧不应出现错误卡')
    assert.deepEqual(globalThis.__skErrors, [], '渲染不应有被 catch 记录的错误: ' + globalThis.__skErrors.join(' | '))
  } finally {
    if (originalErrors === undefined) delete globalThis.__skErrors
    else globalThis.__skErrors = originalErrors
  }
})

test('status 到达后面板渲染 instanceId 与页签（issue #14 回归）', () => {
  hookState.length = 0; hookIdx = 0; firstSetter = null
  const { render, setStatus } = bootClient()
  render() // 首帧，hooks 就位
  setStatus()({ instanceId: 'inst-abc-123', syncing: false, protocols: {} })
  const acc = collect(render())
  assert.ok(acc.text.includes('inst-abc-123'), 'status 到达后应渲染 instanceId')
  assert.ok(acc.classes.has('sk-tabs'), 'status 到达后应渲染页签')
})
