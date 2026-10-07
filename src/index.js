'use strict'

/**
 * dsh-plugin-dsh-sync — Host half
 *
 * A small sync/backup system for multiple dsh replicas. The git protocol
 * mirrors selected live roots into a private GitCode repository through a
 * branch → PR → merge flow, so two replicas that both touch the same file
 * surface as a pull request instead of a silent overwrite. WebDAV and a
 * local folder serve as additional pure-backup targets: each sync mirrors
 * the enabled groups into backup/<instanceId>/… — byte-for-byte the same
 * layout the git backup strategy uses — and never reads back over live.
 * Snapshots are protocol-universal: taken locally first, promoted to every
 * enabled target, restored by falling back through git → webdav → local.
 * Deterministic work (fetch / branch / commit / push) is done by the git
 * CLI directly; only the conflict step — which needs semantic judgement —
 * hands off to an in-process agent (same channel skills-management share
 * uses). Token is write-only through the host settings service and never
 * travels to the client in cleartext.
 *
 * Architecture: a shadow working tree at $DSH_HOME/dsh-sync/repo mirrors
 * selected live roots. Push = fetch origin/main → reset shadow to origin/main
 * → overlay live snapshot → branch → commit → push → create PR → mergeable?
 * merge (+ delete the sync branch) : surface a conflict action. Files both
 * sides changed (bothModified) are NOT pushed with the snapshot — the remote
 * version stays on main and the local version stays in live, and with
 * conflictMode=ai an in-process agent semantically merges them (same channel
 * skills-management share uses). First join (no common baseline) is a union:
 * remote-only files are restored instead of being deleted by the snapshot,
 * and a differing remote settings.yaml wins until an align merges per-key.
 * Pull = fetch → for files remote changed since lastSyncedCommit, write the
 * remote version back to live only when the local copy is untouched (three-
 * way; locally-modified files wait for the next push). Conflicts an agent
 * cannot auto-resolve stay open as PRs.
 */

const { execFile } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fsP = require('node:fs/promises')
const fsSync = require('node:fs')
const { join, relative, resolve, sep } = require('node:path')
const { homedir, hostname } = require('node:os')
const { createWebdavClient } = require('./webdav.js')
const { localMirrorSwap } = require('./backup.js')
// settings 服务要求 schemastery schema（可调用 + toJSON；zod 不兼容，register 会抛错被吞）。
// 宿主沙箱内解析打包依赖可能抛 ERR_INTERNAL_ASSERTION（.pnpm 软链），因此按候选次序
// 找一个真正可用的副本：插件自身依赖 → dsh 全局安装 → 宿主进程里已加载的副本 →
// 沿本文件向上的 node_modules（profile 提升目录）。每个候选都必须带 .volatile()
// （schemastery ≥3.18.4）：3.18.1 之类的旧副本会让 Config 变成 undefined，宿主
// settings 通道于是报 'No configurable plugin entry "dsh-sync"'——面板保存看着成功、
// 重启后回到默认值。全部候选都不可用时退回自铸 Config（buildFallbackConfig），
// 保证 Config 永不为 undefined。
let lastSchemasteryError = ''
let schemasterySource = ''
function schemasteryIsUsable(S) {
  try { return typeof S === 'function' && typeof S.object === 'function' && typeof S.object({}).volatile === 'function' } catch { return false }
}
function loadSchemastery() {
  const errors = []
  const { createRequire } = require('node:module')
  const candidates = []
  const add = (p) => { if (p && candidates.indexOf(p) === -1) candidates.push(p) }
  try { add(require.resolve('@deepseek-ai/schemastery')) } catch (e) { errors.push('resolve(self): ' + (e && e.code || e)) }
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, join(homedir(), '.local')].filter(Boolean)) {
    add(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'))
    add(join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'))
  }
  for (const cached of Object.keys(require.cache || {})) {
    if (/[\\/]schemastery[\\/]lib[\\/]index\.(c?js)$/.test(cached)) add(cached)
  }
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    add(join(dir, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'))
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  for (const candidate of candidates) {
    try {
      const S = createRequire(candidate)(candidate)
      if (schemasteryIsUsable(S)) { schemasterySource = candidate; return S }
      errors.push(candidate + ': 缺少 .volatile()（需 schemastery >= 3.18.4）')
    } catch (e) { errors.push(candidate + ': ' + (e && e.code || e)) }
  }
  try {
    const S = require('@deepseek-ai/schemastery')
    if (schemasteryIsUsable(S)) { schemasterySource = 'require:@deepseek-ai/schemastery'; return S }
    errors.push('require: 缺少 .volatile()')
  } catch (e) { errors.push('require: ' + (e && e.code || e)) }
  lastSchemasteryError = errors.join(' | ')
  console.warn('[dsh-sync] schemastery 不可用，改用自铸 Config（宿主设置写回可能失败，设置仍会持久化到本地文件）: ' + lastSchemasteryError)
  return null
}
const Schema = loadSchemastery()

// 自铸 Config：形状与 schemastery 的 toJSON() 等价（{type,meta,dict} 普通嵌套 JSON，
// 宿主 dsh-settings 的 plainSchema 会 new z(json) 重建），因此即便 schemastery 缺失或
// 过旧，宿主 settings 仍能识别 dsh-sync 的 volatile 字段（describe 列出 + update 写回）。
function buildFallbackConfig() {
  const fieldType = (value) => (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string')
  const fields = {}
  for (const [key, value] of Object.entries(DEFAULT_SYNC_SETTINGS)) fields[key] = { type: fieldType(value), meta: {} }
  const root = {
    type: 'object',
    meta: { default: {} },
    dict: { sync: { type: 'object', meta: { default: {}, volatile: true }, dict: fields } },
  }
  const jsonOf = (desc) => {
    const out = { type: desc.type, meta: { ...desc.meta } }
    if (desc.dict) {
      out.dict = {}
      for (const [key, child] of Object.entries(desc.dict)) out.dict[key] = jsonOf(child)
    }
    return out
  }
  // 每个节点都必须自带 toJSON()：宿主 volatileForm() 会在子节点上再次调用
  // plainSchema(child)（即 child.toJSON()），只给根节点 toJSON 会抛
  // "schema.toJSON is not a function"。
  const makeNode = (desc) => {
    const node = { type: desc.type, meta: { ...desc.meta } }
    if (desc.dict) {
      node.dict = {}
      for (const [key, child] of Object.entries(desc.dict)) node.dict[key] = makeNode(child)
    }
    node.toJSON = () => jsonOf(desc)
    return node
  }
  const instance = makeNode(root)
  instance['~standard'] = {
    version: 1,
    vendor: 'dsh-sync-fallback',
    validate: (input) => ({ value: input === undefined || input === null ? {} : input }),
  }
  return instance
}

// 自持设置文件（<DSH_HOME>/dsh-sync/settings.json）解析：只接受已知字段且类型一致的值。
function parseSettingsFile(raw) {
  const out = {}
  let parsed
  try { parsed = JSON.parse(raw) } catch { return out }
  const sync = parsed && typeof parsed === 'object' && parsed.sync && typeof parsed.sync === 'object' ? parsed.sync : null
  if (!sync) return out
  for (const key of Object.keys(DEFAULT_SYNC_SETTINGS)) {
    const v = sync[key]
    if (v === undefined || v === null) continue
    if (typeof DEFAULT_SYNC_SETTINGS[key] === typeof v) out[key] = v
  }
  return out
}

// 被显式清除（PUT 传 null）的键记进自持文件当"墓碑"：宿主 config 层（cordis.patch.yml
// 的 config.sync）在"宿主写回失败"的场景里仍留着旧值，只把 doc/file 层删掉的话，
// 重启后 baseSettings() 会把旧值带回来 —— 清除等于没清。重启后按墓碑把键压回默认值。
function parseClearedKeys(raw) {
  try {
    const parsed = JSON.parse(raw)
    const list = parsed && Array.isArray(parsed.cleared) ? parsed.cleared : []
    return list.filter((k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_SYNC_SETTINGS, k))
  } catch { return [] }
}

// 文件层与宿主文档层的取舍：默认取文件层（这正是「宿主写回失败时保存仍能跨重启生效」
// 的依据）；但宿主通道若在本文件之后写过（document-updated 事件更晚，或 profile 的
// cordis.patch.yml mtime 更晚），说明宿主通道确实生效且更新，则让位给宿主文档。
function pickFileSettingsLayer(fileSettings, fileMtime, hostWriteAt) {
  if (!fileMtime || !fileSettings || Object.keys(fileSettings).length === 0) return {}
  if (hostWriteAt && hostWriteAt > fileMtime) return {}
  return fileSettings
}

const GITCODE_API_BASE = 'https://api.gitcode.com/api/v5'
const MAX_BODY_BYTES = 64 * 1024
const SYNC_TIMEOUT_MS = 10 * 60 * 1000
const CONFLICT_RUN_TIMEOUT_MS = 30 * 60 * 1000
const CONFLICT_RUN_OUTPUT_CAP = 256 * 1024

const DEFAULT_SYNC_SETTINGS = {
  repoUrl: '',
  branch: 'main',
  gitBinary: 'git',
  token: '',                  // 写入 baseSettings 供 cordis.patch.yml config.sync.token 传入
  autoSync: true,
  syncOnStartup: false,
  intervalMinutes: 30,
  conflictMode: 'ai',   // 'ai' (action button → in-process agent) | 'manual'
  syncSkills: true,
  syncSessions: false,
  syncSettings: true,
  syncPlugins: true,
  // 每组独立策略：'backup' 各机云上独立备份（写 backup/<instanceId>/，本地永不被
  // 覆盖）| 'union' 并集同步（新增都收、逐文件三方、双方改动交 AI）| 'remote'
  // 覆盖·远端为准（本地只读镜像，远端删本地也删）| 'local' 覆盖·本地为准（远端只是回显）
  skillsStrategy: 'union',
  sessionsStrategy: 'backup',
  settingsStrategy: 'backup',
  pluginsStrategy: 'backup',
  snapshotSkills: false,      // 快照是否包含技能（体积大，默认只含 设置+插件清单）
  snapshotAuto: true,         // 每天首个同步自动打一份本地快照（auto-<日期>）
  snapshotLocalKeep: 30,      // 本地快照滚动保留份数（勾了云端的随时可从云端恢复）
  // ── 多协议备份：git（完整同步）+ webdav / local（纯备份目标）各一个开关。
  //    webdav/local 的内容与布局和 git 的 backup 策略一致：backup/<实例ID>/…
  //    （快照落 backup/<实例ID>/snapshots/<名字>/），本地永不读回覆盖。 ──
  gitEnabled: true,
  webdavEnabled: false,
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',         // 不回显；与 token 同语义（空串不覆盖、null 清除）
  webdavDir: 'dsh-sync',      // 服务器上的子目录：备份写 <url>/<dir>/backup/<实例ID>/
  localEnabled: false,
  localDir: '',               // 本地备份目录（支持 ~）：写 <dir>/backup/<实例ID>/
}

const STRATEGY_VALUES = ['backup', 'union', 'remote', 'local']

// ── 0.1.7 settings 接线 ──────────────────────────────────────────────────
// settings 服务不再支持 ctx.settings.register：改为模块顶层导出 volatile
// Config（宿主自动发现 + 自动生成设置页），读走 describe() 投影，写走
// ctx.settings.update()（持久化进 profile patch，重启不丢）。
// dsh-sync 的设置挂在插件 config 的 sync: 子对象下（与 cordis.patch.yml
// config.sync.token 传入形态一致），整个子对象标 volatile。

// 设置文档里的平铺字段（与旧版 settings.yaml 的 dsh-sync: 节同形）
function syncSettingsSchema(S) {
  return S.object({
    repoUrl: S.string(),
    branch: S.string(),
    gitBinary: S.string(),
    autoSync: S.boolean(),
    syncOnStartup: S.boolean(),
    intervalMinutes: S.number(),
    conflictMode: S.string(),
    syncSkills: S.boolean(),
    syncSessions: S.boolean(),
    syncSettings: S.boolean(),
    syncPlugins: S.boolean(),
    skillsStrategy: S.string(),
    sessionsStrategy: S.string(),
    settingsStrategy: S.string(),
    pluginsStrategy: S.string(),
    snapshotSkills: S.boolean(),
    snapshotAuto: S.boolean(),
    snapshotLocalKeep: S.number(),
    gitEnabled: S.boolean(),
    webdavEnabled: S.boolean(),
    webdavUrl: S.string(),
    webdavUsername: S.string(),
    webdavPassword: S.string(),
    webdavDir: S.string(),
    localEnabled: S.boolean(),
    localDir: S.string(),
    token: S.string(),
  })
}
// 降级值必须是 undefined 而非 null：宿主 settings 的 schema() 只排除 undefined，
// "toJSON" in null 会抛 TypeError 逃出 describe()，拖垮整份设置文档（同 dsh-continue#4）
let Config
let schemaKind = 'none'
try {
  Config = Schema
    ? Schema.object({
      sync: syncSettingsSchema(Schema).volatile(),
    })
    : buildFallbackConfig()
  schemaKind = Schema ? 'schemastery' : 'fallback'
} catch (e) {
  lastSchemasteryError = (lastSchemasteryError ? lastSchemasteryError + ' | ' : '') + 'Config: ' + (e && e.message)
  Config = buildFallbackConfig()
  schemaKind = 'fallback'
  console.warn('[dsh-sync] schemastery Config 构造失败，改用自铸 Config: ' + (e && e.message))
}
// 测试/排障钩子：强制走自铸 Config（验证无 schemastery 时宿主 settings 通道仍可用）
if (process.env.DSHSYNC_FORCE_FALLBACK_SCHEMA) {
  Config = buildFallbackConfig()
  schemaKind = 'fallback-forced'
}

// legacy settings.yaml.imported 读取（dsh 0.1.7 迁移残留；只支持平铺 key: value）
function legacySettingsPath() {
  return process.env.DSH_HOME ? join(resolve(process.env.DSH_HOME), 'settings.yaml.imported') : join(homedir(), '.dsh', 'settings.yaml.imported')
}
let __legacyYamlOverride
function __seedLegacyYaml(text) { __legacyYamlOverride = text === undefined ? undefined : text === null ? null : String(text) }
function readLegacyYaml() {
  if (__legacyYamlOverride !== undefined) return __legacyYamlOverride
  try { return require('node:fs').readFileSync(legacySettingsPath(), 'utf8') } catch { return null }
}
function parseLegacySettingsYaml(text) {
  try {
    const lines = String(text || '').split(/\r?\n/)
    const start = lines.findIndex((line) => /^dsh-sync:/.test(line))
    if (start === -1) return null
    const out = {}
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      if (!/^\s/.test(line)) break // 下一节开始
      const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/)
      if (!m) continue
      let raw = m[2].trim()
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1)
      else if (raw === 'true') raw = true
      else if (raw === 'false') raw = false
      else if (/^-?\d+(\.\d+)?$/.test(raw)) raw = Number(raw)
      out[m[1]] = raw
    }
    return out
  } catch { return null }
}

// ── Shared helpers (ported from skills-management so conventions match) ──

function dshHome() { return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh') }

function displayPath(p) {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length)
  return p
}

function expandTilde(p) {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p
}

function readJsonBody(req) {
  return new Promise((fulfil, reject) => {
    let size = 0, chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { fulfil(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(new Error(`invalid JSON body: ${error && error.message}`)) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

async function atomicWriteFile(file, content) {
  await fsP.mkdir(join(file, '..'), { recursive: true })
  const temp = join(join(file, '..'), `.${randomUUID()}.tmp`)
  await fsP.writeFile(temp, content)
  await fsP.rename(temp, file)
}

// ── MSYS2 path-conversion guard (Git for Windows) ──
//
// 症状：Windows 上路径里的「点」被当成路径分隔符——`C:\Users\x\.dsh\dsh-sync\repo`
// 变成 `C:\Users\x\dsh\dsh-sync\repo`（`.` 消失、多出一级目录），git 因此在不存在的
// 目录里执行 → fetch failed。手动在正确目录跑 git 却成功。
//
// 根因：Git for Windows 的 MSYS2 runtime 在调用原生 .exe 时会重写 argv，按 POSIX 规则
// 做路径转换（`/`→`\`、`:`→`;`、`.` 按路径段处理）。官方定性为 wontfix：
//   https://github.com/git-for-windows/git/issues/685
// 官方绕过开关（https://github.com/git-for-windows/build-extra/issues/376 亦收录）：
//   MSYS_NO_PATHCONV=1        — Git for Windows 专有
//   MSYS2_ARG_CONV_EXCL='*'   — 上游 MSYS2 通用（结尾是 L）
//
// 两条纪律（都有实证依据）：
//   1. **只注入给 git 子进程**，绝不写 process.env 全局——全局设置会"wreck havoc"，
//      Git for Windows 专门开了 warning 提醒（build-extra#376）；ani-cli#715 实测
//      全局设它会连带弄坏 gVim/nvim 找文件。
//   2. 变量名必须是 MSYS2_ARG_CONV_EXCL（结尾 L），拼错静默失效。
//
// 注意：本插件的 git 调用走 execFile（不启 shell），正常情况压根不经过 MSYS2 runtime，
// 注入这两个变量对它是无害的 no-op。真正需要它的是**经 bash 的调用**（agent 会话里
// 模型按提示词执行的 git 命令），以及 future-proof：万一 binary 被换成 shim/wrapper。
// 见 test/win-pathconv.test.mjs 的契约测试。
function msysPathConvEnv() {
  if (process.platform !== 'win32') return undefined
  return {
    MSYS_NO_PATHCONV: '1',
    MSYS2_ARG_CONV_EXCL: '*',
  }
}

// ── Git CLI (token stays out of .git/config — authed URL per command) ──

function gitExec(binary, args, cwd, authEnv) {
  return new Promise((fulfil, reject) => {
    const opts = { cwd, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }
    // 凭据经 GIT_ASKPASS env 注入（askpass 脚本从 DSH_SYNC_TOKEN 取值）——
    // argv 不携带 token（ps 全机可见），.git/config 也不落盘。
    // Windows 额外注入 MSYS2 路径转换开关（见上方 msysPathConvEnv 注释）。
    const env = { ...process.env, ...(msysPathConvEnv() || {}), ...(authEnv || {}) }
    opts.env = env
    execFile(binary, args, opts, (error, stdout, stderr) => {
      if (error) {
        const tail = String(stderr || error.message || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' ')
        reject(new Error(`git ${args[0]}: ${tail || error.message}`))
        return
      }
      fulfil(String(stdout))
    })
  })
}

function gitShowBuf(binary, rev, cwd) {
  // raw bytes for binary-safe compare/copy (session logs are zstd)
  return new Promise((fulfil, reject) => {
    execFile(binary, ['show', rev], { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
      if (error) { reject(new Error(`git show: ${String(error.message || '')}`)); return }
      fulfil(stdout)
    })
  })
}

async function gitAvailable(binary) {
  try { await gitExec(binary, ['--version']); return true } catch { return false }
}

// /status 每请求 spawn 一次 `git --version`，面板 15s 轮询 + 多标签页时全是进程
// 开销；git 是否可用在一分钟内不会变，缓存 60s（同步/浏览等真正要用 git 的路径
// 仍走 gitAvailable 拿实时结果）。
let gitProbeCache = null
async function gitAvailableCached(binary, ttlMs = 60000) {
  const now = Date.now()
  if (gitProbeCache && gitProbeCache.binary === binary && now - gitProbeCache.at < ttlMs) return gitProbeCache.ok
  const ok = await gitAvailable(binary)
  gitProbeCache = { binary, ok, at: Date.now() }
  return ok
}

async function gitCurrentCommit(binary, repo) {
  try { return (await gitExec(binary, ['rev-parse', 'HEAD'], repo)).trim() } catch { return undefined }
}

// ── Git credentials: env-side, never argv. A git subprocess's argv is
//    world-readable via ps, so the token must not appear there. Remote-touching
//    commands get a clean URL plus GIT_ASKPASS: git answers its 401 credential
//    prompt from DSH_SYNC_TOKEN, which only lives in the child's environment
//    (readable by the process owner, not by other local users). ──

const ASKPASS_SH = [
  '#!/bin/sh',
  '# dsh-sync askpass: username prompt → $DSH_SYNC_USER (provider-specific,',
  '# default oauth2; GitHub wants x-access-token), anything else → the sync token',
  'case "$1" in',
  '  Username*) echo "${DSH_SYNC_USER:-oauth2}" ;;',
  '  *) echo "$DSH_SYNC_TOKEN" ;;',
  'esac',
].join('\n') + '\n'

function askpassPath() { return join(dshHome(), 'dsh-sync', '.askpass.sh') }

/** Install the askpass helper under $DSH_HOME/dsh-sync. Idempotent. */
async function writeAskpass() {
  const p = askpassPath()
  await fsP.mkdir(join(p, '..'), { recursive: true })
  await atomicWriteFile(p, ASKPASS_SH)
  await fsP.chmod(p, 0o755).catch(() => {})
  return p
}

/** Extra env for remote-touching git commands. `undefined` when no token is
 *  configured (public/local remotes need no auth). */
function gitAuthEnv(eff) {
  if (!eff || !eff.token) return undefined
  return {
    GIT_ASKPASS: askpassPath(), DSH_SYNC_TOKEN: String(eff.token), GIT_TERMINAL_PROMPT: '0',
    // GitHub HTTPS 不接受任意用户名（要 x-access-token），GitLab/其它 oauth2 即可
    DSH_SYNC_USER: gitUsernameForProvider(eff.repoUrl),
  }
}

/** HTTPS username for token auth, per provider. */
function gitUsernameForProvider(repoUrl) {
  const kind = detectRepoProvider(repoUrl).kind
  return kind === 'github' ? 'x-access-token' : 'oauth2'
}

// ── Cross-process lock: tui + web profiles run the same $DSH_HOME, so two
//    sync loops could write the shadow tree at once. O_EXCL atomic create. ──

async function acquireLock(lockFile) {
  const fs = require('node:fs')
  try {
    const handle = fs.openSync(lockFile, 'wx')
    fs.writeSync(handle, String(process.pid))
    fs.closeSync(handle)
    return () => { try { fs.unlinkSync(lockFile) } catch {} }
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 首装竞态：syncDir 还没建（state 铸造的 mkdir 未跑完）——补建后重试一次
      try { fs.mkdirSync(join(lockFile, '..'), { recursive: true }); const handle = fs.openSync(lockFile, 'wx'); fs.writeSync(handle, String(process.pid)); fs.closeSync(handle); return () => { try { fs.unlinkSync(lockFile) } catch {} } } catch {}
    }
    if (e.code === 'EEXIST') {
      // stale-lock recovery: a crashed process leaves a lock; if its pid is
      // gone, steal it. Otherwise someone else is syncing.
      try {
        const pid = parseInt(String(fs.readFileSync(lockFile, 'utf8')).trim(), 10)
        if (Number.isFinite(pid)) {
          try { process.kill(pid, 0); return null } catch { /* pid dead → steal */ }
        }
        fs.unlinkSync(lockFile)
        const handle = fs.openSync(lockFile, 'wx')
        fs.writeSync(handle, String(process.pid))
        fs.closeSync(handle)
        return () => { try { fs.unlinkSync(lockFile) } catch {} }
      } catch { return null }
    }
    throw e
  }
}

// ── GitCode REST: repo privacy check + PR create / detail / merge ──

/** Parse `https://gitcode.com/<owner>/<repo>(.git)` → { owner, repo }. */
function parseRepoUrl(url) {
  const m = String(url || '').match(/gitcode\.com\/([^/]+)\/([^/?.]+?)(?:\.git)?(?:[/?#]|$)/i)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

const PROVIDER_LABEL = { gitcode: 'GitCode', github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee', generic: '自建/未知主机' }

/** Identify the hosting provider from a remote URL. Never throws: anything that
 *  is not one of the three known hosts is 'generic' (self-hosted / unknown) —
 *  which is exactly the case where privacy cannot be verified remotely. */
function detectRepoProvider(url) {
  const raw = String(url || '').trim()
  if (!raw) return { kind: 'none', host: '', owner: '', repo: '' }
  let host = '', pathname = ''
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : raw.replace(/^git@([^:]+):/, 'https://$1/'))
    host = u.hostname.toLowerCase()
    pathname = u.pathname
  } catch {
    const m = raw.match(/^([^/:@]+)[:/](.+)$/)
    if (!m) return { kind: 'generic', host: '', owner: '', repo: '' }
    host = String(m[1]).toLowerCase()
    pathname = '/' + m[2]
  }
  const segs = pathname.replace(/^\/+/, '').replace(/\.git$/i, '').split('/').filter(Boolean)
  const owner = segs.length >= 2 ? segs.slice(0, -1).join('/') : ''
  const repo = segs.length >= 2 ? segs[segs.length - 1] : (segs[0] || '')
  let kind = 'generic'
  if (/(^|\.)gitcode\.(com|net)$/.test(host)) kind = 'gitcode'
  else if (/(^|\.)github\.com$/.test(host)) kind = 'github'
  else if (/(^|\.)gitlab\.com$/.test(host)) kind = 'gitlab'
  else if (/(^|\.)gitee\.com$/.test(host)) kind = 'gitee'
  return { kind, host, owner, repo }
}

async function jsonOrNull(r) {
  try { const t = await r.text(); return t === '' ? null : JSON.parse(t) } catch { return null }
}

/** Ask a known provider's REST API for repo metadata (private flag + default branch). */
async function providerRepoInfo(provider, token) {
  const { kind, owner, repo } = provider
  if (kind === 'github') {
    const r = await fetch('https://api.github.com/repos/' + owner + '/' + repo, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-sync', 'X-GitHub-Api-Version': '2022-11-28' },
    })
    const json = await jsonOrNull(r)
    return { ok: r.ok, status: r.status, privateFlag: json && json.private === true, defaultBranch: json && json.default_branch, json }
  }
  if (kind === 'gitee') {
    const r = await fetch('https://gitee.com/api/v5/repos/' + owner + '/' + repo + '?access_token=' + encodeURIComponent(token))
    const json = await jsonOrNull(r)
    return { ok: r.ok, status: r.status, privateFlag: json && (json.private === true || json.public === false), defaultBranch: json && json.default_branch, json }
  }
  // gitlab：项目路径要整体 urlencode（支持嵌套 group）
  const r = await fetch('https://gitlab.com/api/v4/projects/' + encodeURIComponent(owner + '/' + repo), {
    headers: { 'PRIVATE-TOKEN': token },
  })
  const json = await jsonOrNull(r)
  const vis = json && json.visibility
  return { ok: r.ok, status: r.status, privateFlag: vis ? vis !== 'public' : (json && json.private === true), defaultBranch: json && json.default_branch, json }
}

/** Provider-aware "is this repo private?" gate.
 *
 *  This gate is the ONLY protection against leaking credentials: the settings
 *  group mirrors ~/.dsh/settings.yaml wholesale, and other plugins keep plain
 *  secrets there. GitCode/GitHub/GitLab/Gitee can be asked; a self-hosted or
 *  unknown host cannot be judged at all, so the caller must make the user
 *  confirm the risk (needConfirm + code UNVERIFIED_REPO) before we accept it. */
async function checkRepoAccess(token, repoUrl, { allowUnverified = false } = {}) {
  const provider = detectRepoProvider(repoUrl)
  if (!provider.owner || !provider.repo) {
    return { ok: false, provider, error: '无法解析仓库地址（需要 https://<host>/<owner>/<repo> 这类完整地址）' }
  }
  if (provider.kind === 'gitcode') {
    const r = await checkRepoPrivate(token, repoUrl)
    return { ...r, provider, verified: true, unverified: false }
  }
  if (provider.kind === 'generic') {
    if (allowUnverified) return { ok: true, provider, verified: false, unverified: true }
    return {
      ok: false, provider, verified: false, unverified: true, needConfirm: true, code: 'UNVERIFIED_REPO',
      error: '无法校验 ' + (provider.host || '该主机') + ' 上的仓库是否为私有（dsh-sync 只识别 GitCode/GitHub/GitLab/Gitee 的私有性）。'
        + '如果它其实是公开仓库，第一次同步会把本机 settings.yaml（可能含其它插件的明文密钥）推上去，造成密钥泄露。'
        + '请确认该仓库为私有后再继续。',
    }
  }
  const label = PROVIDER_LABEL[provider.kind]
  let info
  try { info = await providerRepoInfo(provider, token) } catch (e) {
    return { ok: false, provider, verified: true, unverified: false, error: '无法访问 ' + label + ' 仓库：' + String(e && e.message || e) }
  }
  if (!info.ok) {
    return { ok: false, provider, verified: true, unverified: false, error: '无法访问仓库（HTTP ' + info.status + '）：' + ((info.json && (info.json.message || info.json.error)) || '') }
  }
  if (info.privateFlag !== true) {
    return {
      ok: false, provider, verified: true, unverified: false, isPublic: true,
      error: '检测到公共仓库（' + label + '：' + provider.owner + '/' + provider.repo + '）。dsh-sync 会同步含凭证的 settings.yaml，'
        + '必须使用私有仓库——请先把仓库设为私有，再保存。',
    }
  }
  return { ok: true, provider, verified: true, unverified: false, owner: provider.owner, repo: provider.repo, defaultBranch: info.defaultBranch || 'main' }
}

async function gitcodeRequest(token, method, path, body, { apiBase = GITCODE_API_BASE } = {}) {
  const url = apiBase + path
  // 认证必须用 PRIVATE-TOKEN（实测 GitCode 子资源端点 branches/pulls 对
  // Authorization: Bearer 有 bug——带 Bearer 查 project 一律 404 not found，
  // 匿名 / PRIVATE-TOKEN / access_token query 均正常）
  const init = { method, headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(url, init)
  const text = await r.text()
  let json = null
  try { json = text === '' ? null : JSON.parse(text) } catch {}
  return { ok: r.ok, status: r.status, json, text }
}

/** Verify the configured repo exists AND is private. Public repos are refused
 *  because sync carries credentials (settings.yaml is mirrored wholesale). */
async function checkRepoPrivate(token, repoUrl) {
  const parsed = parseRepoUrl(repoUrl)
  if (!parsed) return { ok: false, error: '无法解析仓库地址（需要 https://gitcode.com/<owner>/<repo>）' }
  const r = await gitcodeRequest(token, 'GET', `/repos/${parsed.owner}/${parsed.repo}`)
  if (!r.ok) return { ok: false, error: `无法访问仓库（HTTP ${r.status}）：${(r.json && r.json.message) || r.text.slice(0, 120)}` }
  const priv = r.json && (r.json.private === true || r.json.private === 'true')
  if (!priv) return { ok: false, error: '检测到公共仓库。dsh-sync 会同步含凭证的 settings.yaml，必须使用私有仓库——请到 gitcode.com 将该仓库设为私有，或新建私有仓库后再填地址。', isPublic: true }
  return { ok: true, owner: parsed.owner, repo: parsed.repo, defaultBranch: r.json && (r.json.default_branch || 'main') }
}

async function createPullRequest(token, owner, repo, { head, base, title, body }) {
  return gitcodeRequest(token, 'POST', `/repos/${owner}/${repo}/pulls`, { head, base, title: title || 'dsh-sync', body: body || '' })
}

async function getPullRequest(token, owner, repo, number) {
  return gitcodeRequest(token, 'GET', `/repos/${owner}/${repo}/pulls/${number}`)
}

async function mergePullRequest(token, owner, repo, number, method) {
  return gitcodeRequest(token, 'PUT', `/repos/${owner}/${repo}/pulls/${number}/merge`, method ? { merge_method: method } : {})
}

// ── Sync spec: which live roots mirror into which shadow paths ──
//    Four toggle groups; a group's sources are only active when its switch
//    is on. Built fresh each cycle from the effective settings. `roots` is
//    injectable so tests never touch the real $HOME.

function defaultRoots() {
  const home = homedir()
  const dh = dshHome()
  return {
    dshSkills: join(dh, 'skills'),
    agentsSkills: join(home, '.agents', 'skills'),
    agentsLock: join(home, '.agents', '.skill-lock.json'),
    // 无点目录 ~/agents/skills：部分 agent 工具的技能根（目录不存在时静默跳过）
    homeAgentsSkills: join(home, 'agents', 'skills'),
    sessions: join(dh, 'sessions'),
    settingsFile: join(dh, 'settings.yaml'),
    profiles: join(dh, 'profiles'),
  }
}

function syncSpec(eff, roots = defaultRoots(), instanceId = 'instance') {
  const backup = (to) => `backup/${instanceId}/${to}`
  const groups = []
  const skillsStrategy = STRATEGY_VALUES.includes(eff.skillsStrategy) ? eff.skillsStrategy : 'union'
  const sessionsStrategy = STRATEGY_VALUES.includes(eff.sessionsStrategy) ? eff.sessionsStrategy : 'backup'
  const settingsStrategy = STRATEGY_VALUES.includes(eff.settingsStrategy) ? eff.settingsStrategy : 'backup'
  const pluginsStrategy = STRATEGY_VALUES.includes(eff.pluginsStrategy) ? eff.pluginsStrategy : 'backup'
  if (eff.syncSkills) groups.push({
    name: 'skills', strategy: skillsStrategy,
    sources: [
      { from: roots.dshSkills, to: skillsStrategy === 'backup' ? backup('skills/dsh') : 'skills/dsh' },
      // 软链解引用成实文件：跨机不能指望同一个 link target 存在
      { from: roots.agentsSkills, to: skillsStrategy === 'backup' ? backup('skills/agents') : 'skills/agents', followSymlinks: true },
      // ~/agents/skills（无点）：云上用 agents-home 与 skills/agents 区分；
      // skills/agents-home 与 skills/agents 无前缀包含关系，resolveLivePath 不会串
      { from: roots.homeAgentsSkills, to: skillsStrategy === 'backup' ? backup('skills/agents-home') : 'skills/agents-home', followSymlinks: true },
      { from: roots.agentsLock, to: skillsStrategy === 'backup' ? backup('skills/.skill-lock.json') : 'skills/.skill-lock.json', file: true },
    ],
  })
  if (eff.syncSessions) groups.push({
    name: 'sessions', strategy: sessionsStrategy,
    sources: [{ from: roots.sessions, to: sessionsStrategy === 'backup' ? backup('sessions') : 'sessions', excludeNames: new Set(['session_projcache.json']) }],
  })
  if (eff.syncSettings) groups.push({
    name: 'settings', strategy: settingsStrategy,
    // 整文件同步、不脱敏——前提是私仓校验通过
    sources: [{ from: roots.settingsFile, to: settingsStrategy === 'backup' ? backup('settings/settings.yaml') : 'settings/settings.yaml', file: true }],
  })
  if (eff.syncPlugins) groups.push({
    name: 'plugins', strategy: pluginsStrategy,
    sources: [{
      from: roots.profiles, to: pluginsStrategy === 'backup' ? backup('plugins') : 'plugins',
      // 只存声明：package.json / patch / 锁文件。node_modules 按机重装，
      // .dsh-market 是市场缓存，cordis.yml 是 loader 产物（可重建）
      includeFiles: new Set(['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']),
      excludeDirs: new Set(['node_modules', '.dsh-market']),
      excludeNames: new Set(['cordis.yml']),
    }],
  })
  return groups
}

/** shadow 相对路径所属组的策略（不在任何组内 → undefined）。 */
function strategyForPath(spec, shadowRel) {
  const norm = shadowRel.split(sep).join('/')
  for (const group of spec) {
    for (const src of group.sources) {
      const to = src.to.split(sep).join('/')
      if (norm === to || norm.startsWith(to + '/')) return group.strategy
    }
  }
  return undefined
}

async function copyTree(from, to, opts) {
  const { includeFiles, excludeDirs, excludeNames, followSymlinks } = opts || {}
  await fsP.mkdir(to, { recursive: true })
  let entries
  try { entries = await fsP.readdir(from, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    if (ent.name === '.git') continue
    if (ent.isDirectory()) {
      if (excludeDirs && excludeDirs.has(ent.name)) continue
      await copyTree(join(from, ent.name), join(to, ent.name), opts)
    } else {
      if (excludeNames && excludeNames.has(ent.name)) continue
      if (includeFiles && !includeFiles.has(ent.name)) continue
      let stat
      try { stat = followSymlinks ? await fsP.stat(join(from, ent.name)) : ent } catch { continue }
      if (!stat || !stat.isFile()) continue
      try { await fsP.copyFile(join(from, ent.name), join(to, ent.name)) } catch {}
    }
  }
}

/** Push a live snapshot into the shadow tree (shadow = live after this). */
async function mirrorLiveToShadow(spec, shadowDir) {
  for (const group of spec) {
    for (const src of group.sources) {
      const target = join(shadowDir, src.to)
      if (src.file) {
        try {
          await fsP.access(src.from)
          await fsP.mkdir(join(target, '..'), { recursive: true })
          await fsP.copyFile(src.from, target)
        } catch { try { await fsP.unlink(target) } catch {} }
      } else {
        await fsP.rm(target, { recursive: true, force: true }).catch(() => {})
        await copyTree(src.from, target, {
          includeFiles: src.includeFiles,
          excludeDirs: src.excludeDirs,
          excludeNames: src.excludeNames,
          followSymlinks: src.followSymlinks,
        })
      }
    }
  }
}

/** Reverse-resolve a shadow-relative path back to its live absolute path. */
function resolveLivePath(spec, shadowRel) {
  const norm = shadowRel.split(sep).join('/')
  for (const group of spec) {
    for (const src of group.sources) {
      if (!src.from) continue   // 注入 roots 可缺省某根（测试/裁剪场景）
      const to = src.to.split(sep).join('/')
      if (src.file) {
        if (norm === to) return src.from
      } else if (norm === to) {
        return src.from
      } else if (norm.startsWith(to + '/')) {
        return join(src.from, norm.slice(to.length + 1))
      }
    }
  }
  return undefined
}

// ── Shadow repo lifecycle ──

async function ensureShadowRepo(binary, eff, repoDir) {
  const remote = eff.repoUrl, authEnv = gitAuthEnv(eff)
  let exists = false
  try { await fsP.access(join(repoDir, '.git')); exists = true } catch { exists = false }
  if (!exists) {
    await fsP.rm(repoDir, { recursive: true, force: true }).catch(() => {})
    await fsP.mkdir(join(repoDir, '..'), { recursive: true })
    // 干净 URL + GIT_ASKPASS：clone 不经 argv 携带凭证，.git/config 也不落盘
    try {
      await gitExec(binary, ['clone', '-b', eff.branch, '--depth', '1', remote, repoDir], undefined, authEnv)
    } catch {
      await fsP.mkdir(repoDir, { recursive: true })
      await gitExec(binary, ['init', '-b', eff.branch], repoDir)
      // .gitattributes: append-only jsonl logs merge as union, not conflict
      await atomicWriteFile(join(repoDir, '.gitattributes'), '*.jsonl merge=union\n')
    }
  }
  return remote
}

// ── Three-way push: local deltas → branch → PR → merge | conflict ──

async function runPush(binary, eff, { repoDir, instanceId, state, logger, roots, preserve }) {
  const remote = await ensureShadowRepo(binary, eff, repoDir)
  const authEnv = gitAuthEnv(eff)
  const spec = syncSpec(eff, roots, instanceId)
  // 首次接入判定必须在任何基线推进之前读
  const firstJoin = !state.lastSyncedCommit
  let settingsPreserved = false

  // 1. fetch origin/main → FETCH_HEAD (canonical baseline)
  try { await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv) } catch (e) {
    // first-ever push to an empty remote: no main yet, skip fetch
    if (!/could ?n[o']?t find|doesn't exist|no such|unborn|empty/i.test(String(e && e.message))) throw e
  }

  // 2. branch off FETCH_HEAD (or HEAD if remote was empty), reset shadow to it
  const hasRemote = (await gitExec(binary, ['rev-parse', '--verify', 'FETCH_HEAD'], repoDir).then(() => true).catch(() => false))
  const baseRef = hasRemote ? 'FETCH_HEAD' : 'HEAD'
  const branch = `sync/${instanceId}/${Date.now()}`
  // detach onto base so the working tree reflects the canonical baseline
  await gitExec(binary, ['checkout', '--detach', baseRef], repoDir).catch(() => {})
  // 3. overlay live snapshot onto the baseline: shadow now = baseline + local deltas
  // remote（覆盖·远端为准）组本地是只读镜像：不推送本机版本
  await mirrorLiveToShadow(spec.filter(g => g.strategy !== 'remote'), repoDir)

  if (firstJoin && hasRemote) {
    // 首次接入 = 并集加入。全量快照覆盖会把"远端有、本机没有"的文件当作本地删除
    // 推出去（实测新机首推从 main 删掉另一台机器 1.3 万个文件）。没有共同基线时
    // 无法区分"本地删过"和"本地从来没有"，一律按后者处理：恢复远端独有文件。
    // 自己的 backup/<instanceId>/ 前缀除外——备份就该镜像当前 live，陈旧备份不回魂。
    const ownBackupPrefix = `backup/${instanceId}/`
    let deletedRaw = ''
    try { deletedRaw = await gitExec(binary, ['diff', '--name-only', '--diff-filter=D', 'FETCH_HEAD'], repoDir) } catch {}
    for (const p of deletedRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      if (p.startsWith(ownBackupPrefix)) continue
      await gitExec(binary, ['checkout', 'FETCH_HEAD', '--', p], repoDir).catch(() => {})
    }
    // settings.yaml 带各机凭证与模型配置：首次接入若与本机不同，整文件覆盖会在下次
    // pull 时把对端机器的配置整份换掉（实测打挂过对端 LLM 供应商配置）。保留远端
    // 版本，差异留给 AI 智能对齐做逐键合并。
    let remoteSettings = null
    try { remoteSettings = await gitShowBuf(binary, 'FETCH_HEAD:settings/settings.yaml', repoDir) } catch { remoteSettings = null }
    if (remoteSettings !== null) {
      const shadowSettings = await fsP.readFile(join(repoDir, 'settings', 'settings.yaml')).catch(() => null)
      if (!shadowSettings || Buffer.compare(shadowSettings, remoteSettings) !== 0) {
        await atomicWriteFile(join(repoDir, 'settings', 'settings.yaml'), remoteSettings)
        settingsPreserved = true
      }
    }
  }

  // 双方都改过的文件不随快照覆盖推送：恢复成远端版本，交给 AI 智能对齐/用户裁决。
  // 否则本分支永远基于 main tip、PR 恒可合并 = 对端改动被静默覆盖（真机实证）。
  for (const p of preserve || []) {
    await gitExec(binary, ['checkout', 'FETCH_HEAD', '--', p], repoDir).catch(() => {})
  }

  // 未合并/异常返回时把影子仓库 HEAD 与基线拉回远端 main：否则 HEAD 停在 sync 分支上，
  // 下一轮若 fetch 失败或 reconcile 的 reset 落空，lastSyncedCommit 会被记成分支 tip
  // （真机实证：基线变成 branch tip 后与远端 main 分叉 → 全库误判 bothModified 挂账）
  let advancedToMain = false
  const restoreBaseline = async () => {
    await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv).catch(() => {})
    await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
    state.lastSyncedCommit = (await gitCurrentCommit(binary, repoDir)) || state.lastSyncedCommit
  }

  // 4. commit on a fresh branch
  await gitExec(binary, ['checkout', '-b', branch], repoDir)
  await gitExec(binary, ['add', '-A'], repoDir)
  let commitOk = false
  try { await gitExec(binary, ['-c', 'user.name=dsh-sync', '-c', 'user.email=dsh-sync@local', 'commit', '-m', `sync ${instanceId} ${new Date().toISOString()}`], repoDir); commitOk = true } catch { /* nothing to commit */ }
  if (!commitOk) { await restoreBaseline(); return { pushed: false, nothingToCommit: true } }

  // 5. push the branch (token in URL, not in config)
  await gitExec(binary, ['push', remote, `HEAD:${branch}`], repoDir, authEnv)

  // 6. create PR + mergeable check
  //    未推进到 main 的每个出口（409、冲突 PR、创建/合并抛错）都要恢复基线：否则 HEAD
  //    停在 sync 分支上，下一轮 fetch/reset 落空时 lastSyncedCommit 会被记成分支 tip，
  //    与远端 main 分叉 → 全库误判 bothModified 挂账（真机实证）
  try {
    const parsed = parseRepoUrl(eff.repoUrl)
    if (!parsed) {
      // non-GitCode remote (local test, self-hosted git): push the branch only;
      // PR create/merge is GitCode-specific and skipped. Advance shadow onto
      // main as the next cycle's pull baseline.
      await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv).catch(() => {})
      await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
      await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
      state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
      state.lastPushedBranch = branch
      advancedToMain = true
      return { pushed: true, prSkipped: true, branch, settingsPreserved }
    }
    // 同仓库 PR 的 head 就是分支名（`user:branch` 是 fork PR 语法，GitCode 会 400）
    const prBody = { head: branch, base: eff.branch, title: `dsh-sync ${instanceId}`, body: `Auto sync from ${instanceId}` }
    const prRes = await createPullRequest(eff.token, parsed.owner, parsed.repo, prBody)
    if (!prRes.ok) {
      // 409 = branch already has an open PR (idempotent retry); try to find it
      if (prRes.status === 409) return { pushed: true, prConflict: true, message: '已有进行中的同步 PR' }
      throw new Error(`创建 PR 失败（HTTP ${prRes.status}）：${(prRes.json && prRes.json.message) || prRes.text.slice(0, 160)}`)
    }
    const prNumber = prRes.json && (prRes.json.number || prRes.json.id)
    state.lastPushedBranch = branch
    state.lastPrNumber = prNumber

    // 7. mergeable?
    let mergeable = false, conflict = false
    try {
      const det = await getPullRequest(eff.token, parsed.owner, parsed.repo, prNumber)
      mergeable = det.ok && det.json && det.json.mergeable === true
      conflict = det.ok && det.json && det.json.mergeable === false
    } catch {}

    if (mergeable) {
      const mr = await mergePullRequest(eff.token, parsed.owner, parsed.repo, prNumber, 'squash')
      if (!mr.ok) throw new Error(`合并 PR 失败（HTTP ${mr.status}）`)
      // 合并即删远端 sync 分支（best effort）：不删的话每次同步遗留一个分支，
      // 真机仓库实测两天积了 970+ 个 sync/* 分支
      await gitExec(binary, ['push', remote, '--delete', branch], repoDir, authEnv).catch(() => {})
      // advance shadow to the merged main
      await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv).catch(() => {})
      await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
      await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
      state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
      advancedToMain = true
      return { pushed: true, merged: true, prNumber, settingsPreserved }
    }
    // conflict → leave PR open; client shows the "AI 解决冲突" action button
    return { pushed: true, prConflict: true, prNumber, conflict: true, settingsPreserved }
  } finally {
    // 未推进到 main（409/冲突/抛错）→ 恢复基线，保证下一轮 diff 的基线可达
    if (!advancedToMain) await restoreBaseline()
  }
}

// ── Three-way pull: remote deltas → live, only for untouched files ──

async function runPull(binary, eff, { repoDir, state, logger, roots }) {
  const remote = eff.repoUrl, authEnv = gitAuthEnv(eff)
  const spec = syncSpec(eff, roots, state.instanceId)
  const lastSynced = state.lastSyncedCommit
  try { await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv) } catch (e) {
    if (!/Could not find|doesn't exist|empty/i.test(String(e && e.message))) throw e
    return { pulled: false, empty: true }
  }
  const hasFetch = await gitExec(binary, ['rev-parse', '--verify', 'FETCH_HEAD'], repoDir).then(() => true).catch(() => false)
  if (!hasFetch) return { pulled: false, empty: true }
  if (!lastSynced) {
    // never synced before: nothing to diff against; just record baseline
    await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
    state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
    return { pulled: false, firstBaseline: true }
  }
  // 基线守护（0.4.8）：基线被改写/回退后不能直接拿来 diff（同 reconcileRemote）
  const syncBase = await resolveSyncBase(binary, repoDir, lastSynced, logger)
  const noCommonBase = syncBase === null
  const diffBase = syncBase || EMPTY_TREE_HASH
  // files remote changed since the (corrected) baseline
  let changedRaw = ''
  try { changedRaw = await gitExec(binary, ['diff', '--name-only', diffBase, 'FETCH_HEAD'], repoDir) } catch {}
  const changed = changedRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  let applied = 0, skipped = 0
  state.pendingBoth = state.pendingBoth && typeof state.pendingBoth === 'object' ? state.pendingBoth : {}
  for (const p of changed) {
    const livePath = resolveLivePath(spec, p)
    if (!livePath) { skipped++; continue }
    let liveBuf = null
    try { liveBuf = await fsP.readFile(livePath) } catch {}
    // 机器专属保护：本地已有的插件清单文件绝不被远端覆盖（同 reconcileRemote）
    if ((p === 'plugins' || p.startsWith('plugins/')) && liveBuf !== null) { skipped++; continue }
    // 无共同基线：无法判断远端是否动过，本机已有文件保持不动（不覆盖、不挂账）
    if (noCommonBase && liveBuf !== null) { skipped++; continue }
    let remoteBuf = null
    try { remoteBuf = await gitShowBuf(binary, `FETCH_HEAD:${p}`, repoDir) } catch { remoteBuf = null }
    if (remoteBuf === null) { skipped++; delete state.pendingBoth[p]; continue }   // 远端删除不镜像
    if (liveBuf !== null && Buffer.compare(liveBuf, remoteBuf) === 0) { delete state.pendingBoth[p]; continue }
    const fileBase = state.pendingBoth[p] || diffBase
    let baseBuf = null
    try { baseBuf = await gitShowBuf(binary, `${fileBase}:${p}`, repoDir) } catch { baseBuf = Buffer.alloc(0) }
    const untouched = liveBuf === null ? (baseBuf.length === 0) : Buffer.compare(liveBuf, baseBuf) === 0
    if (!untouched) {
      // 本地动过 → 留给对齐/下个 push；基线按文件记账
      if (!state.pendingBoth[p]) state.pendingBoth[p] = fileBase
      skipped++
      continue
    }
    delete state.pendingBoth[p]
    try {
      await atomicWriteFile(livePath, remoteBuf)
      applied++
    } catch { skipped++ }
  }
  // 覆盖·远端为准的组：整组强制镜像（本地只读）——不在本轮变更集里的文件也要
  // 回归远端版本（本地乱改被冲掉、本地多出来的文件按远端为准删除）
  for (const group of spec.filter(g => g.strategy === 'remote')) {
    for (const src of group.sources) {
      const shadowDir = join(repoDir, src.to)
      const haveShadow = await fsP.access(shadowDir).then(() => true).catch(() => false)
      if (!haveShadow) continue
      if (src.file) {
        const buf = await shadowFileBuf(binary, repoDir, normGitPath(src.to), shadowDir)
        if (buf === null) continue
        try { await atomicWriteFile(src.from, buf); applied++ } catch {}
        continue
      }
      // --name-status 输出的是第一参数（旧侧）路径：live 在前，行内路径即 live 文件
      const diffEntries = await gitDiffNameStatus(src.from, shadowDir, repoDir, binary)
      for (const [status, rawPath] of diffEntries) {
        // 路径分隔符归一后再比前缀：Windows 下 git 用 / 拼目录与文件名，
        // 不归一化则 startsWith(src.from) 恒为 false，整组覆盖会静默空转。
        const livePath = normGitPath(rawPath)
        if (!livePath.startsWith(normGitPath(src.from))) continue
        const rel = relFrom(livePath, src.from)
        try {
          if (status === 'A') await fsP.rm(livePath, { recursive: true, force: true })   // 仅本地有 → 按远端为准删除
          else {
            const buf = await shadowFileBuf(binary, repoDir, `${normGitPath(src.to)}/${rel}`, join(shadowDir, rel))
            if (buf === null) continue
            await atomicWriteFile(livePath, buf)
          }
          applied++
        } catch {}
      }
    }
  }
  // advance shadow baseline to the freshly-pulled main
  await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
  await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
  state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
  return { pulled: true, applied, skipped, changed: changed.length }
}

/** git diff --no-index --name-status -z：差异时退出码非 0 但 stdout 仍列出差异
 *  （M/D=旧侧有新侧变、A=仅新侧有），需专用 helper 接住非零退出。
 *  返回 [status, path] 数组；用 -z 因为 Windows 上路径里的反斜杠会让默认输出给
 *  路径加引号并转义（core.quotePath=false 也管不住），解析出的路径无法与真实路径比较。 */
function gitDiffNameStatus(a, b, cwd, binary) {
  return new Promise((resolve) => {
    execFile(binary, ['diff', '--no-index', '--name-status', '--no-renames', '-z', a, b], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      const parts = String(stdout || '').split('\0')
      const entries = []
      for (let i = 0; i + 1 < parts.length; i += 2) {   // 已用 --no-renames：固定 (status, path) 成对
        const status = parts[i].slice(0, 1)
        if (status) entries.push([status, parts[i + 1]])
      }
      resolve(entries)
    })
  })
}

/** 取 shadow 工作树对应提交里的原始字节（工作树文件可能被 autocrlf/eol 改写行尾）；
 *  取不到（未跟踪内容等）再退回工作树文件，保持旧行为。
 *  主路径已用 gitShowBuf(rev:path) + atomicWriteFile 写仓库字节，镜像路径必须一致，
 *  否则 Windows（autocrlf=true）会把远端 LF 写成 CRLF，与其它机器/仓库内容不一致。 */
async function shadowFileBuf(binary, repoDir, repoRel, worktreeFile) {
  try { return await gitShowBuf(binary, `HEAD:${repoRel}`, repoDir) } catch {}
  try { return await fsP.readFile(worktreeFile) } catch {}
  return null
}

/** git 输出路径归一化：去掉可能的引号、分隔符统一为 /（Windows 下 git 用 / 拼接目录与文件名）。 */
function normGitPath(p) {
  return String(p || '').replace(/^"|"$/g, '').split(sep).join('/')
}

/** 求路径相对基准目录的相对部分（路径分隔符归一为 /）。 */
function relFrom(p, base) {
  const pn = p.split(sep).join('/').replace(/\/$/, '')
  const bn = base.split(sep).join('/').replace(/\/$/, '') + '/'
  return pn.startsWith(bn) ? pn.slice(bn.length) : pn
}

// ── Pre-push reconcile: pull remote changes back into live BEFORE the
//    snapshot push. The push mirror is a full-directory overlay (rm + copy),
//    so without this step a file another machine added — and this replica
//    hasn't pulled yet — gets deleted in the push branch and flaps out of
//    the remote. Remote-only and locally-untouched files are written back
//    here (purely deterministic, never overwrites local work); files both
//    sides changed are reported as `bothModified` for the AI align step /
//    conflict PR. Remote deletions are never mirrored into live. ──

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// ── 同步基线守护（0.4.8）─────────────────────────────────────────────────
// reconcile/pull 都用 `git diff lastSyncedCommit FETCH_HEAD` 求「远端改过哪些文件」。
// 这个 diff 只在 lastSyncedCommit 是 FETCH_HEAD 的祖先时才成立。远端 main 被
// force-push / 平台合并丢弃旧 tip 后，旧基线还在本地对象库里却不是新 main 的祖先，
// diff 就退化成「凡内容不同都算远端改过」——本机正在持续写入的文件（会话日志）
// 被误判 bothModified，推送时被 preserve 回退成远端版本，于是永远推不上去、挂账也
// 永远销不掉（真机实证 2026-10-06：sessions 停在 20:46，plugins 却每次都推成功）。
// 处理：基线不可达 → 退化为真正的共同祖先 merge-base；连共同祖先都没有（历史无关）
// → 返回 null，调用方按「无共同基线」处理（只回填本机没有的文件，不覆盖、不挂账）。
async function resolveSyncBase(binary, repoDir, lastSynced, logger) {
  if (!lastSynced) return null
  const isAncestor = await gitExec(binary, ['merge-base', '--is-ancestor', lastSynced, 'FETCH_HEAD'], repoDir)
    .then(() => true).catch(() => false)
  if (isAncestor) return lastSynced
  const mb = (await gitExec(binary, ['merge-base', lastSynced, 'FETCH_HEAD'], repoDir).catch(() => '')).trim()
  if (logger) {
    logger.warn('dsh-sync: 同步基线 ' + String(lastSynced).slice(0, 8) +
      ' 已不是远端 tip 的祖先（远端 main 被改写或回退？），改用共同祖先 ' + (mb ? mb.slice(0, 8) : '（无）'))
  }
  return mb || null
}

// 逐文件挂账基线复核：pendingBoth[p] 记的是「发现双方改动时」的共同基线。基线被改写后
// 这个记账值同样失效，「远端改过该文件」的前提随之作废 → 用真共同祖先重新判定：修正后
// 的基线里没动过该文件就销账（本机版本可以正常推送），真动过就把记账基线修正到共同
// 祖先，冲突判定继续保留（保守：只在基线已不可达时才动记账值）。
async function revalidatePendingBoth(binary, repoDir, state, logger) {
  const cleared = []
  const pending = state.pendingBoth && typeof state.pendingBoth === 'object' ? state.pendingBoth : {}
  for (const p of Object.keys(pending)) {
    const recBase = pending[p]
    if (!recBase) continue
    const alive = await gitExec(binary, ['merge-base', '--is-ancestor', recBase, 'FETCH_HEAD'], repoDir)
      .then(() => true).catch(() => false)
    if (alive) continue
    const mb = (await gitExec(binary, ['merge-base', recBase, 'FETCH_HEAD'], repoDir).catch(() => '')).trim()
    if (!mb) { delete pending[p]; cleared.push(p); continue }
    const touched = await gitExec(binary, ['diff', '--name-only', mb, 'FETCH_HEAD', '--', p], repoDir)
      .then((s) => s.trim().length > 0).catch(() => true)
    if (!touched) { delete pending[p]; cleared.push(p); continue }
    pending[p] = mb
  }
  if (cleared.length && logger) {
    logger.warn('dsh-sync: 挂账基线失效，已自动销账 ' + cleared.length + ' 个文件（远端其实没改过它们）' +
      (cleared.length <= 3 ? '：' + cleared.join('、') : ''))
  }
  return { cleared }
}

async function reconcileRemote(binary, eff, { repoDir, state, logger, roots }) {
  const fs = require('node:fs')
  try { await fs.promises.access(join(repoDir, '.git')) } catch { return { reconciled: false, noShadow: true } }
  const remote = eff.repoUrl, authEnv = gitAuthEnv(eff)
  const spec = syncSpec(eff, roots, state.instanceId)
  try { await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv) } catch (e) {
    if (!/could ?n[o']?t find|doesn't exist|no such|unborn|empty/i.test(String(e && e.message))) throw e
    return { reconciled: false, empty: true }
  }
  const hasFetch = await gitExec(binary, ['rev-parse', '--verify', 'FETCH_HEAD'], repoDir).then(() => true).catch(() => false)
  if (!hasFetch) return { reconciled: false, empty: true }
  // 首次同步基线 = 空树：云端全部内容按「远端新增、本机未动」回填 live（并集下载），
  // 否则新机器只在远端文件发生后续变更时才拿得到它们（真机联调发现的缺口）
  const prevSynced = state.lastSyncedCommit || null
  // 基线守护（0.4.8）：远端 main 被改写/回退后旧基线不再是 FETCH_HEAD 的祖先，
  // 直接拿它 diff 会把所有内容不同的文件都当成「远端改过」（见 resolveSyncBase）。
  const syncBase = await resolveSyncBase(binary, repoDir, prevSynced, logger)
  const noCommonBase = Boolean(prevSynced) && syncBase === null
  const diffBase = syncBase || EMPTY_TREE_HASH
  let changedRaw = ''
  try { changedRaw = await gitExec(binary, ['diff', '--name-only', diffBase, 'FETCH_HEAD'], repoDir) } catch {}
  const changed = changedRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  // 逐文件基线：bothModified 文件在解决前基线不能跟着 lastSyncedCommit 前进
  // （真机实证：基线被推进到远端 tip 后，AI 对齐看到「远端==基线 → 保留本机」，
  // 对端改动在下一次推送时被覆盖）。pendingBoth 记住每个未解决文件的真基线。
  state.pendingBoth = state.pendingBoth && typeof state.pendingBoth === 'object' ? state.pendingBoth : {}
  // 挂账复核（0.4.8）：记账基线同样失效的挂账在这里销账/修正——否则它每轮都被
  // preserve 回退成远端版本，本机版本永远推不上去（真机会话日志实证）
  const pendingReview = await revalidatePendingBoth(binary, repoDir, state, logger)
  const applied = []        // safely written back to live
  const bothModified = []   // both sides changed → AI align / conflict PR
  const remoteDeleted = []  // gone on remote; live keeps its copy
  const localKept = []      // machine-owned plugin manifests the remote may not touch
  const skipNoBase = []     // no common baseline: live files left untouched
  for (const p of changed) {
    const livePath = resolveLivePath(spec, p)
    if (!livePath) continue
    const strategy = strategyForPath(spec, p)
    // backup（各机独立备份）与 local（覆盖·本地为准）：本地是权威，远端动向一概不理
    if (strategy === 'backup' || strategy === 'local') {
      delete state.pendingBoth[p]
      continue
    }
    let remoteBuf = null
    try { remoteBuf = await gitShowBuf(binary, `FETCH_HEAD:${p}`, repoDir) } catch { remoteBuf = null }
    if (remoteBuf === null) {
      // 远端为准：远端删了本地也删；其余策略远端删除从不镜像
      if (strategy === 'remote') { try { await fsP.unlink(livePath); applied.push(p) } catch {} }
      else remoteDeleted.push(p)
      delete state.pendingBoth[p]
      continue
    }
    let liveBuf = null
    try { liveBuf = await fsP.readFile(livePath) } catch {}
    // 插件清单是机器专属启动配置：本地已有的文件绝不被远端覆盖（真机实证：对端
    // package.json 覆盖本机 web profile 的 bundle 列表 → 宿主重启解析不到 bundle，
    // launchd crash loop）。本地没有的清单文件照常回填，新机器的清单以并集到来。
    if ((p === 'plugins' || p.startsWith('plugins/')) && liveBuf !== null) { localKept.push(p); continue }
    // 覆盖·远端为准：无条件镜像远端（含本地改过的文件），不进冲突流程
    if (strategy === 'remote') {
      delete state.pendingBoth[p]
      try { await atomicWriteFile(livePath, remoteBuf); applied.push(p) } catch {}
      continue
    }
    // 无共同基线：无法判断远端是否动过，本机已有的文件一律保持不动（不覆盖、不挂账）
    if (noCommonBase && liveBuf !== null) { skipNoBase.push(p); continue }
    // 未解决文件的基线固定在首次发现冲突时的 commit，其余文件跟随修正后的基线
    const fileBase = state.pendingBoth[p] || diffBase
    let baseBuf = null
    try { baseBuf = await gitShowBuf(binary, `${fileBase}:${p}`, repoDir) } catch { baseBuf = Buffer.alloc(0) }
    if (liveBuf !== null && Buffer.compare(liveBuf, remoteBuf) === 0) {
      // live 已与远端一致（对齐已收敛/手动同步过）→ 销账
      delete state.pendingBoth[p]
      continue
    }
    const untouched = liveBuf === null ? (baseBuf.length === 0) : Buffer.compare(liveBuf, baseBuf) === 0
    if (!untouched) {
      if (!state.pendingBoth[p]) state.pendingBoth[p] = fileBase
      bothModified.push({ shadowPath: p, livePath, baseCommit: state.pendingBoth[p] })
      continue
    }
    delete state.pendingBoth[p]
    try { await atomicWriteFile(livePath, remoteBuf); applied.push(p) } catch {}
  }
  // 长期挂着的销账清理：不在本轮变更集里且 live 已与远端一致
  for (const p of Object.keys(state.pendingBoth)) {
    if (changed.includes(p)) continue
    const livePath = resolveLivePath(spec, p)
    if (!livePath) { delete state.pendingBoth[p]; continue }
    let remoteBuf = null
    try { remoteBuf = await gitShowBuf(binary, `FETCH_HEAD:${p}`, repoDir) } catch { remoteBuf = null }
    let liveBuf = null
    try { liveBuf = await fsP.readFile(livePath) } catch {}
    if (remoteBuf === null || (liveBuf !== null && Buffer.compare(liveBuf, remoteBuf) === 0)) delete state.pendingBoth[p]
  }
  // advance shadow baseline to FETCH_HEAD — safe items now match live, so the
  // subsequent push overlay keeps every remote-only file instead of deleting it.
  // (记录用的 lastSyncedCommit 同样前进：未解决文件的真基线在 pendingBoth 里逐文件记账)
  await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
  await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
  state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
  return {
    reconciled: true, applied, bothModified, remoteDeleted, localKept, changed: changed.length,
    // 基线守护的可见结果：基线被改写（修正/无法定位共同祖先）、挂账被自动销账的文件
    baselineRewritten: Boolean(prevSynced) && syncBase !== prevSynced,
    noCommonBase, pendingCleared: pendingReview.cleared, skipNoBase,
  }
}

// ── Snapshots: local-first, cloud only when explicitly checked ──────────
//    快照优先落本地（~/.dsh/dsh-sync/snapshots/<名字>/，本地滚动窗口内真删除
//    真释放），打快照时勾选「上传到云端」才写进 git（backup/<实例ID>/snapshots/，
//    永久存档）。恢复时本地没有的从云端影子仓库取。

/** 快照镜像 spec：快照范围与同步开关解耦（快照=机器状态备份，同步=跨机收敛）：
 *  固定拍 设置+插件清单，skills 按 snapshotSkills 勾选，sessions 永远排除（体积
 *  大头）。快照固定用共享规范布局（settings/settings.yaml 等），与各组当前策略
 *  无关——恢复时按同样布局写回。 */
function snapshotMirrorSpec(eff, roots, instanceId, name) {
  const shared = {
    syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: true,
    skillsStrategy: 'union', sessionsStrategy: 'union', settingsStrategy: 'union', pluginsStrategy: 'union',
  }
  return syncSpec(shared, roots, instanceId)
    .filter(g => g.name !== 'sessions' && (g.name !== 'skills' || eff.snapshotSkills === true))
    .map(g => ({ ...g, sources: g.sources.map(s => ({ ...s, to: `snapshots/${name}/${s.to}` })) }))
}

function sanitizeSnapshotName(raw) {
  const cleaned = String(raw || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)
  return cleaned || ''
}

/** 本地快照滚动清理：按名字倒序保留 keep 份。手动命名且未上云的不自动删
 *  （用户显式产物）；其余（auto- / pre-restore- / 已上云的）超窗即删。 */
async function pruneLocalSnapshots(snapshotsDir, keep, cloudNames) {
  let entries = []
  try { entries = await fsP.readdir(snapshotsDir, { withFileTypes: true }) } catch { return [] }
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse()
  const removed = []
  for (let i = 0; i < dirs.length; i++) {
    if (i < keep) continue
    const manualUnclouded = !dirs[i].startsWith('auto-') && !dirs[i].startsWith('pre-restore-') && !(cloudNames || []).includes(dirs[i])
    if (manualUnclouded) continue
    try { await fsP.rm(join(snapshotsDir, dirs[i]), { recursive: true, force: true }); removed.push(dirs[i]) } catch {}
  }
  return removed
}

/** 勾选了云端：把本地快照目录写进影子仓库 backup/<实例ID>/snapshots/<名字>/
 *  并走一次 分支 → PR → 合并（非 GitCode 远端退化为推分支）。 */
async function promoteSnapshotToCloud(binary, eff, { repoDir, instanceId, state, logger }, snapName, srcDir) {
  const remote = eff.repoUrl, authEnv = gitAuthEnv(eff)
  try { await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv) } catch (e) {
    if (!/could ?n[o']?t find|doesn't exist|no such|unborn|empty/i.test(String(e && e.message))) throw e
  }
  const hasRemote = await gitExec(binary, ['rev-parse', '--verify', 'FETCH_HEAD'], repoDir).then(() => true).catch(() => false)
  if (hasRemote) await gitExec(binary, ['checkout', '--detach', 'FETCH_HEAD'], repoDir).catch(() => {})
  const dest = join(repoDir, 'backup', instanceId, 'snapshots', snapName)
  await fsP.rm(dest, { recursive: true, force: true }).catch(() => {})
  await copyTree(srcDir, dest, {})
  const branch = `sync/${instanceId}/snap-${Date.now()}`
  await gitExec(binary, ['checkout', '-b', branch], repoDir)
  await gitExec(binary, ['add', '-A'], repoDir)
  try {
    await gitExec(binary, ['-c', 'user.name=dsh-sync', '-c', 'user.email=dsh-sync@local', 'commit', '-m', `snapshot ${instanceId} ${snapName}`], repoDir)
  } catch {
    return { promoted: false, nothingToCommit: true }
  }
  await gitExec(binary, ['push', remote, `HEAD:${branch}`], repoDir, authEnv)
  const parsed = parseRepoUrl(eff.repoUrl)
  if (!parsed) {
    // 非 GitCode 远端：推分支后把影子基线推进到 main（与 runPush 的 prSkipped 路径一致）
    await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv).catch(() => {})
    await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
    state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
    return { promoted: true, prSkipped: true, branch }
  }
  const prRes = await createPullRequest(eff.token, parsed.owner, parsed.repo, { head: branch, base: eff.branch, title: `dsh-sync snapshot ${instanceId} ${snapName}`, body: 'snapshot → cloud archive' })
  if (!prRes.ok) throw new Error(`创建快照 PR 失败（HTTP ${prRes.status}）：${(prRes.json && prRes.json.message) || prRes.text.slice(0, 160)}`)
  const prNumber = prRes.json && (prRes.json.number || prRes.json.id)
  let merged = false
  try {
    const det = await getPullRequest(eff.token, parsed.owner, parsed.repo, prNumber)
    if (det.ok && det.json && det.json.mergeable === true) {
      const mr = await mergePullRequest(eff.token, parsed.owner, parsed.repo, prNumber, 'squash')
      merged = !!mr.ok
    }
  } catch {}
  if (merged) await gitExec(binary, ['push', remote, '--delete', branch], repoDir, authEnv).catch(() => {})
  await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv).catch(() => {})
  await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
  await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
  state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
  return { promoted: true, merged, prNumber, branch }
}

// ── Multi-protocol backup: webdav / local are pure backup targets ──────
//    git 保留完整的 分支→PR→合并 同步语义；webdav/local 只做单向备份——
//    每次同步把启用类别按 git backup 策略的同款布局（backup/<实例ID>/…）镜像
//    上去，本地永不被读回覆盖；快照上云写 backup/<实例ID>/snapshots/<名字>/，
//    与 promoteSnapshotToCloud 的 git 路径逐字一致。恢复时按 git → webdav →
//    local 依次回退下载。

/** git 协议是否处于可用配置（显式关掉或没填仓库/令牌都算关）。 */
function gitProtocolOn(eff) {
  return eff.gitEnabled !== false && !!eff.repoUrl && !!eff.token
}

/** 已启用的纯备份协议描述符（纯函数，测试可断言）。 */
function resolveBackupProtocols(eff) {
  const out = []
  if (eff.webdavEnabled && eff.webdavUrl) {
    out.push({ kind: 'webdav', url: eff.webdavUrl, username: eff.webdavUsername || '', password: eff.webdavPassword || '', basePath: eff.webdavDir || 'dsh-sync' })
  }
  if (eff.localEnabled && eff.localDir) {
    out.push({ kind: 'local', dir: expandTilde(eff.localDir) })
  }
  return out
}

/** 备份镜像 spec：同 syncSpec，但所有组强制 backup 策略——产出的就是
 *  backup/<实例ID>/… 布局（纯备份协议与 git 备份策略形式一致的落点）。 */
function backupLayoutSpec(eff, roots, instanceId) {
  return syncSpec({
    ...eff,
    skillsStrategy: 'backup',
    sessionsStrategy: 'backup',
    settingsStrategy: 'backup',
    pluginsStrategy: 'backup',
  }, roots, instanceId)
}

/** 把启用类别的 live 内容铸成 backup/<实例ID>/ 布局的 staging 目录，
 *  webdav / local 两个协议共用同一份 staging。返回 staging 内实例根
 *  （所有类别都关时是空目录——webdav 零请求成功，local 镜像出空备份）。 */
async function stageBackupTree(eff, roots, instanceId, stagingDir) {
  await fsP.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  await mirrorLiveToShadow(backupLayoutSpec(eff, roots, instanceId), stagingDir)
  const stagingRoot = join(stagingDir, 'backup', instanceId)
  await fsP.mkdir(stagingRoot, { recursive: true })
  return stagingRoot
}

/** 上传 staging 树到一个纯备份协议。
 *  webdav 走 sha1 清单增量（manifest 只在整轮成功后由调用方落盘，失败自动
 *  全量重试）；local 走 tmp-swap 原子镜像（含删除传播）。 */
async function uploadBackupToOne(proto, stagingRoot, { instanceId, syncDir, force = false } = {}) {
  if (proto.kind === 'local') {
    return localMirrorSwap(stagingRoot, join(proto.dir, 'backup', instanceId))
  }
  if (proto.kind === 'webdav') {
    const client = createWebdavClient(proto)
    const manifestFile = join(syncDir, 'backup-manifest-webdav.json')
    let manifest = {}
    try { manifest = JSON.parse(await fsP.readFile(manifestFile, 'utf8')) } catch {}
    const res = await client.syncTreeFromDir(stagingRoot, `backup/${instanceId}`, { manifest, force })
    await atomicWriteFile(manifestFile, JSON.stringify(res.newManifest, null, 2))
    return { ok: true, uploaded: res.uploaded.length, deleted: res.deleted.length, unchanged: res.unchanged }
  }
  throw new Error('unknown protocol: ' + proto.kind)
}

/** 铸 staging（backup/<实例ID>/ 布局）并依次上传到所有启用的纯备份协议。
 *  单协议失败不影响其他协议，错误记在对应条目里。 */
async function runBackupUpload(eff, { instanceId, syncDir, roots }, { force = false } = {}) {
  const protos = resolveBackupProtocols(eff)
  if (!protos.length) return null
  const stagingRoot = await stageBackupTree(eff, roots || defaultRoots(), instanceId, join(syncDir, 'backup-staging'))
  const out = {}
  for (const proto of protos) {
    try { out[proto.kind] = await uploadBackupToOne(proto, stagingRoot, { instanceId, syncDir, force }) }
    catch (e) { out[proto.kind] = { ok: false, error: String(e && e.message) } }
  }
  return out
}

/** 把本地快照目录上传到一个纯备份协议（快照上云，与 git 的
 *  backup/<实例ID>/snapshots/<名字>/ 逐字同布局）。 */
async function promoteSnapshotToProtocol(proto, srcDir, { instanceId, snapName }) {
  const rel = `backup/${instanceId}/snapshots/${snapName}`
  if (proto.kind === 'local') {
    await copyTree(srcDir, join(proto.dir, rel), {})
    return { ok: true }
  }
  if (proto.kind === 'webdav') {
    const uploaded = await createWebdavClient(proto).uploadDirTree(srcDir, rel)
    return { ok: true, uploaded }
  }
  throw new Error('unknown protocol: ' + proto.kind)
}

/** 从纯备份协议下载快照到 destDir；没有则抛错（调用方继续回退）。 */
async function fetchSnapshotFromProtocol(proto, { instanceId, snapName }, destDir) {
  const rel = `backup/${instanceId}/snapshots/${snapName}`
  if (proto.kind === 'local') {
    const src = join(proto.dir, rel)
    await fsP.access(src)
    await copyTree(src, destDir, {})
    return true
  }
  if (proto.kind === 'webdav') {
    await createWebdavClient(proto).downloadTreeInto(rel, destDir)
    return true
  }
  throw new Error('unknown protocol: ' + proto.kind)
}

// ── Remote backup browser: list instances + tree, selectively pull with
//    safety guards. Browse is read-only against the git object DB — main is
//    fetched into a dedicated ref (refs/dshsync/browse) so the browse cache
//    never shares the sync loop's branch/worktree state (a dest-refspec fetch
//    does still write FETCH_HEAD — always the same branch tip the loop itself
//    fetches, see fetchBrowseRef below). Pull applies
//    remote files to live with the same crash-learned guards as
//    reconcileRemote: another machine's plugin manifests and settings.yaml
//    are never wholesale-replaced (real crashes documented inline above). ──

const BROWSE_REF = 'refs/dshsync/browse'

/** Logical (shared-layout) spec: all four groups on, union strategy, so
 *  destinations are skills/dsh, settings/settings.yaml etc. — no backup/<id>/
 *  prefix. Maps remote backup paths back to live absolute paths regardless
 *  of this machine's current sync switches/strategies. */
function logicalSpec(eff, roots) {
  return syncSpec({
    ...eff,
    syncSkills: true, syncSessions: true, syncSettings: true, syncPlugins: true,
    skillsStrategy: 'union', sessionsStrategy: 'union', settingsStrategy: 'union', pluginsStrategy: 'union',
  }, roots, '__logical__')
}

/** Parse a remote shadow path: backup/<id>/<rest> → { instance, isMine,
 *  logical, shared:false }; shared paths (skills/…, settings/…) →
 *  { instance:null, logical, shared:true }. */
function parseRemotePath(shadowRel, myInstanceId) {
  const norm = String(shadowRel).split(sep).join('/')
  const m = norm.match(/^backup\/([^/]+)\/(.+)$/)
  if (m) return { instance: m[1], isMine: m[1] === myInstanceId, logical: m[2], shared: false }
  return { instance: null, isMine: null, logical: norm, shared: true }
}

/** Classify a logical path's group name (skills/sessions/settings/plugins). */
function categoryForLogical(spec, logicalPath) {
  const norm = String(logicalPath).split(sep).join('/')
  for (const group of spec) {
    for (const src of group.sources) {
      const to = src.to.split(sep).join('/')
      if (norm === to || norm.startsWith(to + '/')) return group.name
    }
  }
  return null
}

/** Safety decision for pulling one remote file into live.
 *  不阻止跨机拉取——有时候确实需要用其他主机的部分配置。改为警告但不拦：
 *  - plugins/** 跨机 + 本机已有 → warn（覆盖机器专属启动配置可能导致宿主
 *    重启崩溃/crash loop；真机实证，但用户可自行决定）
 *  - settings.yaml 跨机 → warn（含机器专属凭证与模型配置，整文件替换可能
 *    打挂配置；建议改用「AI 智能对齐」逐键合并，但用户可自行决定）
 *  - skills → 无警告；sessions → warn（另一台机器的对话历史）
 *  Own instance (own backup) → 无警告（恢复语义）
 *  只有完全无法识别类别的路径才 block。写入前始终拍 pre-remote-pull 安全快照可回滚。 */
function pullSafety(category, isMine, liveExists) {
  if (category === 'skills') return { action: 'apply' }
  if (category === 'sessions') return { action: 'apply', warn: '另一台机器的会话日志（对话历史）' }
  if (category === 'plugins') {
    if (isMine) return { action: 'apply' }
    if (liveExists) return { action: 'apply', warn: '插件清单是机器专属启动配置，覆盖可能导致宿主重启崩溃（crash loop）' }
    return { action: 'apply', warn: '本机无该插件清单，按新增拉取' }
  }
  if (category === 'settings') {
    if (isMine) return { action: 'apply' }
    return { action: 'apply', warn: 'settings.yaml 含机器专属凭证与模型配置，整文件替换可能打挂配置；建议改用「AI 智能对齐」逐键合并' }
  }
  return { action: 'block', reason: '未识别的路径类别，不处理' }
}

/** Parse `git ls-tree` output: `<mode> <type> <object>\t<name>` per line. */
function parseLsTree(raw) {
  return String(raw || '').split(/\r?\n/).filter(Boolean).map(line => {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\t(.+)$/)
    if (!m) return null
    return { mode: m[1], type: m[2], object: m[3], name: m[4] }
  }).filter(Boolean)
}

/** Fetch main into the dedicated browse ref. The refspec is forced (`+`):
 *  BROWSE_REF is a plugin-private namespace that is routinely rewound relative
 *  to remote main — every PR merge/rebase moves main off the previously cached
 *  commit — and git rejects a non-fast-forward update of it with
 *  `! [rejected] ... (non-fast-forward)`, which surfaced as an HTTP 400 on
 *  "浏览远端" until the cached ref was deleted by hand.
 *  Note: a dest-refspec fetch does write FETCH_HEAD (with the same branch tip
 *  the sync loop fetches, so a concurrent browse can't change its outcome);
 *  earlier comments here wrongly claimed FETCH_HEAD stayed untouched. */
async function fetchBrowseRef(binary, eff, repoDir) {
  const remote = eff.repoUrl, authEnv = gitAuthEnv(eff)
  try {
    await gitExec(binary, ['fetch', remote, `+${eff.branch}:${BROWSE_REF}`], repoDir, authEnv)
    return true
  } catch (e) {
    if (/Could not find|doesn't exist|empty|unborn/i.test(String(e && e.message))) return false
    throw e
  }
}

/** Browse root: fetch + list top-level entries + parse backup/ instances.
 *  Each `backup/<id>/` dir is one machine's backup namespace; the one
 *  matching state.instanceId is flagged isMine so the UI can badge it. */
async function browseRemote(binary, eff, { repoDir, state }) {
  const hasShadow = await fsP.access(join(repoDir, '.git')).then(() => true).catch(() => false)
  if (!hasShadow) return { repoReady: false }
  const fetchOk = await fetchBrowseRef(binary, eff, repoDir)
  if (!fetchOk) return { repoReady: true, fetchOk: false, empty: true }
  const rootRaw = await gitExec(binary, ['ls-tree', BROWSE_REF], repoDir).catch(() => '')
  const rootEntries = parseLsTree(rootRaw).map(e => ({ name: e.name, type: e.type }))
  let instances = []
  if (rootEntries.some(e => e.type === 'tree' && e.name === 'backup')) {
    const instRaw = await gitExec(binary, ['ls-tree', BROWSE_REF, 'backup/'], repoDir).catch(() => '')
    instances = parseLsTree(instRaw)
      .filter(e => e.type === 'tree')
      .map(e => {
        // ls-tree outputs full paths from root (backup/<id>); strip the
        // backup/ prefix to get the bare instance ID for isMine comparison.
        const id = e.name.startsWith('backup/') ? e.name.slice(7) : e.name
        return { id, isMine: id === state.instanceId }
      })
  }
  return {
    repoReady: true, fetchOk: true,
    lastCommit: await gitExec(binary, ['rev-parse', BROWSE_REF], repoDir).then(s => s.trim()).catch(() => undefined),
    instances, rootEntries,
  }
}

/** Browse a subtree at <path> (immediate children). Read-only; the trailing
 *  slash makes ls-tree list the dir's contents rather than the dir entry
 *  itself. */
async function browseRemoteTree(binary, eff, { repoDir }, path) {
  const hasShadow = await fsP.access(join(repoDir, '.git')).then(() => true).catch(() => false)
  if (!hasShadow) return { repoReady: false }
  let refOk = true
  try { await gitExec(binary, ['rev-parse', '--verify', BROWSE_REF], repoDir) } catch { refOk = false }
  if (!refOk) return { repoReady: true, fetchOk: false, empty: true }
  const norm = String(path || '').split(sep).join('/').replace(/\/+$/, '')
  const raw = norm === ''
    ? await gitExec(binary, ['ls-tree', BROWSE_REF], repoDir).catch(() => '')
    : await gitExec(binary, ['ls-tree', BROWSE_REF, norm + '/'], repoDir).catch(() => '')
  // ls-tree outputs full paths from root (e.g. backup/<id>/skills); strip the
  // queried prefix so the UI gets relative names for breadcrumb + selection.
  const prefix = norm === '' ? '' : norm + '/'
  const entries = parseLsTree(raw).map(e => ({
    name: e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name,
    type: e.type,
  }))
  return { path: norm, entries }
}

/** Expand selected paths (mix of files and dirs) to individual blob paths.
 *  `git ls-tree -r --name-only` with a pathspec lists every blob under that
 *  path — a file yields itself, a dir yields all files recursively. */
async function expandToBlobs(binary, repoDir, paths) {
  const out = []
  for (const p of (paths || [])) {
    const norm = String(p).split(sep).join('/').replace(/\/+$/, '')
    if (!norm) continue
    const raw = await gitExec(binary, ['ls-tree', '-r', '--name-only', BROWSE_REF, norm], repoDir).catch(() => '')
    out.push(...raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean))
  }
  return [...new Set(out)]
}

/** Build the pull plan: for each blob, decide apply/block with reason.
 *  No writes — safe for dry-run preview. The plan carries display paths
 *  (~/…) not absolute paths, so nothing sensitive leaks to the client. */
async function planRemotePull(binary, eff, { repoDir, state, roots }, paths) {
  const blobs = await expandToBlobs(binary, repoDir, paths)
  const spec = logicalSpec(eff, roots)
  const plan = []
  for (const p of blobs) {
    const { isMine, logical } = parseRemotePath(p, state.instanceId)
    const livePath = resolveLivePath(spec, logical)
    const category = categoryForLogical(spec, logical)
    let liveExists = false
    if (livePath) { try { await fsP.access(livePath); liveExists = true } catch {} }
    const decision = pullSafety(category, isMine, liveExists)
    plan.push({
      remotePath: p, logicalPath: logical,
      livePath: livePath ? displayPath(livePath) : null,
      category, isMine: isMine === true, liveExists,
      action: decision.action, reason: decision.reason, warn: decision.warn,
    })
  }
  return {
    plan,
    applyCount: plan.filter(p => p.action === 'apply').length,
    blockCount: plan.filter(p => p.action === 'block').length,
    warnCount: plan.filter(p => p.warn).length,
  }
}

/** Write the applicable plan entries to live. Caller holds the lock and has
 *  already taken a pre-pull safety snapshot. Blocked entries are skipped
 *  (the plan already carries their reason). Returns applied/blocked/failed. */
async function applyRemotePullPlan(binary, eff, { repoDir, state, roots }, plan) {
  const spec = logicalSpec(eff, roots)
  const applicable = plan.filter(p => p.action === 'apply')
  const applied = [], failed = []
  for (const p of applicable) {
    try {
      const remoteBuf = await gitShowBuf(binary, `${BROWSE_REF}:${p.remotePath}`, repoDir)
      const livePath = resolveLivePath(spec, p.logicalPath)
      if (!livePath) { failed.push({ path: p.remotePath, error: '无法映射到 live 路径' }); continue }
      await atomicWriteFile(livePath, remoteBuf)
      applied.push(p.remotePath)
    } catch (e) { failed.push({ path: p.remotePath, error: String(e && e.message) }) }
  }
  return {
    applied: applied.length,
    blocked: plan.filter(p => p.action === 'block').length,
    appliedPaths: applied, failed,
  }
}

// ── Conflict-resolution action button: in-process agent (same channel as
//    skills-management share-run). Credential steps (fetch/checkout/merge
//    prepare, push, PR query/merge) stay in the host — the agent only does
//    the semantic conflict resolution on the prepared working tree, so no
//    token ever enters the prompt (issue #9). ──

// Windows(Git for Windows)专属注意事项：MSYS2 runtime 会把原生 .exe 的 argv 做
// POSIX→Windows 路径转换，`.dsh` 这类**目录名里带点**的路径会被当成路径段拆开
// （`C:\Users\x\.dsh\...` → `C:\Users\x\dsh\...`），git 于是在不存在的目录里执行而
// 报 fetch failed。官方 wontfix，见 https://github.com/git-for-windows/git/issues/685。
// 这里让 agent 在 Windows 上给**每条** git 命令临时关掉转换（不写全局环境变量）。
// 注意：必须定义在 CONFLICT_PROMPT_ZH 之前——这些数组在模块加载期求值，const 在后面
// 会触发 TDZ ReferenceError（node --check 只查语法，查不出这个）。
const WINDOWS_PATHCONV_NOTE = [
  '',
  '## ⚠️ Windows 专属保险（Git for Windows，必读）',
  '本机若为 Windows，**先做这一步再动手**，否则你会在一个"看起来对、其实不存在"的目录里操作：',
  '',
  '**第 1 步：确认平台。** 执行 `uname -s` 或 `echo $OS`；出现 MINGW/MSYS/CYGWIN 即为 Windows 上的 Git Bash。',
  '',
  '**第 2 步：排查路径被破坏。** Git Bash 的 POSIX→Windows 路径转换会把**目录名里的点**当成路径段拆开——',
  '`C:\\Users\\x\\.dsh\\dsh-sync\\repo` 会变成 `C:\\Users\\x\\dsh\\dsh-sync\\repo`（点消失、多出一级），',
  'git 于是在不存在的目录里执行并报 `fetch failed`。自检（把下面路径换成实际影子仓库）：',
  '',
  '```sh',
  'printf \'%s\\n\' "<影子仓库路径>"          # 原样打印，看点是否还在',
  'MSYS_NO_PATHCONV=1 printf \'%s\\n\' "<影子仓库路径>"   # 加开关后再打印，二者应一致',
  '```',
  '',
  '两者**不一致**（或路径里 `.dsh` 变成了 `dsh`）即已中招，必须走第 3 步。',
  '',
  '**第 3 步：每条 git 命令前置开关**（只对当前这条命令生效）：',
  '',
  '```sh',
  "MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' git -C <影子仓库> show FETCH_HEAD:<路径>",
  "MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' git -C <影子仓库> status",
  '```',
  '',
  '**第 4 步：动手前验证目录真的可达**。用第 3 步的形式执行 `git -C <影子仓库> rev-parse --show-toplevel`，',
  '输出必须是那个真实存在的影子仓库绝对路径。**若报 `not a git repository` / `No such file or directory`，',
  '立即停止并如实汇报**，不要在错误目录里继续读写、更不要据此判定"无冲突"或"无需修改"。',
  '',
  '硬性纪律：',
  '- **严禁** `export MSYS_NO_PATHCONV=1` 或写进 `.bashrc` 等全局位置——全局设置会破坏其它程序，',
  '  且被官方明确警告（Git for Windows build-extra#376）。只允许"每条命令前置"这种局部形式。',
  '- 变量名必须写全 `MSYS2_ARG_CONV_EXCL`（结尾是 L），拼错会静默失效。',
  '- 若加了开关仍失败，改用 `git.exe` 显式调用（`node`/`git` 若被 alias 成 winpty 包装会忽略该开关）。',
  '- 非 Windows 平台：本节全部跳过，不要加任何开关。',
].join('\n')

const CONFLICT_PROMPT_ZH = [
  '请解决 dsh-sync 同步仓库的冲突：本地工作树已处于合并冲突状态，逐文件分析取舍，解完后提交。',
  WINDOWS_PATHCONV_NOTE,
  '',
  '## 关键信息',
  '- 本地工作树（影子仓库）：{{shadowDir}}（已 checkout 到分支 {{branch}}，系统已执行 merge 并留下冲突）',
  '- 对应远端 PR：#{{prNumber}}（同步仓库 {{repoUrl}}）',
  '',
  '## 工具限制（硬性）',
  '- 只允许使用 bash 执行**本地** git 与文件命令（status/diff/show/add/commit 等）。',
  '- **严禁一切网络操作**：不要 git fetch / git pull / git push / git remote / curl / wget 等。推送与 PR 合并由系统在提交完成后自动完成。',
  '- **严禁**使用任何 return / deliver / 投递 / IM 文件类工具（如 dsh_im_return_file）。不要把任何文件“投递”或“返回”出去。',
  '- **不要读取任何配置文件或凭据**（如 ~/.dsh/settings.yaml）：本任务不需要任何令牌。',
  '',
  '## 执行步骤',
  '1. `cd {{shadowDir}} && git status`，用 `git diff --name-only --diff-filter=U` 列出冲突文件。',
  '2. 对每个冲突文件：读文件内容看 `<<<<<<<` 冲突标记，结合 `git log --oneline -5` 与 `git diff` 理解两边改动意图，决定取舍或融合（保留两边有效改动；README 等无语义文件取任一即可）。',
  '3. 全部解决后：`git add -A && git -c user.name=dsh-sync -c user.email=dsh-sync@local commit --no-edit`。',
  '4. 汇报：每个冲突文件怎么处理的、最终提交的哈希。**不要尝试推送**——系统会自动 push 并合并 PR。',
  '',
  '## 注意',
  '- 若 merge 已由系统自动完成（无冲突遗留），确认工作区干净即可，无需提交。',
  '- 若失败先看错误信息，不盲目重试。全程与最终汇报都使用中文。',
].join('\n')

function substituteParams(template, params) {
  let out = template
  for (const [key, value] of Object.entries(params)) {
    out = out.split(`{{${key}}}`).join(String(value))
  }
  return out
}

// ── Host-side conflict prepare/finalize (issue #9): all credential-touching
//    steps (authed fetch/push, PR query/merge) run here in the dsh web
//    process. The agent only resolves conflicts in the prepared tree, so the
//    token never enters the prompt/model context. ──

/** Fetch the sync branch + canonical branch, checkout the branch tip and
 *  merge the canonical branch into it — leaving a conflicted working tree
 *  for the agent. Returns { autoMerged, conflicts }: autoMerged=true means
 *  the merge went through cleanly (PR should be mergeable now — skip the
 *  agent and go straight to finalize). */
async function prepareConflictTree(binary, eff, { repoDir, branch }) {
  const remote = eff.repoUrl, authEnv = gitAuthEnv(eff)
  await gitExec(binary, ['fetch', remote, branch], repoDir, authEnv)
  const tip = (await gitExec(binary, ['rev-parse', 'FETCH_HEAD'], repoDir)).trim()
  await gitExec(binary, ['checkout', '-B', branch, tip], repoDir)
  await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv)
  let merged = false
  // merge 可能创建自动合并提交：身份显式内联，不依赖机器的全局 git 配置
  try { await gitExec(binary, ['-c', 'user.name=dsh-sync', '-c', 'user.email=dsh-sync@local', 'merge', '--no-edit', 'FETCH_HEAD'], repoDir); merged = true } catch { /* conflicts left in the tree */ }
  const raw = await gitExec(binary, ['diff', '--name-only', '--diff-filter=U'], repoDir).catch(() => '')
  const conflicts = String(raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  return { autoMerged: merged && conflicts.length === 0, conflicts }
}

/** Push the resolved branch, wait for the PR to report mergeable, squash-merge
 *  it, delete the remote sync branch and advance the shadow baseline onto the
 *  canonical branch. Non-GitCode remotes (local test bare repos): push only —
 *  the PR REST surface doesn't exist there. */
async function finalizeConflictBranch(binary, eff, { repoDir, branch, prNumber, state, logger, pollTries = 5, pollGapMs = 3000 }) {
  const log = (m) => { if (logger && logger.warn) logger.warn(m) }
  const remote = eff.repoUrl, authEnv = gitAuthEnv(eff)
  const unmerged = await gitExec(binary, ['diff', '--name-only', '--diff-filter=U'], repoDir).catch(() => '')
  if (String(unmerged || '').trim()) return { merged: false, reason: '仍有未解决的冲突文件：' + String(unmerged).trim().slice(0, 300) }
  // agent 工作期间（无锁阶段）若有并发自动同步重置了影子仓库，HEAD 已不在目标
  // 分支上——此时推送的是错误内容，明确失败让用户重新发起，而不是静默推错
  const cur = (await gitExec(binary, ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).catch(() => '')).trim()
  if (cur !== branch) return { merged: false, reason: `影子仓库当前在 ${cur || 'detached HEAD'}，不在分支 ${branch}（可能被并发同步重置）——请重新发起冲突处理` }
  await gitExec(binary, ['push', remote, `HEAD:${branch}`], repoDir, authEnv)
  const parsed = parseRepoUrl(eff.repoUrl)
  if (!parsed) return { merged: true, prSkipped: true }
  // mergeable 是异步计算的：推送前 PR 一直挂着 mergeable=false，GitCode 在 push 后
  // 才重算——所以每拍先等再查，false 不一票否决，连续到最后仍 false 才判失败
  let mergeable = false, lastState
  for (let i = 0; i < pollTries; i++) {
    await new Promise(r => setTimeout(r, pollGapMs))
    try {
      const det = await getPullRequest(eff.token, parsed.owner, parsed.repo, prNumber)
      if (det.ok && det.json) {
        lastState = det.json.mergeable
        if (det.json.mergeable === true) { mergeable = true; break }
      }
    } catch (e) { log(`dsh-sync: PR 轮询失败：${e && e.message}`) }
  }
  if (!mergeable) return { merged: false, reason: lastState === false ? 'PR 仍报 mergeable=false（冲突可能未全部解决）' : 'PR mergeable 状态超时未就绪' }
  const mr = await mergePullRequest(eff.token, parsed.owner, parsed.repo, prNumber, 'squash')
  if (!mr.ok) return { merged: false, reason: `合并 PR 失败（HTTP ${mr.status}）` }
  // 合并即删远端 sync 分支 + 影子基线推进到 main（与 runPush 合并路径一致）
  await gitExec(binary, ['push', remote, '--delete', branch], repoDir, authEnv).catch(() => {})
  await gitExec(binary, ['fetch', remote, eff.branch], repoDir, authEnv).catch(() => {})
  await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
  await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
  if (state) state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
  return { merged: true, prNumber }
}

// ── AI align action button: semantic merge of files both sides changed.
//    Deterministic reconcile (remote-only pull-back) already ran in the host
//    before this prompt is built; the agent only does the semantic judgement
//    on the reported both-modified files. Push + PR handling stay in the host
//    (post-align sync fires from job onFinish) — no token in the prompt. ──

const ALIGN_PROMPT_ZH = [
  '请执行 dsh-sync 的「AI 智能对齐」：把本机与远端都改过的文件做语义合并，写入本机对应文件。同步推送由系统在结束后自动完成。',
  WINDOWS_PATHCONV_NOTE,
  '',
  '## 路径信息',
  '- 影子仓库（git 工作树，只读用于取版本）：{{shadowDir}}',
  '- 本机 live 同步根：',
  '  - 技能（dsh）：{{skillsDsh}}',
  '  - 技能（agents，~/.agents/skills）：{{skillsAgents}}',
  '  - 技能（agents-home，~/agents/skills）：{{skillsHomeAgents}}',
  '  - 会话：{{sessions}}',
  '  - 设置文件：{{settingsFile}}',
  '  - 插件清单：{{profiles}}',
  '- 影子路径 → live 路径映射：`skills/dsh/**` → 技能（dsh）根；`skills/agents/**` → 技能（agents）根；`skills/agents-home/**` → 技能（agents-home）根；`skills/.skill-lock.json` → agents 根下 `.skill-lock.json`；`sessions/**` → 会话根；`settings/settings.yaml` → 设置文件；`plugins/**` → 插件清单根。',
  '- 备份目录：{{backupDir}}（改动前把 live 原文件按影子相对路径复制进去）',
  '',
  '## 待合并文件（两边都改过，共 {{fileCount}} 个）',
  '{{fileList}}',
  '每个文件的三个版本：本机版直接读 live 路径；远端版 `git -C {{shadowDir}} show FETCH_HEAD:<影子路径>`；共同基线 `git -C {{shadowDir}} show {{lastSynced}}:<影子路径>`（可能不存在）。',
  '**基线以文件清单里标注的「该文件基线」为准**（可能与全局基线不同——未解决冲突的文件基线固定在首次发现冲突时，不随后续同步前进）。若「远端版」与「该文件基线」相同，说明远端没有新改动：该文件直接保留本机版即可。',
  '',
  '## 规则（硬性）',
  '1. 只允许修改上面清单里的 live 文件；**不得删除**任何 live 文件或远端独有内容；不准碰同步根之外的文件。',
  '2. 动手前把每个 live 原文件备份到 {{backupDir}}（保持影子相对路径的子目录结构）。',
  '3. 文本文件（.md/.json/.yaml/.yml/明文 .jsonl）做三方语义合并，保留两边有效改动。技能/专家目录：两边各自新增的文件取并集（都保留），仅同名文件才合并内容。',
  '4. settings.yaml 逐键保留双方；本机路径/机器相关字段以本机为准；任何 token/apiKey/密钥字段保留两边但**严禁在输出中回显密钥值**。',
  '5. 二进制或压缩文件（.zst/.gz 及 session 日志二进制）不合并，保留本机版，在汇报里列出。',
  '6. 只允许使用 bash 执行**本地**命令（读文件、写文件、本地 git show）；**严禁一切网络操作**（不要 curl、不要 git fetch/pull/push、不要 printenv）；严禁使用 return/deliver/投递/IM 文件类工具；密钥值不得出现在任何输出里。',
  '7. 全程使用中文。最后汇报：备份了哪些文件、每个文件怎么合并的。同步与推送由系统自动触发，**不要自己调用任何同步接口**。',
  '',
  '若待合并文件清单为空，无需任何修改，直接汇报即可。',
].join('\n')

// ── Remote align: from the browse-remote dialog, when the user picks files
//    from another machine's backup and chooses "AI 对齐" instead of wholesale
//    pull. Two-way merge (remote version from refs/dshsync/browse vs local
//    live), no sync baseline — unlike the sync-flow align which is three-way. ──

const REMOTE_ALIGN_PROMPT_ZH = [
  '请执行 dsh-sync 的「远端对齐」：把用户从其他机器备份中选中的文件与本机当前版本做语义合并，保留两边有效配置，写入本机 live。',
  WINDOWS_PATHCONV_NOTE,
  '',
  '## 路径信息',
  '- 影子仓库（git 工作树，用于取远端版本）：{{shadowDir}}',
  '- 浏览 ref：refs/dshsync/browse（远端版本通过 `git -C {{shadowDir}} show refs/dshsync/browse:<影子路径>` 获取）',
  '- 本机 live 同步根：',
  '  - 设置文件：{{settingsFile}}',
  '  - 插件清单：{{profiles}}',
  '- 备份目录：{{backupDir}}（改动前把 live 原文件复制进去，保持影子相对路径的子目录结构）',
  '',
  '## 待合并文件（共 {{fileCount}} 个）',
  '{{fileList}}',
  '',
  '每个文件的两个版本：',
  '- 远端版（其他机器）：`git -C {{shadowDir}} show refs/dshsync/browse:<影子路径>`',
  '- 本机版：直接读上面清单里标注的 live 路径',
  '',
  '## 规则（硬性）',
  '1. 只允许修改上面清单里的 live 文件；不准碰同步根之外的文件。',
  '2. 动手前把每个 live 原文件备份到 {{backupDir}}。',
  '3. settings.yaml（YAML）：逐键合并，保留两边所有 provider/model/credential 配置；本机路径/机器相关字段以本机为准；token/apiKey/密钥字段保留两边值但**严禁在输出中回显密钥值**。',
  '4. 插件清单（package.json 等 JSON）：并集合并 dependencies，保留两边所有插件条目；版本冲突取较新者。',
  '5. 只允许使用 bash 执行**本地**命令（读文件、写文件、本地 git show）；**严禁一切网络操作**（不要 curl、不要 git fetch/pull/push、不要 printenv）；严禁使用 return/deliver/投递/IM 文件类工具；密钥值不得出现在任何输出里。',
  '6. 全程使用中文。最后汇报：备份了哪些文件、每个文件怎么合并的。同步推送由系统在结束后自动触发，**不要自己调用任何同步接口**。',
].join('\n')

// apiproxy client: dsh web 的 /api HTTP RPC（web 客户端同款），创建主对话级 session。
// 关键区别：apiproxy session/create 建的是 web 主对话级 agent（agentPreset=standard
// + dsh-base 全工具，含 bash）；而 agents.create 子 agent 是精简 scope（无 bash）。
// 故 conflict/align 走 apiproxy 不走 agents.create。base URL 可由 DSH_WEB_URL 覆盖。
//
// dsh 0.1.2-rc.1 两处 wire breaking（真机联调实证，2026-09-08）：
// ① BrowserAuth 上线：/api 无凭证一律 401——须先 GET authenticatedUrl（303 铸
//    dsh-auth-* cookie），后续请求带 Cookie 头；token 只认 GET /，?token= 直上 /api 无效。
// ② RPC 端点从点号（session.create）改成斜杠两段式（session/create，与 typert
//    namespace/method 对应），payload 必须包成 {args:{request:…}}；0.1.1-rc.2 仍是
//    点号 + 平铺 payload，404 时回退重试。cookie 由宿主 connection 服务铸造。
// apiproxy 基地址 = 宿主实际监听的回环地址。桌面版插件进程**没有** DSH_WEB_URL 环境
// 变量（那是 `dsh web` CLI 注册给会话的），而这里原先写死 3080：桌面宿主用的是随机
// 端口（真机实测 43120），于是桌面版下 AI 智能对齐 / AI 解决冲突 / 远端 AI 对齐一律
// `fetch failed`，面板只显示裸 fetch failed，无从判断（真机实证 2026-10-06）。
// 优先级：宿主 webServer.port（apply 时注入）> DSH_WEB_URL（dsh web CLI）> 3080 兜底。
const APIPROXY_FALLBACK_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
let apiproxyBase = APIPROXY_FALLBACK_BASE
function setApiproxyPort(port) {
  const n = Number(port)
  if (Number.isFinite(n) && n > 0) apiproxyBase = `http://127.0.0.1:${n}`
  return apiproxyBase
}
// 网络层失败要带上试过的基地址：否则只有 undici 的裸 `fetch failed`，看不出是端口
// 不对、认证失败还是路由缺失（桌面版 3080 就是被这条坑掉的）
function apiproxyUnreachable(e) {
  return new Error(`apiproxy 连接失败（基地址 ${apiproxyBase}）：${(e && e.message) || e}` +
    '。桌面版应取宿主实际端口；dsh web 默认 3080，可用 DSH_WEB_URL 覆盖')
}
let connectionSvcRef = null
let authedUrlCache = null
let cookieCache = null

async function mintCookie() {
  if (!authedUrlCache && connectionSvcRef && typeof connectionSvcRef.authenticatedUrl === 'function') {
    try { authedUrlCache = connectionSvcRef.authenticatedUrl(apiproxyBase) } catch { authedUrlCache = null }
  }
  if (!authedUrlCache) return null
  let setCookies = []
  try {
    const r = await fetch(authedUrlCache, { redirect: 'manual' })
    setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
  } catch { return null }
  for (const sc of setCookies) {
    const pair = String(sc).split(';')[0]
    if (pair && pair.includes('=')) { cookieCache = pair; return cookieCache }
  }
  return null
}

async function apiproxyCall(methodSlash, request, cookie) {
  const rpcId = 'dshsync-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  let r
  try {
    r = await fetch(`${apiproxyBase}/api/${methodSlash}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId, method: methodSlash, payload: { args: { request } } }),
    })
  } catch (e) { throw apiproxyUnreachable(e) }
  if (r.status === 401) return { unauthorized: true }
  if (r.status === 404) return { notFound: true }
  const j = await r.json().catch(() => ({}))
  return { res: j.result, raw: JSON.stringify(j).slice(0, 200) }
}

// 0.1.1-rc.2 回退：点号端点 + 平铺 payload、无认证
async function apiproxyLegacy(dotted, request) {
  const rpcId = 'dshsync-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  let r
  try {
    r = await fetch(`${apiproxyBase}/api/${dotted}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: dotted, payload: request }),
    })
  } catch (e) { throw apiproxyUnreachable(e) }
  const j = await r.json().catch(() => ({}))
  return j.result
}

async function apiproxy(methodSlash, request) {
  let out = await apiproxyCall(methodSlash, request, cookieCache)
  if (out.unauthorized) out = await apiproxyCall(methodSlash, request, await mintCookie())
  if (out.unauthorized) throw new Error(`apiproxy ${methodSlash}: dsh web 认证失败（无法铸造 BrowserAuth cookie；需要 dsh ≥0.1.2 的 connection.authenticatedUrl）`)
  if (out.notFound) {
    const res = await apiproxyLegacy(methodSlash.replace('/', '.'), request)
    if (!res || !res.ok) throw new Error(`apiproxy ${methodSlash} 失败: ` + JSON.stringify(res || out.raw).slice(0, 200))
    return res.value
  }
  const res = out.res
  if (!res || !res.ok) throw new Error(`apiproxy ${methodSlash} 失败: ` + JSON.stringify((res && res.error) || out.raw || {}).slice(0, 200))
  return res.value
}

async function runAgentViaApiproxy({ prompt, dir, job, sessions, logger }) {
  // prompt 由 host 侧构建，不含任何凭据：git 推送、PR 查询/合并等需要 token 的
  // 步骤全部由 host 完成（issue #9）——apiproxy 主对话级 session 的 bash 是
  // host-plane executor，凭据无从注入，也不应注入
  try {
    // 1. 创建主对话级 session（有 bash）+ 发 prompt（0.1.2-rc.1：斜杠端点 + args 包裹）
    const created = await apiproxy('session/create', { cwd: dir })
    const sessionId = created && created.sessionId
    if (!sessionId) throw new Error('session/create 未返回 sessionId')
    job.sessionId = sessionId
    await apiproxy('session/prompt', {
      requestId: 'dshsync-' + randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    })
    // 2. events 泵：ctx.sessions.get(sessionId) 同进程读活会话 events，300ms 取新。
    //    优先 snapshotEvents()（事件 spill 后 .events 可能非数组，参考 dsh-session-title）
    let session
    try { session = sessions.get(sessionId) } catch (e) { throw new Error('ctx.sessions.get(' + sessionId + ') 失败: ' + (e && e.message)) }
    const seen = new Set()
    const liveLine = (text) => { job.output = (job.output + text).slice(-CONFLICT_RUN_OUTPUT_CAP) }
    let finished = false
    const pump = () => {
      let evs = []
      try {
        if (session && typeof session.snapshotEvents === 'function') evs = session.snapshotEvents() || []
        else if (session && Array.isArray(session.events)) evs = session.events
      } catch { evs = [] }
      if (!Array.isArray(evs)) evs = []
      for (const ev of evs) {
        const seq = ev.seq
        if (seq != null && seen.has(seq)) continue
        if (seq != null) seen.add(seq)
        const d = ev.data || ev
        const ty = ev.type
        if (ty === 'assistant/chunk' && d.chunk && d.chunk.type === 'text' && d.chunk.text) liveLine(d.chunk.text)
        else if (ty === 'tool/call') {
          const args = d.arguments || d.input || {}
          const cmd = (args && typeof args === 'object' ? (args.command || JSON.stringify(args)) : String(args))
          liveLine('\n[tool] ' + (d.name || '?') + ' ' + String(cmd).slice(0, 200) + '\n')
        }
        else if (ty === 'tool/result') {
          let rc = ''
          const msg = d.message || d
          const outer = (msg && Array.isArray(msg.content)) ? msg.content : (Array.isArray(d.content) ? d.content : [])
          for (const it of outer) {
            const inner = it && it.content
            if (Array.isArray(inner)) { for (const x of inner) { if (x && x.text) rc += x.text } }
            else if (typeof inner === 'string') rc += inner
          }
          if (rc) liveLine('-> ' + rc.slice(0, 240) + '\n')
        }
        else if (ty === 'turn/end') finished = true
      }
    }
    const timer = setInterval(pump, 300)
    if (typeof timer.unref === 'function') timer.unref()
    // 3. 等跑完（turn/end）或超时
    const deadline = Date.now() + CONFLICT_RUN_TIMEOUT_MS
    await new Promise((resolve) => {
      const wait = setInterval(() => { if (finished || Date.now() > deadline) { clearInterval(wait); resolve() } }, 500)
      if (typeof wait.unref === 'function') wait.unref()
    })
    clearInterval(timer); pump()
    job.status = finished ? 'done' : 'error'
    job.code = finished ? 0 : 1
    if (!finished) job.output += '\n[超时未完成]'
  } finally {
    if (typeof job.onFinish === 'function') { try { job.onFinish() } catch {} }
  }
  return job
}

function createAgentRunJob({ prompt, dir, jobs, logger, sessions, onFinish }) {
  const id = 'ag' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const job = { id, status: 'running', startedAt: new Date().toISOString(), dir, output: '', code: null, onFinish }
  jobs.set(id, job)
  // 走 apiproxy 创建主对话级 session（standard preset + dsh-base 全工具，含 bash），
  // 不是 agents.create 子 agent（精简无 bash）。prompt 不含凭据（issue #9），
  // events 经 ctx.sessions.get 流式读。
  if (!sessions || typeof sessions.get !== 'function') {
    job.status = 'error'
    job.output = 'sessions 服务不可用（动态 ctx.inject 失败）'
    if (typeof onFinish === 'function') { try { onFinish() } catch {} }
    return job
  }
  runAgentViaApiproxy({ prompt, dir, job, sessions, logger })
    .catch(e => { job.status = 'error'; job.output = (job.output + '\n' + String(e && e.message)).slice(-CONFLICT_RUN_OUTPUT_CAP) })
  return job
}

module.exports = {
  name: 'dsh-sync',
  inject: ['webServer', 'settings', 'connection'],
  Config: Config ?? undefined,
  __internals: { syncSpec, defaultRoots, parseRepoUrl, detectRepoProvider, gitUsernameForProvider, checkRepoAccess, providerRepoInfo, gitAuthEnv, askpassPath, writeAskpass, ASKPASS_SH, mirrorLiveToShadow, resolveLivePath, copyTree, gitExec, acquireLock, checkRepoPrivate, gitcodeRequest, ensureShadowRepo, runPush, runPull, reconcileRemote, gitCurrentCommit, atomicWriteFile, DEFAULT_SYNC_SETTINGS, CONFLICT_PROMPT_ZH, ALIGN_PROMPT_ZH, REMOTE_ALIGN_PROMPT_ZH, substituteParams, prepareConflictTree, finalizeConflictBranch, strategyForPath, STRATEGY_VALUES, snapshotMirrorSpec, sanitizeSnapshotName, pruneLocalSnapshots, promoteSnapshotToCloud, msysPathConvEnv, expandTilde,
    // remote backup browser（导出供测试）
    BROWSE_REF, logicalSpec, parseRemotePath, categoryForLogical, pullSafety, parseLsTree, fetchBrowseRef, browseRemote, browseRemoteTree, expandToBlobs, planRemotePull, applyRemotePullPlan,
    // apiproxy（导出供测试：mock fetch 驱动 wire 形态回归）
    apiproxy, apiproxyCall, apiproxyLegacy, mintCookie,
    // 多协议备份（导出供测试）
    gitProtocolOn, resolveBackupProtocols, backupLayoutSpec, stageBackupTree, uploadBackupToOne, runBackupUpload, promoteSnapshotToProtocol, fetchSnapshotFromProtocol,
    __setConnection(svc) { connectionSvcRef = svc }, __resetApiproxyCache() { authedUrlCache = null; cookieCache = null },
    // 同步基线守护（0.4.8，导出供离线测试）
    resolveSyncBase, revalidatePendingBoth, EMPTY_TREE_HASH,
    // apiproxy 基地址（0.4.8：桌面版取宿主实际端口，导出供测试）
    setApiproxyPort, apiproxyBaseNow: () => apiproxyBase, APIPROXY_FALLBACK_BASE,
    syncSettingsSchema, Config, parseLegacySettingsYaml, __seedLegacyYaml,
    // 设置持久化（导出供测试）：自铸 Config + 自持设置文件
    buildFallbackConfig, parseSettingsFile, parseClearedKeys, pickFileSettingsLayer, Schema,
    getSchemaInfo: () => ({ schemaKind, schemasterySource, lastSchemasteryError }) },

  apply(ctx, config = {}) {
    // 桌面宿主用随机端口（真机 43120），apiproxy 依赖的基地址必须取宿主实际监听端口；
    // 静态 inject 列表里已有 webServer，这里在注册路由/建 job 之前先对齐基地址。
    try { setApiproxyPort(ctx.webServer && ctx.webServer.port) } catch {}
    const dh = dshHome()
    const syncDir = join(dh, 'dsh-sync')
    const repoDir = join(syncDir, 'repo')
    const stateFile = join(syncDir, 'state.json')
    const lockFile = join(syncDir, '.lock')

    // ── 自持设置文件（settings.json）──────────────────────────────────────
    // 宿主 settings 通道（Config 未被识别 / update 被拒）失败时，面板保存的值仍要
    // 落盘：这是「保存后重启回默认」的最终兜底，也是唯一不依赖宿主的持久化路径。
    const settingsFile = join(syncDir, 'settings.json')
    let fileSettings = {}
    let clearedKeys = new Set() // 显式清除的键（墓碑），见 parseClearedKeys
    let fileSettingsMtime = 0
    let docUpdatedAt = 0
    let lastPersist = { file: settingsFile, fileOk: null, fileError: null, hostOk: null, hostError: null, at: null }
    try {
      const rawSettings = fsSync.readFileSync(settingsFile, 'utf8')
      fileSettings = parseSettingsFile(rawSettings)
      clearedKeys = new Set(parseClearedKeys(rawSettings))
      try { fileSettingsMtime = fsSync.statSync(settingsFile).mtimeMs } catch {}
    } catch (e) {
      if (e && e.code !== 'ENOENT') ctx.logger.warn('dsh-sync: 读取 ' + settingsFile + ' 失败: ' + (e && e.message))
    }
    async function persistSettingsFile() {
      try {
        await fsP.mkdir(syncDir, { recursive: true })
        const payload = { version: 1, sync: fileSettings }
        if (clearedKeys.size > 0) payload.cleared = [...clearedKeys]
        await fsP.writeFile(settingsFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
        try { fileSettingsMtime = fsSync.statSync(settingsFile).mtimeMs } catch {}
        lastPersist = { ...lastPersist, fileOk: true, fileError: null, at: new Date().toISOString() }
        return true
      } catch (e) {
        lastPersist = { ...lastPersist, fileOk: false, fileError: String(e && e.message || e), at: new Date().toISOString() }
        try { ctx.logger.warn('dsh-sync: 写入 ' + settingsFile + ' 失败: ' + (e && e.message)) } catch {}
        return false
      }
    }

    // askpass 助手先于任何远端 git 命令落盘（GIT_ASKPASS env 注入的前提）
    writeAskpass().catch(e => ctx.logger.warn(`dsh-sync: askpass 初始化失败: ${e && e.message}`))

    // ── 0.1.7 settings 接线 ──
    // 命名空间必须匹配 /^[a-z][a-z0-9-]*$/ —— 点号形式会被 settings 写入通道拒绝
    const SYNC_SETTINGS_NS = 'dsh-sync'
    const baseSettings = () => {
      const cfg = (config.sync && typeof config.sync === 'object') ? config.sync : {}
      const base = { ...DEFAULT_SYNC_SETTINGS }
      // 0.1.7 config 回写/投影可能给出 null 等异常值：类型不对就走默认，别让同步链路崩掉
      for (const key of Object.keys(base)) {
        const v = cfg[key]
        if (v === undefined || v === null) continue
        if (typeof base[key] === typeof v) base[key] = v
      }
      if (typeof config.repoUrl === 'string' && config.repoUrl !== '') base.repoUrl = config.repoUrl
      return base
    }
    const settingsOverrides = {} // 进程内兜底：写回缺席/失败时保本次运行一致
    function readDescriptor() {
      try {
        if (!ctx.settings || typeof ctx.settings.describe !== 'function') return null
        return ctx.settings.describe().find((x) => x.ns === SYNC_SETTINGS_NS) || null
      } catch { return null }
    }
    // 宿主设置通道的落盘文件（profile 的 cordis.patch.yml）mtime：宿主写回成功时
    // 它会被刷新。跑起来之后才出现「文件比自持 settings.json 新」⇒ 宿主通道可用且
    // 更新，此时以宿主文档为准；否则（写回一直失败，即本 bug）自持文件生效。
    function hostDocumentMtime() {
      try {
        const p = (ctx.settings && ctx.settings.documentPath) || null
        if (!p) return 0
        return fsSync.statSync(p).mtimeMs || 0
      } catch { return 0 }
    }
    let liveSettings = {} // settings 文档实时值（document-updated 事件驱动刷新）
    // apply 时 loader 可能尚未就绪（describe 投影里还没有本插件条目），间隔重试
    let liveSeen = false
    function refreshLive(attempt = 0) {
      const d = readDescriptor()
      if (d) {
        if (!liveSeen) try { ctx.logger.info(`dsh-sync: settings 文档投影就绪`) } catch {}
        liveSeen = true
        if (d.value && typeof d.value === 'object') liveSettings = d.value
        return
      }
      if (attempt < 15) setTimeout(() => { refreshLive(attempt + 1) }, 2000).unref?.()
    }
    refreshLive()
    // 优先级：默认值 < config.sync < 宿主文档 < 自持 settings.json < 本次运行内存覆写。
    // 自持文件排在宿主文档之上，是为了在「宿主 settings 写回失败」（本 bug）时保存的
    // 值仍能跨重启生效；一旦宿主通道被证实更新（见 hostDocumentMtime），文件层让位。
    const syncSettings = () => {
      const doc = (liveSettings && typeof liveSettings === 'object') ? liveSettings : {}
      const docSync = (doc.sync && typeof doc.sync === 'object') ? doc.sync : {}
      const hostWriteAt = Math.max(docUpdatedAt || 0, hostDocumentMtime())
      const merged = { ...baseSettings(), ...docSync, ...pickFileSettingsLayer(fileSettings, fileSettingsMtime, hostWriteAt), ...settingsOverrides }
      // 墓碑最后压：被清除的键一律回默认值（否则 baseSettings 里的旧 config 值会复辟）
      for (const key of clearedKeys) merged[key] = DEFAULT_SYNC_SETTINGS[key]
      return merged
    }

    // 一次性迁移：dsh 0.1.7 把全局 settings.yaml 改名 settings.yaml.imported，
    // dsh-sync 节（旧版平铺形态）因插件当时尚未导出 Config 而没能迁进 profile，
    // 私仓 repoUrl/token 与各开关就此丢失。仅在“本 profile 从未写回过”且当前值
    // 仍为全新默认时执行一次；之后值落在 profile patch 里，本函数自然短路。
    let migrationSettled = false
    async function migrateLegacySyncSettings(attempt = 0) {
      if (migrationSettled) return
      try {
        const descriptor = readDescriptor()
        if (descriptor && descriptor.user && typeof descriptor.user === 'object' && Object.keys(descriptor.user).length > 0) { migrationSettled = true; return }
        const cur = syncSettings()
        const pristine = Object.keys(DEFAULT_SYNC_SETTINGS).every((k) => cur[k] === undefined || cur[k] === DEFAULT_SYNC_SETTINGS[k])
        if (!pristine) { migrationSettled = true; return }
        const section = parseLegacySettingsYaml(readLegacyYaml())
        if (!section) { migrationSettled = true; return }
        const values = {}
        for (const k of Object.keys(DEFAULT_SYNC_SETTINGS)) {
          const v = section[k]
          if (v === undefined) continue
          if (typeof DEFAULT_SYNC_SETTINGS[k] === 'boolean' && typeof v === 'boolean') values[k] = v
          else if (typeof DEFAULT_SYNC_SETTINGS[k] === 'number' && typeof v === 'number' && Number.isFinite(v)) values[k] = v
          else if (typeof DEFAULT_SYNC_SETTINGS[k] === 'string') values[k] = String(v)
        }
        if (Object.keys(values).length === 0 || Object.keys(values).every((k) => values[k] === DEFAULT_SYNC_SETTINGS[k])) { migrationSettled = true; return }
        if (ctx.settings && typeof ctx.settings.update === 'function') {
          try {
            await ctx.settings.update(SYNC_SETTINGS_NS, { sync: values })
            // 迁移结果同样写进自持文件，重启后不依赖宿主通道
            Object.assign(fileSettings, values)
            await persistSettingsFile().catch(() => {})
            migrationSettled = true
            refreshLive()
            try { ctx.logger.warn(`dsh-sync: 已从 settings.yaml.imported 迁移同步设置到 profile`) } catch {}
            return
          } catch { /* loader 未就绪 → 走重试 */ }
        }
      } catch { /* 迁移失败不影响主流程 */ }
      if (attempt < 15) setTimeout(() => { migrateLegacySyncSettings(attempt + 1) }, 2000).unref?.()
    }
    migrateLegacySyncSettings()

    // settings 文档变更（dsh 自动生成的设置页、本插件面板写回）刷新实时值
    try {
      if (ctx.on && typeof ctx.on === 'function') {
        ctx.effect(() => {
          const off = ctx.on('settings/document-updated', (ns) => {
            if (ns !== SYNC_SETTINGS_NS) return
            // 宿主侧写过文档：此后宿主文档优先于自持文件（避免旧文件压掉宿主设置页的修改）
            docUpdatedAt = Date.now()
            const d = readDescriptor()
            if (d && d.value && typeof d.value === 'object') liveSettings = d.value
            // 宿主文档又给出某个墓碑键的值 ⇒ 说明用户在别的入口改回来了，墓碑作废
            const docSync = (liveSettings && liveSettings.sync) || {}
            let dropped = false
            for (const key of [...clearedKeys]) {
              if (docSync[key] !== undefined && docSync[key] !== null) { clearedKeys.delete(key); dropped = true }
            }
            if (dropped) persistSettingsFile().catch(() => {})
          })
          return () => { try { off() } catch {} }
        }, 'dsh-sync: settings watch')
      }
    } catch { /* 事件订阅不可用：写回后靠 settingsOverrides 维持本次运行 */ }

    // ── State (instanceId + lastSyncedCommit + lastResult) ──
    let state = { instanceId: undefined, lastSyncedCommit: undefined, lastSyncAt: undefined, lastResult: undefined, cloudSnapshots: [], lastAutoSnapshotDate: undefined }
    const stateLoaded = fsP.readFile(stateFile, 'utf8').then(raw => {
      try { Object.assign(state, JSON.parse(raw)) } catch {}
    }).catch(() => {})
    // first boot: mint a stable instance id (hostname + short uuid). Persisted,
    // never synced (it lives outside the shadow tree).
    stateLoaded.then(async () => {
      if (!state.instanceId) {
        state.instanceId = `${String(hostname() || 'host').split('.')[0].slice(0, 16)}-${randomUUID().slice(0, 8)}`
        try { await fsP.mkdir(syncDir, { recursive: true }); await fsP.writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 }) } catch {}
      }
    })
    const saveState = async () => {
      try { await fsP.mkdir(syncDir, { recursive: true }); await fsP.writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 }) } catch {}
    }

    // 本地快照：把快照范围的 live 内容镜像到 ~/.dsh/dsh-sync/snapshots/<名字>/
    const createLocalSnapshot = async (eff, name) => {
      const spec = snapshotMirrorSpec(eff, defaultRoots(), state.instanceId, name)
      await mirrorLiveToShadow(spec, syncDir)
      return join(syncDir, 'snapshots', name)
    }

    // ── Sync run: lock → push → pull → save ──
    let syncRun = null
    // 自动对齐去重：同一批 bothModified 文件 30 分钟内只自动跑一次，防止 agent
    // 解决失败时随 autoSync 无限重试；规模闸门：清单太大（首收敛 churn、误删回滚）
    // 不是人类尺度的"冲突"，AI 逐文件语义合并不现实，留给状态页展示/人工处理
    const ALIGN_COOLDOWN_MS = 30 * 60 * 1000
    const AUTO_ALIGN_MAX_FILES = 50
    const alignState = { active: false, lastSig: '', lastAt: 0 }
    const runSync = async ({ autoAlign = true, forceBackup = false } = {}) => {
      if (syncRun !== null) return syncRun
      syncRun = (async () => {
        await stateLoaded
        const eff = syncSettings()
        const gitOn = gitProtocolOn(eff)
        const backupProtos = resolveBackupProtocols(eff)
        if (!gitOn && backupProtos.length === 0) throw new Error('未启用任何同步/备份协议：请至少配置 Git 仓库、WebDAV 或本地文件夹之一（到 ⚙ 同步设置 对应页签填写）')
        if (gitOn && !(await gitAvailable(eff.gitBinary))) throw new Error('PATH 上找不到 git')
        const release = await acquireLock(lockFile)
        if (release === null) throw new Error('另一个同步进程正在运行（已跳过）')
        const started = Date.now()
        let result = { pushed: false, pulled: false }
        try {
          if (gitOn) {
            // 影子仓库先行（首次运行在这里 clone）：reconcile 需要它来 fetch/回填
            await ensureShadowRepo(eff.gitBinary, eff, repoDir).catch(e => ctx.logger.warn(`dsh-sync: shadow init: ${e && e.message}`))
            const ctx2 = { repoDir, instanceId: state.instanceId, state, logger: ctx.logger }
            // reconcile first: pull remote-only/untouched changes into live so
            // the full-snapshot push below never deletes another replica's adds
            result.reconcile = await reconcileRemote(eff.gitBinary, eff, ctx2).catch(e => { result.reconcileError = String(e && e.message); return null })
            const fresh = (result.reconcile && Array.isArray(result.reconcile.bothModified)) ? result.reconcile.bothModified : []
            state.pendingBoth = state.pendingBoth && typeof state.pendingBoth === 'object' ? state.pendingBoth : {}
            // 已挂账未解决的 bothModified 一并纳入（reconcile 只报本轮变更集里的文件，
            // 但未解决文件的基线还在 pendingBoth 里，push 时同样要 preserve）
            const pendings = Object.keys(state.pendingBoth)
              .filter(p => !fresh.some(f => f.shadowPath === p))
              .map(p => {
                const livePath = resolveLivePath(syncSpec(eff, defaultRoots(), state.instanceId), p)
                return livePath ? { shadowPath: p, livePath, baseCommit: state.pendingBoth[p] } : null
              })
              .filter(Boolean)
            const both = [...fresh, ...pendings]
            // 双方都改过的文件不随快照推送（preserve）：远端版本留在 main，本机版本留在
            // live，等 AI 智能对齐做语义合并——不再静默覆盖
            result.push = await runPush(eff.gitBinary, eff, { ...ctx2, preserve: both.map(f => f.shadowPath) }).catch(e => { result.pushError = String(e && e.message); return null })
            result.pull = await runPull(eff.gitBinary, eff, ctx2).catch(e => { result.pullError = String(e && e.message); return null })
            // conflictMode=ai：检测到双方改动 → 自动触发 AI 智能对齐（后台 job，
            // 会话内可追问；agent 只合并 live 文件，推送由 job onFinish 的 host 侧
            // 补充同步完成——prompt 不含任何凭据）
            result.alignSkipped = autoAlign && eff.conflictMode === 'ai' && both.length > AUTO_ALIGN_MAX_FILES
              ? { reason: `bothModified ${both.length} 个，超过自动对齐规模上限 ${AUTO_ALIGN_MAX_FILES}（多为双机首次收敛 churn，非人工冲突）；保留双方版本，可到设置页手动处理` }
              : undefined
            if (autoAlign && eff.conflictMode === 'ai' && both.length > 0 && both.length <= AUTO_ALIGN_MAX_FILES && !alignState.active) {
              const sig = both.map(f => f.shadowPath).sort().join('|')
              if (sig !== alignState.lastSig || Date.now() - alignState.lastAt > ALIGN_COOLDOWN_MS) {
                alignState.lastSig = sig
                alignState.lastAt = Date.now()
                const startedJob = await startAlignJob(eff, both)
                if (startedJob) result.align = { jobId: startedJob.id, bothModified: both.map(f => f.shadowPath) }
              }
            }
          }
          state.lastSyncAt = new Date().toISOString()
          // 每日自动快照（本地滚动，勾选云端才上云——自动快照只落本地）。
          // 与协议无关：git / webdav / local 任一启用都执行。
          if (eff.snapshotAuto !== false) {
            const today = new Date().toISOString().slice(0, 10)
            if (state.lastAutoSnapshotDate !== today) {
              try {
                await createLocalSnapshot(eff, `auto-${today}`)
                state.lastAutoSnapshotDate = today
                await saveState()
              } catch (e) { ctx.logger.warn(`dsh-sync: auto snapshot: ${e && e.message}`) }
            }
          }
          // 纯备份协议（webdav/local）：把启用类别按 git backup 同款布局镜像上去
          if (backupProtos.length > 0) {
            result.backup = await runBackupUpload(eff, { instanceId: state.instanceId, syncDir, roots: defaultRoots() }, { force: forceBackup })
              .catch(e => { ctx.logger.warn(`dsh-sync: backup upload: ${e && e.message}`); return { error: String(e && e.message) } })
          }
          try { await pruneLocalSnapshots(join(syncDir, 'snapshots'), eff.snapshotLocalKeep || 30, state.cloudSnapshots) } catch {}
          state.lastResult = { ...result, at: state.lastSyncAt, durationMs: Date.now() - started }
          await saveState()
        } finally { release() }
        return result
      })().finally(() => { syncRun = null })
      return syncRun
    }

    // ── Agent-run jobs (action buttons → apiproxy 主对话级 session) ──
    // conflictRunJobs: 冲突 PR 解决；alignRunJobs: AI 智能对齐（语义合并双方改动）
    // remoteAlignRunJobs: 远端浏览中的 AI 对齐（从其他机器备份合并到本机）
    const conflictRunJobs = new Map()
    const alignRunJobs = new Map()
    const remoteAlignRunJobs = new Map()
    // 动态注入 sessions 服务：agent run 走 apiproxy 创建主对话级 session 后，
    // 用 ctx.sessions.get(sessionId).events 流式读 agent 输出（像 agents.create 事件泵，
    // 但这个 agent 有 bash）
    let sessionsSvc = null
    try {
      if (ctx.inject && typeof ctx.inject === 'function') {
        ctx.inject(['sessions'], (svcs) => { sessionsSvc = svcs && svcs.sessions })
      }
    } catch {}
    // 动态注入 connection 服务：0.1.2-rc.1 起 /api 需要 BrowserAuth cookie，
    // 由 connection.authenticatedUrl 铸造（缺失时回退 0.1.1 无认证形态）
    try {
      if (ctx.inject && typeof ctx.inject === 'function') {
        ctx.inject(['connection'], (svcs) => { connectionSvcRef = svcs && svcs.connection })
      }
    } catch {}

    // AI 智能对齐 job（手动按钮 /align/run 与自动对齐共用）：先建备份目录，再创建
    // 主对话级 agent session 语义合并 bothModified 文件。凭据步骤留 host：先 fetch
    // 把 FETCH_HEAD 预置到远端 main，agent 才能用 git show FETCH_HEAD:<path> 读远端版
    const startAlignJob = async (eff, both) => {
      const baseCommit = state.lastSyncedCommit   // 双方分叉的共同基线（reconcile 前）
      const backupDir = join(syncDir, 'align-backups', new Date().toISOString().replace(/[:.]/g, '-'))
      await fsP.mkdir(backupDir, { recursive: true })
      await gitExec(eff.gitBinary, ['fetch', eff.repoUrl, eff.branch], repoDir, gitAuthEnv(eff)).catch(() => {})
      const fileList = both.length
        ? both.map((f, i) => `${i + 1}. ${f.shadowPath}（本机：${displayPath(f.livePath)}；该文件基线：${f.baseCommit || '同全局基线'}）`).join('\n')
        : '（无——确定性同步已处理全部差异）'
      const roots = defaultRoots()
      const prompt = substituteParams(ALIGN_PROMPT_ZH, {
        shadowDir: repoDir,
        skillsDsh: roots.dshSkills, skillsAgents: roots.agentsSkills,
        skillsHomeAgents: roots.homeAgentsSkills,
        sessions: roots.sessions, settingsFile: roots.settingsFile, profiles: roots.profiles,
        backupDir,
        fileCount: both.length, fileList,
        lastSynced: baseCommit || '（无共同基线，仓库首次同步）',
      })
      alignState.active = true
      const job = createAgentRunJob({
        // cwd 提到 home：沙箱 workspace 必须覆盖 live 同步根、备份目录与影子仓库，
        // 否则 agent 写备份/写 live 全被拦（真机实证：cwd=影子仓库时写 ~/.dsh/dsh-sync 被拒）
        prompt, dir: homedir(), jobs: alignRunJobs, logger: ctx.logger, sessions: sessionsSvc,
        onFinish: () => {
          alignState.active = false
          // 对齐成功 → 销账（本机版本已是语义合并结果，随下一次推送传播）+ 补一次
          // 确定性同步把它推上去（同步由 host 触发，agent 不再自己 curl）；失败则
          // 保留挂账，文件继续被 preserve 保护。延迟 + 锁重试：可能有自动同步在跑
          if (job.code === 0 && both.length > 0) {
            for (const f of both) delete state.pendingBoth[f.shadowPath]
            saveState()
            const post = (n) => runSync({ autoAlign: false }).catch(e => {
              if (/另一个同步进程/.test(String(e && e.message)) && n < 4) setTimeout(() => post(n + 1), 5000)
              else ctx.logger.warn(`dsh-sync: post-align sync: ${e && e.message}`)
            })
            setTimeout(() => post(0), 3000)
          }
        },
      })
      return job
    }

    // 远端对齐 job（浏览远端 → 预览 → AI 对齐）：把其他机器备份中的选中文件
    // 与本机版本语义合并（逐键/并集），而不是整文件覆盖。agent 读远端版用
    // git show refs/dshsync/browse:<path>，读本机版直接读 live，合并后写 live。
    const startRemoteAlignJob = async (eff, planItems) => {
      const backupDir = join(syncDir, 'remote-align-backups', new Date().toISOString().replace(/[:.]/g, '-'))
      await fsP.mkdir(backupDir, { recursive: true })
      const roots = defaultRoots()
      const spec = logicalSpec(eff, roots)
      // 只对齐有警告的项（跨机 settings/plugins），且本机已有 live 文件
      const targets = planItems.filter(p => p.warn && p.action === 'apply' && p.livePath)
        .map(p => {
          const livePath = resolveLivePath(spec, p.logicalPath)
          return { shadowPath: p.remotePath, logicalPath: p.logicalPath, livePath, warn: p.warn }
        })
        .filter(t => t.livePath)
      const fileList = targets.length
        ? targets.map((f, i) => `${i + 1}. ${f.shadowPath}（本机：${displayPath(f.livePath)}）`).join('\n')
        : '（无）'
      const prompt = substituteParams(REMOTE_ALIGN_PROMPT_ZH, {
        shadowDir: repoDir,
        settingsFile: roots.settingsFile, profiles: roots.profiles,
        backupDir,
        fileCount: targets.length, fileList,
      })
      const job = createAgentRunJob({
        prompt, dir: homedir(), jobs: remoteAlignRunJobs, logger: ctx.logger, sessions: sessionsSvc,
        onFinish: () => {
          // 对齐成功后补一次同步把合并结果推上去（延迟 + 锁重试）
          if (job.code === 0 && targets.length > 0) {
            const post = (n) => runSync({ autoAlign: false }).catch(e => {
              if (/另一个同步进程/.test(String(e && e.message)) && n < 4) setTimeout(() => post(n + 1), 5000)
              else ctx.logger.warn(`dsh-sync: post-remote-align sync: ${e && e.message}`)
            })
            setTimeout(() => post(0), 3000)
          }
        },
      })
      return { job, targets }
    }

    // ── Startup + periodic auto-sync ──
    ctx.effect(() => {
      const fireIfDue = async (reason) => {
        await stateLoaded
        const eff = syncSettings()
        if (!eff.autoSync) return
        if (reason === 'startup' && !eff.syncOnStartup) return
        runSync().catch(e => ctx.logger.warn(`dsh-sync: ${reason} sync: ${e && e.message}`))
      }
      fireIfDue('startup')
      const timer = setInterval(() => fireIfDue('interval'), Math.max(5, (syncSettings().intervalMinutes || 30)) * 60 * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'dsh-sync: auto-sync')

    // ── HTTP API ──
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-sync/api',
      handler: async (req, res) => {
        // 与其它 host 路由一致的信任栅栏：connection 服务的 Host/Origin 检查
        // 加浏览器认证，防止本机任意网页跨站调用。
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end()
          return
        }
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const apiPath = url.pathname.replace(/\/+$/, '')
          const query = url.searchParams

          // GET /dsh-sync/api/status
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/status')) {
            await stateLoaded
            const eff = syncSettings()
            const { token, webdavPassword: _wdvPw, ...safe } = eff
            const repoExists = await fsP.access(join(repoDir, '.git')).then(() => true).catch(() => false)
            sendJson(res, 200, {
              repoUrl: eff.repoUrl, branch: eff.branch, dir: displayPath(repoDir), repoExists,
              instanceId: state.instanceId,
              gitAvailable: await gitAvailableCached(eff.gitBinary),
              lastSyncAt: state.lastSyncAt, lastResult: state.lastResult,
              autoSync: eff.autoSync, syncOnStartup: eff.syncOnStartup,
              intervalMinutes: eff.intervalMinutes, conflictMode: eff.conflictMode,
              syncSkills: eff.syncSkills, syncSessions: eff.syncSessions,
              syncSettings: eff.syncSettings, syncPlugins: eff.syncPlugins,
              strategies: {
                skills: STRATEGY_VALUES.includes(eff.skillsStrategy) ? eff.skillsStrategy : 'union',
                sessions: STRATEGY_VALUES.includes(eff.sessionsStrategy) ? eff.sessionsStrategy : 'backup',
                settings: STRATEGY_VALUES.includes(eff.settingsStrategy) ? eff.settingsStrategy : 'backup',
                plugins: STRATEGY_VALUES.includes(eff.pluginsStrategy) ? eff.pluginsStrategy : 'backup',
              },
              snapshot: { skills: eff.snapshotSkills === true, auto: eff.snapshotAuto !== false, localKeep: eff.snapshotLocalKeep || 30 },
              hasToken: typeof token === 'string' && token !== '',
              syncing: syncRun !== null,
              // 多协议状态：git 完整同步；webdav/local 纯备份目标
              gitEnabled: gitProtocolOn(eff),
              protocols: {
                git: { enabled: eff.gitEnabled !== false, configured: !!(eff.repoUrl && token) },
                webdav: { enabled: !!eff.webdavEnabled, configured: !!eff.webdavUrl, url: eff.webdavUrl || '', username: eff.webdavUsername || '', dir: eff.webdavDir || 'dsh-sync', hasPassword: !!eff.webdavPassword },
                local: { enabled: !!eff.localEnabled, configured: !!eff.localDir, dir: eff.localDir || '' },
              },
              lastBackup: (state.lastResult && state.lastResult.backup) || null,
              pendingConflict: state.lastResult && state.lastResult.push && state.lastResult.push.conflict === true
                ? { branch: state.lastPushedBranch, prNumber: state.lastPrNumber } : null,
              bothModifiedPending: Object.keys(state.pendingBoth && typeof state.pendingBoth === 'object' ? state.pendingBoth : {}),
              settingsPreserved: !!(state.lastResult && state.lastResult.push && state.lastResult.push.settingsPreserved),
              persist: lastPersist,
              // 当前仓库的托管方（provider 按钮组的回显 + 自建/未知主机的风险提示）
              provider: (() => {
                const p = detectRepoProvider(eff.repoUrl)
                return { kind: p.kind, host: p.host, owner: p.owner, repo: p.repo, label: PROVIDER_LABEL[p.kind] || PROVIDER_LABEL.generic, unverified: p.kind === 'generic' && !!(p.owner && p.repo) }
              })(),
              alignRunning: alignState.active,
            })
            return
          }

          // POST /dsh-sync/api/sync
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/sync')) {
            try {
              const result = await runSync()
              sendJson(res, 200, result)
            } catch (e) { sendJson(res, 400, { error: String(e && e.message || e) }) }
            return
          }

          // GET /dsh-sync/api/diag — 宿主 settings 通道诊断：Config 形态、描述符可见性、
          // 写回与落盘结果。排障「保存后重启回默认」用，不影响正常流程。
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/diag')) {
            await stateLoaded
            const diagDescriptor = readDescriptor()
            let documentPath = null
            try { documentPath = (ctx.settings && ctx.settings.documentPath) || null } catch {}
            sendJson(res, 200, {
              schemaKind,
              schemasterySource: schemasterySource || null,
              schemasteryError: lastSchemasteryError || null,
              configType: typeof Config,
              configHasToJSON: !!(Config && typeof Config.toJSON === 'function'),
              settingsNs: SYNC_SETTINGS_NS,
              descriptorVisible: !!diagDescriptor,
              descriptorKeys: diagDescriptor && diagDescriptor.value && typeof diagDescriptor.value === 'object' ? Object.keys(diagDescriptor.value) : null,
              documentPath,
              documentPathMtime: hostDocumentMtime() || null,
              lastPersist,
              settingsFile,
              fileSettingsKeys: Object.keys(fileSettings),
              fileSettingsMtime,
              docUpdatedAt: docUpdatedAt || null,
            })
            return
          }

          // PUT /dsh-sync/api/settings
          if (req.method === 'PUT' && apiPath.endsWith('/dsh-sync/api/settings')) {
            const body = await readJsonBody(req)
            await stateLoaded
            const patch = {}
            const cleared = []
            const ignored = []
            // 收集规则（0.4.4 起区分「写入 / 清除 / 跳过」并回传客户端）：
            //  非空串=写入；null=显式清除；''=保持原值（旧客户端整表单提交时空串
            //  不应误清已存值，但记入 ignored，便于 UI 说明"该字段为空"）。
            for (const key of ['repoUrl', 'branch', 'gitBinary', 'conflictMode']) {
              if (typeof body[key] === 'string' && body[key] !== '') patch[key] = body[key]
              else if (body[key] === null) cleared.push(key)
              else if (body[key] !== undefined) ignored.push(key)
            }
            for (const key of ['skillsStrategy', 'sessionsStrategy', 'settingsStrategy', 'pluginsStrategy']) {
              if (STRATEGY_VALUES.includes(body[key])) patch[key] = body[key]
              else if (body[key] !== undefined) ignored.push(key)
            }
            for (const key of ['snapshotSkills', 'snapshotAuto']) {
              if (typeof body[key] === 'boolean') patch[key] = body[key]
              else if (body[key] !== undefined) ignored.push(key)
            }
            if (typeof body.snapshotLocalKeep === 'number' && body.snapshotLocalKeep >= 1) patch.snapshotLocalKeep = Math.floor(body.snapshotLocalKeep)
            else if (body.snapshotLocalKeep !== undefined) ignored.push('snapshotLocalKeep')
            for (const key of ['autoSync', 'syncOnStartup', 'syncSkills', 'syncSessions', 'syncSettings', 'syncPlugins', 'gitEnabled', 'webdavEnabled', 'localEnabled']) {
              if (typeof body[key] === 'boolean') patch[key] = body[key]
              else if (body[key] !== undefined) ignored.push(key)
            }
            if (typeof body.intervalMinutes === 'number' && body.intervalMinutes >= 1) patch.intervalMinutes = body.intervalMinutes
            else if (body.intervalMinutes !== undefined) ignored.push('intervalMinutes')
            // webdav/local 配置：空串允许（清空地址=停用该协议的一种方式）
            for (const key of ['webdavUrl', 'webdavUsername', 'webdavDir', 'localDir']) {
              if (typeof body[key] === 'string') patch[key] = body[key]
              else if (body[key] !== undefined) ignored.push(key)
            }
            // token: 非空=写入；null/''=清除。永不回显。
            if (typeof body.token === 'string' && body.token !== '') patch.token = body.token
            if (body.token === null || body.token === '') cleared.push('token')
            // webdavPassword 同 token 语义：非空才覆盖、null 显式清除（整表单保存
            // 时空串不误清已存密码）
            if (typeof body.webdavPassword === 'string' && body.webdavPassword !== '') patch.webdavPassword = body.webdavPassword
            if (body.webdavPassword === null) cleared.push('webdavPassword')
            // 私仓硬校验：首次填/换仓库地址（或换 token）时拒绝公共仓库。GitCode
            // 之外的主机按 provider 判定；自建/未知主机判不了 ⇒ 先要用户确认风险
            // （400 UNVERIFIED_REPO），客户端确认后带 allowUnverifiedRepo 重发。
            const checkUrl = patch.repoUrl || (cleared.includes('repoUrl') ? '' : syncSettings().repoUrl)
            const checkToken = patch.token || (cleared.includes('token') ? '' : syncSettings().token)
            if (checkUrl && checkToken && (patch.repoUrl || patch.token)) {
              const check = await checkRepoAccess(checkToken, checkUrl, { allowUnverified: body.allowUnverifiedRepo === true })
              if (!check.ok) {
                sendJson(res, 400, {
                  error: check.error, isPublic: !!check.isPublic, code: check.code,
                  needConfirm: !!check.needConfirm, unverified: !!check.unverified,
                  provider: check.provider && check.provider.kind, host: (check.provider && check.provider.host) || '',
                })
                return
              }
            }
            // 清除语义统一走 cleared：内存 overrides 与自持文件都要删，宿主文档用
            // mutate(unset)，否则重启后 doc 层会把已清除的值带回来。
            for (const key of cleared) { delete settingsOverrides[key]; delete fileSettings[key]; clearedKeys.add(key) }
            Object.assign(settingsOverrides, patch)
            for (const key of Object.keys(patch)) clearedKeys.delete(key)
            // 持久化①：自持 settings.json（不依赖宿主通道）。面板保存即落盘，
            // 重启后由文件层恢复 —— 宿主写回失败也不丢配置。
            Object.assign(fileSettings, patch)
            const fileOk = await persistSettingsFile()
            // 持久化②：宿主 settings 文档（profile patch）。失败只告警，结果通过
            // persist 字段回给客户端，UI 据此提示「已保存到本地」而不是假装成功。
            let hostOk = null
            let hostError = null
            if (ctx.settings && typeof ctx.settings.update === 'function') {
              try {
                if (Object.keys(patch).length > 0) await ctx.settings.update(SYNC_SETTINGS_NS, { sync: patch })
                for (const key of cleared) {
                  if (typeof ctx.settings.mutate === 'function') await ctx.settings.mutate(SYNC_SETTINGS_NS, [{ op: 'unset', path: ['sync', key] }])
                }
                hostOk = true
              } catch (e) {
                hostOk = false
                hostError = String(e && e.message || e)
                ctx.logger.warn('dsh-sync: 宿主 settings 写回失败（设置已持久化到 ' + settingsFile + '，重启后仍生效）: ' + hostError)
              }
            } else {
              hostError = 'settings service unavailable'
            }
            lastPersist = { ...lastPersist, hostOk, hostError, at: new Date().toISOString() }
            if (!fileOk) ctx.logger.warn('dsh-sync: 设置未能落盘（settings.json 写入失败）')
            const eff = syncSettings()
            const { token, webdavPassword: _wdvPw, ...safe } = eff
            sendJson(res, 200, {
              settings: safe,
              hasToken: typeof token === 'string' && token !== '',
              persist: lastPersist,
              // applied=真正写入/清除的键；ignored=收到但被跳过的键（空串/类型不符），
              // 客户端据此区分"保存成功"和"什么都没保存"。
              applied: [...new Set([...Object.keys(patch), ...cleared])],
              cleared: [...new Set(cleared)],
              ignored: [...new Set(ignored)],
            })
            return
          }

          // POST /dsh-sync/api/protocol/test {protocol, url?, ...} → 协议连通性
          // 测试；body 字段覆盖已存配置（保存前就能测）。git 走私仓校验，
          // webdav 走 PROPFIND 探测，local 走目录写探测。
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/protocol/test')) {
            const body = await readJsonBody(req)
            await stateLoaded
            const eff = syncSettings()
            const kind = body.protocol
            if (kind === 'webdav') {
              const url = typeof body.url === 'string' && body.url ? body.url : eff.webdavUrl
              if (!url) { sendJson(res, 200, { ok: false, error: '缺少 WebDAV 地址' }); return }
              try {
                const client = createWebdavClient({
                  url,
                  username: typeof body.username === 'string' ? body.username : eff.webdavUsername,
                  password: typeof body.password === 'string' && body.password !== '' ? body.password : eff.webdavPassword,
                  basePath: typeof body.dir === 'string' && body.dir ? body.dir : eff.webdavDir,
                })
                sendJson(res, 200, await client.probe())
              } catch (e) { sendJson(res, 200, { ok: false, error: String(e && e.message || e) }) }
              return
            }
            if (kind === 'local') {
              const dir = expandTilde(typeof body.dir === 'string' && body.dir ? body.dir : eff.localDir)
              if (!dir) { sendJson(res, 200, { ok: false, error: '缺少备份目录' }); return }
              try {
                await fsP.mkdir(dir, { recursive: true })
                const probe = join(dir, `.dsh-sync-probe-${randomUUID().slice(0, 8)}`)
                await fsP.writeFile(probe, 'dsh-sync')
                await fsP.rm(probe, { force: true })
                sendJson(res, 200, { ok: true })
              } catch (e) { sendJson(res, 200, { ok: false, error: String(e && e.message || e) }) }
              return
            }
            if (kind === 'git') {
              const url = typeof body.repoUrl === 'string' && body.repoUrl ? body.repoUrl : eff.repoUrl
              const token = typeof body.token === 'string' && body.token ? body.token : eff.token
              if (!url || !token) { sendJson(res, 200, { ok: false, error: '缺少仓库地址或访问令牌' }); return }
              const check = await checkRepoAccess(token, url, { allowUnverified: body.allowUnverifiedRepo === true })
              sendJson(res, 200, {
                ok: !!check.ok, error: check.error, code: check.code, needConfirm: !!check.needConfirm,
                unverified: !!check.unverified, provider: check.provider && check.provider.kind, host: (check.provider && check.provider.host) || '',
              })
              return
            }
            sendJson(res, 400, { error: '未知协议：' + String(kind) })
            return
          }

          // POST /dsh-sync/api/conflict/run {prNumber?, branch?} → AI resolves.
          // conflictMode 是 AI 路径的总开关：manual 时所有 AI run 端点一律拒绝
          //（issue #9：门控必须覆盖每一个入口，不能只管自动触发）。
          // 凭据步骤全部在 host：prepare 制造冲突树 → agent 本地解冲突 → onFinish
          // finalize（push + 查 PR + 合并）。token 不进 prompt。
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/conflict/run')) {
            await stateLoaded
            const eff = syncSettings()
            if (eff.conflictMode !== 'ai') { sendJson(res, 403, { error: 'conflictMode 为 manual，AI 冲突处理已关闭（设置页改为「ai」后可用）' }); return }
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            const conflictProvider = detectRepoProvider(eff.repoUrl)
            if (conflictProvider.kind !== 'gitcode') {
              sendJson(res, 400, { error: 'AI 冲突处理依赖 PR 流程，目前仅在 GitCode 仓库上可用（当前主机 ' + (conflictProvider.host || '未知') + '）：换用 GitCode 私有仓库，或手动解决分支冲突' })
              return
            }
            const body = await readJsonBody(req)
            const branch = body.branch || state.lastPushedBranch
            const prNumber = body.prNumber || state.lastPrNumber
            if (!branch || !prNumber) { sendJson(res, 400, { error: '没有待解决的冲突 PR' }); return }
            // prepare 动影子仓库，与自动同步互斥：持锁做，做完释放再放 agent
            const release = await acquireLock(lockFile)
            if (release === null) { sendJson(res, 409, { error: '另一个同步进程正在运行，稍后再试' }); return }
            let prep
            try { prep = await prepareConflictTree(eff.gitBinary, eff, { repoDir, branch }) }
            catch (e) { release(); sendJson(res, 400, { error: '准备冲突工作树失败：' + String(e && e.message || e) }); return }
            release()
            // finalize 收尾（两条路径共用）：push + 轮询 mergeable + squash 合并。
            // 持锁（带重试）：影子仓库推进与自动同步互斥。
            const finalizeJob = async (job, eff2, branch2, prNumber2) => {
              const post = async (n) => {
                const release2 = await acquireLock(lockFile)
                if (release2 === null) {
                  if (n < 4) return setTimeout(() => post(n + 1), 5000)
                  job.status = 'error'; job.code = 1; job.output += '\n[finalize 失败] 同步锁被占，稍后可重试\n'; return
                }
                try {
                  const r = await finalizeConflictBranch(eff2.gitBinary, eff2, { repoDir, branch: branch2, prNumber: prNumber2, state, logger: ctx.logger })
                  if (r.merged) job.output += r.prSkipped ? '\n已推送分支（本地远端，无 PR 可合并）\n' : `\nPR #${prNumber2} 已合并，分支已清理\n`
                  else { job.status = 'error'; job.code = 1; job.output += '\n[finalize 失败] ' + r.reason + '\n' }
                } catch (e) {
                  job.status = 'error'; job.code = 1
                  job.output += '\n[finalize 异常] ' + String(e && e.message || e) + '\n'
                } finally { release2() }
              }
              post(0)
            }
            if (prep.autoMerged) {
              // merge 干净通过：PR 应已可合并，无需 agent，直接走 host finalize
              const job = { id: 'ag' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), status: 'running', startedAt: new Date().toISOString(), dir: repoDir, output: '合并无冲突，直接推送并合并 PR…\n', code: null }
              conflictRunJobs.set(job.id, job)
              finalizeJob(job, eff, branch, prNumber)
              sendJson(res, 202, { jobId: job.id, status: job.status, autoMerged: true })
              return
            }
            const prompt = substituteParams(CONFLICT_PROMPT_ZH, {
              repoUrl: eff.repoUrl, shadowDir: repoDir, branch, prNumber,
            })
            const job = createAgentRunJob({
              prompt, dir: homedir(), jobs: conflictRunJobs, logger: ctx.logger, sessions: sessionsSvc,
              onFinish: () => {
                // agent 提交后由 host 收尾：push、轮询 mergeable、squash 合并、清分支
                if (job.code !== 0) { job.output += '\n[agent 未正常完成，保留冲突 PR 待人工处理]\n'; return }
                finalizeJob(job, eff, branch, prNumber)
              },
            })
            sendJson(res, 202, { jobId: job.id, status: job.status, conflicts: prep.conflicts })
            return
          }

          // GET /dsh-sync/api/conflict/run?id= → job status/output
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/conflict/run')) {
            const id = query.get('id') || ''
            const job = conflictRunJobs.get(id)
            if (job === undefined) { sendJson(res, 404, { error: 'job not found' }); return }
            sendJson(res, 200, { ...job, output: (job.output || '').slice(-32 * 1024) })
            return
          }

          // POST /dsh-sync/api/align/run → AI 智能对齐：先跑一次确定性同步
          // （远端新增自动回填、bothModified 不覆盖），再把两边都改过的文件交
          // agent 语义合并
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/align/run')) {
            await stateLoaded
            const eff = syncSettings()
            if (eff.conflictMode !== 'ai') { sendJson(res, 403, { error: 'conflictMode 为 manual，AI 智能对齐已关闭（设置页改为「ai」后可用）' }); return }
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            let syncResult = null
            try { syncResult = await runSync({ autoAlign: false }) }
            catch (e) { sendJson(res, 400, { error: '同步预检失败：' + String(e && e.message || e) }); return }
            const rec = syncResult && syncResult.reconcile
            const fresh = (rec && Array.isArray(rec.bothModified)) ? rec.bothModified : []
            state.pendingBoth = state.pendingBoth && typeof state.pendingBoth === 'object' ? state.pendingBoth : {}
            const both = [...fresh, ...Object.keys(state.pendingBoth)
              .filter(p => !fresh.some(f => f.shadowPath === p))
              .map(p => {
                const livePath = resolveLivePath(syncSpec(eff, defaultRoots(), state.instanceId), p)
                return livePath ? { shadowPath: p, livePath, baseCommit: state.pendingBoth[p] } : null
              })
              .filter(Boolean)]
            const job = await startAlignJob(eff, both)
            sendJson(res, 202, {
              jobId: job.id, status: job.status,
              bothModified: both.map(f => f.shadowPath),
              reconcile: rec ? { applied: rec.applied, bothModified: rec.bothModified.length, remoteDeleted: rec.remoteDeleted } : null,
            })
            return
          }

          // GET /dsh-sync/api/align/run?id= → job status/output
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/align/run')) {
            const id = query.get('id') || ''
            const job = alignRunJobs.get(id)
            if (job === undefined) { sendJson(res, 404, { error: 'job not found' }); return }
            sendJson(res, 200, { ...job, output: (job.output || '').slice(-32 * 1024) })
            return
          }

          // POST /dsh-sync/api/prune-branches → 清理已合并的 sync/* 遗留分支。
          // squash 合并后分支 tip 不在 main 历史里，merge-base 判不了，改用
          // 「已合并 PR 的 head 分支名」集合来判定
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/prune-branches')) {
            await stateLoaded
            const eff = syncSettings()
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            const pruneProvider = detectRepoProvider(eff.repoUrl)
            if (pruneProvider.kind !== 'gitcode') {
              sendJson(res, 400, { error: '清理遗留分支走的是 GitCode PR 列表接口，目前仅支持 GitCode 仓库（当前主机 ' + (pruneProvider.host || '未知') + '）——请到仓库网页端手动删除 sync/* 分支' })
              return
            }
            const parsed = parseRepoUrl(eff.repoUrl)
            if (!parsed) { sendJson(res, 400, { error: '仅支持 GitCode 仓库' }); return }
            const hasShadow = await fsP.access(join(repoDir, '.git')).then(() => true).catch(() => false)
            if (!hasShadow) { sendJson(res, 400, { error: '影子仓库未初始化，先同步一次' }); return }
            const remote = eff.repoUrl, authEnv = gitAuthEnv(eff)
            try { await gitExec(eff.gitBinary, ['fetch', remote, eff.branch], repoDir, authEnv) } catch (e) {
              sendJson(res, 400, { error: 'fetch 失败：' + String(e && e.message || e) }); return
            }
            // 收集已合并 PR 的 head 分支（翻页直到取完，上限 20 页 × 100）
            const mergedHeads = new Set()
            for (let page = 1; page <= 20; page++) {
              const r = await gitcodeRequest(eff.token, 'GET', `/repos/${parsed.owner}/${parsed.repo}/pulls?state=merged&per_page=100&page=${page}`)
              if (!r.ok || !Array.isArray(r.json) || r.json.length === 0) break
              for (const pr of r.json) { if (pr.head && pr.head.ref) mergedHeads.add(pr.head.ref) }
              if (r.json.length < 100) break
            }
            const ls = await gitExec(eff.gitBinary, ['ls-remote', '--heads', remote, 'refs/heads/sync/*'], repoDir, authEnv).catch(() => '')
            const refs = ls.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
              const [sha, ref] = l.split(/\t/)
              return { sha, branch: String(ref || '').replace('refs/heads/', '') }
            }).filter(x => x.branch)
            const deleted = [], kept = [], errors = []
            for (const { branch } of refs) {
              if (!mergedHeads.has(branch)) { kept.push(branch); continue }
              try {
                await gitExec(eff.gitBinary, ['push', remote, '--delete', branch], repoDir, authEnv)
                deleted.push(branch)
              } catch (e) { errors.push(`${branch}: ${String(e && e.message || e).slice(0, 120)}`) }
            }
            sendJson(res, 200, { deleted, kept, errors, scanned: refs.length })
            return
          }

          // POST /dsh-sync/api/snapshot/run {name?, cloud?} → 打快照；勾选 cloud 才上 git
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/snapshot/run')) {
            const body = await readJsonBody(req)
            await stateLoaded
            const eff = syncSettings()
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            let name = sanitizeSnapshotName(body.name)
            if (!name) name = `manual-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
            const dup = await fsP.access(join(syncDir, 'snapshots', name)).then(() => true).catch(() => false)
            if (dup) name = `${name}-${Date.now()}`
            const dir = await createLocalSnapshot(eff, name)
            let promoted = false, promoteResult = null
            const protoResults = {}
            if (body.cloud === true) {
              const protos = resolveBackupProtocols(eff)
              const gitOn = gitProtocolOn(eff)
              if (!gitOn && protos.length === 0) { sendJson(res, 400, { error: '没有已启用的云端协议：请先配置 Git 仓库、WebDAV 或本地文件夹' }); return }
              const release = await acquireLock(lockFile)
              if (release === null) { sendJson(res, 400, { error: '另一个同步进程正在运行，稍后再试' }); return }
              try {
                // git：沿用 分支→PR→合并 的云上存档路径 backup/<id>/snapshots/<名字>/
                if (gitOn) {
                  try {
                    promoteResult = await promoteSnapshotToCloud(eff.gitBinary, eff, { repoDir, instanceId: state.instanceId, state, logger: ctx.logger }, name, dir)
                    protoResults.git = { ok: promoteResult.promoted === true, merged: promoteResult.merged === true }
                    promoted = promoted || promoteResult.promoted === true
                  } catch (e) { protoResults.git = { ok: false, error: String(e && e.message || e) } }
                }
                // webdav / local：同布局 backup/<id>/snapshots/<名字>/，纯 PUT/复制
                for (const proto of protos) {
                  try {
                    protoResults[proto.kind] = await promoteSnapshotToProtocol(proto, dir, { instanceId: state.instanceId, snapName: name })
                    promoted = true
                  } catch (e) { protoResults[proto.kind] = { ok: false, error: String(e && e.message || e) } }
                }
                if (promoted && !(state.cloudSnapshots || []).includes(name)) { state.cloudSnapshots.push(name); await saveState() }
              } finally { release() }
            }
            const pruned = await pruneLocalSnapshots(join(syncDir, 'snapshots'), eff.snapshotLocalKeep || 30, state.cloudSnapshots).catch(() => [])
            sendJson(res, 200, { name, promoted, promoteResult, protocols: protoResults, pruned })
            return
          }

          // GET /dsh-sync/api/snapshot/list → 本地快照 + 云端名单
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/snapshot/list')) {
            await stateLoaded
            const dir = join(syncDir, 'snapshots')
            const local = []
            try {
              for (const ent of await fsP.readdir(dir, { withFileTypes: true })) {
                if (!ent.isDirectory()) continue
                let created = undefined
                try { created = (await fsP.stat(join(dir, ent.name))).birthtime.toISOString() } catch {}
                local.push({ name: ent.name, created, inCloud: (state.cloudSnapshots || []).includes(ent.name) })
              }
            } catch {}
            local.sort((a, b) => b.name.localeCompare(a.name))
            sendJson(res, 200, { local, cloud: state.cloudSnapshots || [] })
            return
          }

          // POST /dsh-sync/api/snapshot/restore {name} → 恢复（先拍 pre-restore 安全快照）
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/snapshot/restore')) {
            const body = await readJsonBody(req)
            await stateLoaded
            const eff = syncSettings()
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            const name = sanitizeSnapshotName(body.name)
            if (!name) { sendJson(res, 400, { error: '缺少快照名' }); return }
            let srcDir = join(syncDir, 'snapshots', name)
            const localExists = await fsP.access(srcDir).then(() => true).catch(() => false)
            if (!localExists) {
              if (!(state.cloudSnapshots || []).includes(name)) { sendJson(res, 404, { error: `本地与云端都没有快照 ${name}` }); return }
              const release = await acquireLock(lockFile)
              if (release === null) { sendJson(res, 400, { error: '另一个同步进程正在运行，稍后再试' }); return }
              let fetched = false
              const fetchErrors = []
              try {
                // 回退顺序 git → webdav → local：哪个协议有这份快照就从哪取
                const gitOn = gitProtocolOn(eff)
                if (gitOn) {
                  try {
                    const remote = eff.repoUrl, authEnv = gitAuthEnv(eff)
                    await gitExec(eff.gitBinary, ['fetch', remote, eff.branch], repoDir, authEnv)
                    const cloudPath = `backup/${state.instanceId}/snapshots/${name}`
                    await gitExec(eff.gitBinary, ['checkout', 'FETCH_HEAD', '--', cloudPath], repoDir)
                    await copyTree(join(repoDir, cloudPath), srcDir, {})
                    await gitExec(eff.gitBinary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
                    fetched = true
                  } catch (e) { fetchErrors.push(`git: ${String(e && e.message || e)}`) }
                }
                if (!fetched) {
                  for (const proto of resolveBackupProtocols(eff)) {
                    try {
                      await fetchSnapshotFromProtocol(proto, { instanceId: state.instanceId, snapName: name }, srcDir)
                      fetched = true
                      break
                    } catch (e) { fetchErrors.push(`${proto.kind}: ${String(e && e.message || e)}`) }
                  }
                }
                if (!fetched) { sendJson(res, 400, { error: `云端协议中都没有快照 ${name}（${fetchErrors.join('；') || '无已启用协议'}）` }); return }
                if (!(state.cloudSnapshots || []).includes(name)) { state.cloudSnapshots.push(name); await saveState() }
              } finally { release() }
            }
            // 恢复前给当前状态拍安全快照
            const safetyName = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
            await createLocalSnapshot(eff, safetyName)
            // 反向写回 live（快照里有哪些组就恢复哪些）
            const spec = snapshotMirrorSpec(eff, defaultRoots(), state.instanceId, name)
            const restored = []
            for (const group of spec) {
              for (const src of group.sources) {
                const snapPath = join(syncDir, src.to)   // src.to 已含 snapshots/<名字>/ 前缀，快照根就是 syncDir
                const have = await fsP.access(snapPath).then(() => true).catch(() => false)
                if (!have) continue
                if (src.file) {
                  await fsP.mkdir(join(src.from, '..'), { recursive: true })
                  await fsP.copyFile(snapPath, src.from)
                } else {
                  await copyTree(snapPath, src.from, { includeFiles: src.includeFiles, excludeDirs: src.excludeDirs, excludeNames: src.excludeNames, followSymlinks: src.followSymlinks })
                }
                if (!restored.includes(group.name)) restored.push(group.name)
              }
            }
            await pruneLocalSnapshots(join(syncDir, 'snapshots'), eff.snapshotLocalKeep || 30, state.cloudSnapshots).catch(() => [])
            runSync({ autoAlign: false }).catch(() => {})
            sendJson(res, 200, { restored: restored, safetySnapshot: safetyName })
            return
          }

          // GET /dsh-sync/api/remote/browse → 实例列表 + 根目录树
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/remote/browse')) {
            await stateLoaded
            const eff = syncSettings()
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            if (!(await gitAvailable(eff.gitBinary))) { sendJson(res, 400, { error: 'PATH 上找不到 git' }); return }
            try {
              const result = await browseRemote(eff.gitBinary, eff, { repoDir, state })
              sendJson(res, 200, result)
            } catch (e) { sendJson(res, 400, { error: String(e && e.message || e) }) }
            return
          }

          // GET /dsh-sync/api/remote/tree?path= → 子目录内容（只读浏览）
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/remote/tree')) {
            await stateLoaded
            const eff = syncSettings()
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            try {
              const result = await browseRemoteTree(eff.gitBinary, eff, { repoDir }, query.get('path') || '')
              sendJson(res, 200, result)
            } catch (e) { sendJson(res, 400, { error: String(e && e.message || e) }) }
            return
          }

          // POST /dsh-sync/api/remote/pull {paths, apply?} → 预览计划 / 应用拉取
          // apply=false（默认）→ 只返回计划（哪些可拉、哪些被阻止及原因），不写盘
          // apply=true → 拍 pre-remote-pull 安全快照 → 写入安全的文件 → 触发同步传播
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/remote/pull')) {
            const body = await readJsonBody(req)
            await stateLoaded
            const eff = syncSettings()
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            const hasShadow = await fsP.access(join(repoDir, '.git')).then(() => true).catch(() => false)
            if (!hasShadow) { sendJson(res, 400, { error: '影子仓库未初始化，先同步一次' }); return }
            await fetchBrowseRef(eff.gitBinary, eff, repoDir).catch(() => {})
            const planResult = await planRemotePull(eff.gitBinary, eff, { repoDir, state, roots: defaultRoots() }, body.paths || [])
            if (!body.apply) { sendJson(res, 200, planResult); return }
            const release = await acquireLock(lockFile)
            if (release === null) { sendJson(res, 400, { error: '另一个同步进程正在运行，稍后再试' }); return }
            let safetyName
            try {
              safetyName = `pre-remote-pull-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
              try { await createLocalSnapshot(eff, safetyName) } catch {}
              const applyResult = await applyRemotePullPlan(eff.gitBinary, eff, { repoDir, state, roots: defaultRoots() }, planResult.plan)
              runSync({ autoAlign: false }).catch(() => {})
              try { await pruneLocalSnapshots(join(syncDir, 'snapshots'), eff.snapshotLocalKeep || 30, state.cloudSnapshots) } catch {}
              sendJson(res, 200, { ...applyResult, safetySnapshot: safetyName, plan: planResult.plan })
            } catch (e) { sendJson(res, 400, { error: String(e && e.message || e) }) }
            finally { release() }
            return
          }

          // POST /dsh-sync/api/remote/align {paths} → AI 对齐：把选中的跨机
          // 文件与本机版本语义合并（逐键/并集），而非整文件覆盖。先拍安全快照，
          // 再启动 agent job 做合并。
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/remote/align')) {
            const body = await readJsonBody(req)
            await stateLoaded
            const eff = syncSettings()
            if (eff.conflictMode !== 'ai') { sendJson(res, 403, { error: 'conflictMode 为 manual，AI 远端对齐已关闭（设置页改为「ai」后可用）' }); return }
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            const hasShadow = await fsP.access(join(repoDir, '.git')).then(() => true).catch(() => false)
            if (!hasShadow) { sendJson(res, 400, { error: '影子仓库未初始化，先同步一次' }); return }
            await fetchBrowseRef(eff.gitBinary, eff, repoDir).catch(() => {})
            const planResult = await planRemotePull(eff.gitBinary, eff, { repoDir, state, roots: defaultRoots() }, body.paths || [])
            const targets = planResult.plan.filter(p => p.warn && p.action === 'apply' && p.livePath)
            if (targets.length === 0) { sendJson(res, 400, { error: '选中的文件中没有需要 AI 对齐的项（跨机 settings/plugins）' }); return }
            const { job } = await startRemoteAlignJob(eff, planResult.plan)
            sendJson(res, 202, {
              jobId: job.id, status: job.status,
              bothModified: targets.map(t => t.remotePath),
              backupDir: job.dir,
            })
            return
          }

          // GET /dsh-sync/api/remote/align?id= → job status/output
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/remote/align')) {
            const id = query.get('id') || ''
            const job = remoteAlignRunJobs.get(id)
            if (job === undefined) { sendJson(res, 404, { error: 'job not found' }); return }
            sendJson(res, 200, { ...job, output: (job.output || '').slice(-32 * 1024) })
            return
          }

          // GET /dsh-sync/api/remote/preview?path= → 文件内容预览（文本，上限 64KB）
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/remote/preview')) {
            await stateLoaded
            const eff = syncSettings()
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            const path = query.get('path') || ''
            if (!path) { sendJson(res, 400, { error: '缺少 path 参数' }); return }
            let refOk = true
            try { await gitExec(eff.gitBinary, ['rev-parse', '--verify', BROWSE_REF], repoDir) } catch { refOk = false }
            if (!refOk) { sendJson(res, 400, { error: '浏览 ref 不存在，先刷新远端' }); return }
            try {
              const buf = await gitShowBuf(eff.gitBinary, `${BROWSE_REF}:${path}`, repoDir)
              // 简单二进制检测：含 null byte → 二进制
              if (buf.includes(0)) { sendJson(res, 200, { path, binary: true, size: buf.length }); return }
              const text = buf.toString('utf8')
              const cap = 65536
              const truncated = text.length > cap
              sendJson(res, 200, { path, content: truncated ? text.slice(0, cap) : text, size: buf.length, truncated })
            } catch (e) { sendJson(res, 400, { error: String(e && e.message || e) }) }
            return
          }

          sendJson(res, 404, { error: 'not found' })
        } catch (error) { sendJson(res, 400, { error: String(error && error.message || error) }) }
      },
    }), 'dsh-sync: api route')
  },
}
