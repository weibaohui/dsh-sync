'use strict'

/**
 * dsh-plugin-dsh-sync — Host half
 *
 * A small git-based sync system for multiple dsh replicas. Each instance
 * mirrors its skills / sessions / settings / plugins into a private GitCode
 * repository through a branch → PR → merge flow, so two replicas that both
 * touch the same file surface as a pull request instead of a silent
 * overwrite. Deterministic work (fetch / branch / commit / push) is done by
 * the git CLI directly; only the conflict step — which needs semantic
 * judgement — hands off to an in-process agent (same channel skills-management
 * share uses). Token is write-only through the host settings service and
 * never travels to the client in cleartext.
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
const { join, relative, resolve, sep } = require('node:path')
const { homedir, hostname } = require('node:os')
// settings 服务要求 schemastery schema（可调用 + toJSON；zod 不兼容，register 会抛错被吞）。
// 宿主沙箱内解析打包依赖可能抛 ERR_INTERNAL_ASSERTION（.pnpm 软链），因此优先沿
// dsh 全局安装取 settings 服务自用的那份副本，本地开发/测试再退回标准 require。
function loadSchemastery() {
  const errors = []
  const { createRequire } = require('node:module')
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, join(homedir(), '.local')].filter(Boolean)) {
    const hostCopy = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs')
    try { return createRequire(hostCopy)(hostCopy) } catch (e) { errors.push(String(e && e.code || e)) }
  }
  try { return require('@deepseek-ai/schemastery') } catch (e) { errors.push(String(e && e.code || e)) }
  if (process.env.DSHSYNC_DEBUG) console.warn(`[dsh-sync] schemastery unavailable: ${errors.join(' | ')}`)
  return null
}
const Schema = loadSchemastery()

const GITCODE_API_BASE = 'https://api.gitcode.com/api/v5'
const MAX_BODY_BYTES = 64 * 1024
const SYNC_TIMEOUT_MS = 10 * 60 * 1000
const CONFLICT_RUN_TIMEOUT_MS = 30 * 60 * 1000
const CONFLICT_RUN_OUTPUT_CAP = 256 * 1024

const DEFAULT_SYNC_SETTINGS = {
  repoUrl: '',
  branch: 'main',
  gitBinary: 'git',
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
}

const STRATEGY_VALUES = ['backup', 'union', 'remote', 'local']

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

// ── Git CLI (token stays out of .git/config — authed URL per command) ──

function gitExec(binary, args, cwd) {
  return new Promise((fulfil, reject) => {
    execFile(binary, args, { cwd, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
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

async function gitCurrentCommit(binary, repo) {
  try { return (await gitExec(binary, ['rev-parse', 'HEAD'], repo)).trim() } catch { return undefined }
}

/** Embed an access token in an https remote URL (gitcode/oauth2 style).
 *  Credentials stay out of .git/config — every remote-touching command
 *  receives the authed URL directly and nothing is persisted. */
function authedUrl(url, token) {
  if (!token) return url
  return String(url).replace(/^(https?:\/\/)([^@/]+@)?/, `$1oauth2:${encodeURIComponent(token)}@`)
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
  const remote = authedUrl(eff.repoUrl, eff.token)
  let exists = false
  try { await fsP.access(join(repoDir, '.git')); exists = true } catch { exists = false }
  if (!exists) {
    await fsP.rm(repoDir, { recursive: true, force: true }).catch(() => {})
    await fsP.mkdir(join(repoDir, '..'), { recursive: true })
    // Try a shallow clone first; an empty repo (first ever sync) fails, in
    // which case init locally and let the first push seed the remote.
    try {
      await gitExec(binary, ['clone', '-b', eff.branch, '--depth', '1', remote, repoDir])
      // clone 会把带 token 的 URL 写进 .git/config——立刻换回干净地址，
      // 后续 fetch/push 一律显式传 authedUrl，凭证不落盘
      await gitExec(binary, ['remote', 'set-url', 'origin', eff.repoUrl], repoDir).catch(() => {})
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
  const spec = syncSpec(eff, roots, instanceId)
  // 首次接入判定必须在任何基线推进之前读
  const firstJoin = !state.lastSyncedCommit
  let settingsPreserved = false

  // 1. fetch origin/main → FETCH_HEAD (canonical baseline)
  try { await gitExec(binary, ['fetch', remote, eff.branch], repoDir) } catch (e) {
    // first-ever push to an empty remote: no main yet, skip fetch
    if (!/Could not find|doesn't exist|no such|empty/i.test(String(e && e.message))) throw e
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

  // 4. commit on a fresh branch
  await gitExec(binary, ['checkout', '-b', branch], repoDir)
  await gitExec(binary, ['add', '-A'], repoDir)
  let commitOk = false
  try { await gitExec(binary, ['-c', 'user.name=dsh-sync', '-c', 'user.email=dsh-sync@local', 'commit', '-m', `sync ${instanceId} ${new Date().toISOString()}`], repoDir); commitOk = true } catch { /* nothing to commit */ }
  if (!commitOk) return { pushed: false, nothingToCommit: true }

  // 5. push the branch (token in URL, not in config)
  await gitExec(binary, ['push', remote, `HEAD:${branch}`], repoDir)

  // 6. create PR + mergeable check
  const parsed = parseRepoUrl(eff.repoUrl)
  if (!parsed) {
    // non-GitCode remote (local test, self-hosted git): push the branch only;
    // PR create/merge is GitCode-specific and skipped. Advance shadow onto
    // main as the next cycle's pull baseline.
    await gitExec(binary, ['fetch', remote, eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
    state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
    state.lastPushedBranch = branch
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
    await gitExec(binary, ['push', remote, '--delete', branch], repoDir).catch(() => {})
    // advance shadow to the merged main
    await gitExec(binary, ['fetch', remote, eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
    state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
    return { pushed: true, merged: true, prNumber, settingsPreserved }
  }
  // conflict → leave PR open; client shows the "AI 解决冲突" action button
  return { pushed: true, prConflict: true, prNumber, conflict: true, settingsPreserved }
}

// ── Three-way pull: remote deltas → live, only for untouched files ──

async function runPull(binary, eff, { repoDir, state, logger, roots }) {
  const remote = authedUrl(eff.repoUrl, eff.token)
  const spec = syncSpec(eff, roots, state.instanceId)
  const lastSynced = state.lastSyncedCommit
  try { await gitExec(binary, ['fetch', remote, eff.branch], repoDir) } catch (e) {
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
  // files remote changed since lastSyncedCommit
  let changedRaw = ''
  try { changedRaw = await gitExec(binary, ['diff', '--name-only', lastSynced, 'FETCH_HEAD'], repoDir) } catch {}
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
    let remoteBuf = null
    try { remoteBuf = await gitShowBuf(binary, `FETCH_HEAD:${p}`, repoDir) } catch { remoteBuf = null }
    if (remoteBuf === null) { skipped++; delete state.pendingBoth[p]; continue }   // 远端删除不镜像
    if (liveBuf !== null && Buffer.compare(liveBuf, remoteBuf) === 0) { delete state.pendingBoth[p]; continue }
    const fileBase = state.pendingBoth[p] || lastSynced
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
  // advance shadow baseline to the freshly-pulled main
  await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
  await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
  state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
  return { pulled: true, applied, skipped, changed: changed.length }
}

// ── Pre-push reconcile: pull remote changes back into live BEFORE the
//    snapshot push. The push mirror is a full-directory overlay (rm + copy),
//    so without this step a file another machine added — and this replica
//    hasn't pulled yet — gets deleted in the push branch and flaps out of
//    the remote. Remote-only and locally-untouched files are written back
//    here (purely deterministic, never overwrites local work); files both
//    sides changed are reported as `bothModified` for the AI align step /
//    conflict PR. Remote deletions are never mirrored into live. ──

async function reconcileRemote(binary, eff, { repoDir, state, logger, roots }) {
  const fs = require('node:fs')
  try { await fs.promises.access(join(repoDir, '.git')) } catch { return { reconciled: false, noShadow: true } }
  const remote = authedUrl(eff.repoUrl, eff.token)
  const spec = syncSpec(eff, roots, state.instanceId)
  try { await gitExec(binary, ['fetch', remote, eff.branch], repoDir) } catch (e) {
    if (!/Could not find|doesn't exist|no such|empty/i.test(String(e && e.message))) throw e
    return { reconciled: false, empty: true }
  }
  const hasFetch = await gitExec(binary, ['rev-parse', '--verify', 'FETCH_HEAD'], repoDir).then(() => true).catch(() => false)
  if (!hasFetch) return { reconciled: false, empty: true }
  const lastSynced = state.lastSyncedCommit
  if (!lastSynced) {
    // never synced: nothing to diff against; just record the baseline
    await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
    state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
    return { reconciled: false, firstBaseline: true }
  }
  let changedRaw = ''
  try { changedRaw = await gitExec(binary, ['diff', '--name-only', lastSynced, 'FETCH_HEAD'], repoDir) } catch {}
  const changed = changedRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  // 逐文件基线：bothModified 文件在解决前基线不能跟着 lastSyncedCommit 前进
  // （真机实证：基线被推进到远端 tip 后，AI 对齐看到「远端==基线 → 保留本机」，
  // 对端改动在下一次推送时被覆盖）。pendingBoth 记住每个未解决文件的真基线。
  state.pendingBoth = state.pendingBoth && typeof state.pendingBoth === 'object' ? state.pendingBoth : {}
  const applied = []        // safely written back to live
  const bothModified = []   // both sides changed → AI align / conflict PR
  const remoteDeleted = []  // gone on remote; live keeps its copy
  const localKept = []      // machine-owned plugin manifests the remote may not touch
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
    // 未解决文件的基线固定在首次发现冲突时的 commit，其余文件跟随 lastSynced
    const fileBase = state.pendingBoth[p] || lastSynced
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
  return { reconciled: true, applied, bothModified, remoteDeleted, localKept, changed: changed.length }
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
  const remote = authedUrl(eff.repoUrl, eff.token)
  try { await gitExec(binary, ['fetch', remote, eff.branch], repoDir) } catch (e) {
    if (!/Could not find|doesn't exist|no such|empty/i.test(String(e && e.message))) throw e
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
  await gitExec(binary, ['push', remote, `HEAD:${branch}`], repoDir)
  const parsed = parseRepoUrl(eff.repoUrl)
  if (!parsed) {
    // 非 GitCode 远端：推分支后把影子基线推进到 main（与 runPush 的 prSkipped 路径一致）
    await gitExec(binary, ['fetch', remote, eff.branch], repoDir).catch(() => {})
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
  if (merged) await gitExec(binary, ['push', remote, '--delete', branch], repoDir).catch(() => {})
  await gitExec(binary, ['fetch', remote, eff.branch], repoDir).catch(() => {})
  await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
  await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
  state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
  return { promoted: true, merged, prNumber, branch }
}

// ── Conflict-resolution action button: in-process agent (same channel as
//    skills-management share-run). The agent operates the shadow repo's git
//    directly + merges the PR via REST. Only this step needs semantic
//    judgement — everything deterministic stayed in the CLI. ──

const CONFLICT_PROMPT_ZH = [
  '请解决 dsh-sync 同步仓库的冲突 PR，使该 PR 可被合并，然后合并它。',
  '',
  '## 关键信息',
  '- 同步仓库：{{repoUrl}}（GitCode，API base = https://api.gitcode.com）',
  '- 本地工作树（影子仓库）：{{shadowDir}}（需 checkout 到冲突分支 {{branch}}）',
  '- PR 编号：#{{prNumber}}',
  '- 访问令牌：{{token}}（下方步骤直接用此字符串，不要 printenv、不要回显明文）。',
  '',
  '## 工具限制（硬性）',
  '- 只允许使用 bash（git/curl 命令）和 HTTP 请求工具。',
  '- **严禁**使用任何 return / deliver / 投递 / IM 文件类工具（如 dsh_im_return_file）。不要把任何文件“投递”或“返回”出去。',
  '- **不要读取 ~/.dsh/settings.yaml**——token 已在上方给你，别碰配置文件。',
  '- token 是敏感凭据，任何输出、日志、结果里都不要回显其明文。',
  '',
  '## 执行步骤',
  '1. token 已在上方「访问令牌」行给出，后续步骤直接用该字符串（不要 printenv）。',
  '2. 在影子仓库内：`cd {{shadowDir}} && git fetch https://oauth2:{{token}}@gitcode.com/<owner>/<repo>.git main`（token 嵌 URL、不落 .git/config），然后 `git checkout {{branch}}`，再 `git merge FETCH_HEAD` 触发冲突。',
  '3. 查看冲突文件：`git diff --name-only --diff-filter=U` 和 `git status`。对每个冲突文件分析两边版本决定取舍或合并（保留两边有效改动；README 等无语义文件取任一即可）。',
  '4. 解决后：`git add -A && git -c user.name=dsh-sync -c user.email=dsh-sync@local commit --no-edit`，再 `git push https://oauth2:{{token}}@gitcode.com/<owner>/<repo>.git HEAD:{{branch}}`。',
  '5. 查 PR 可合并：`curl -s -H "PRIVATE-TOKEN: {{token}}" https://api.gitcode.com/api/v5/repos/<owner>/<repo>/pulls/{{prNumber}}`，确认 mergeable 为 true。',
  '6. 合并：`curl -s -X PUT -H "PRIVATE-TOKEN: {{token}}" -H "Content-Type: application/json" -d \'{"merge_method":"squash"}\' https://api.gitcode.com/api/v5/repos/<owner>/<repo>/pulls/{{prNumber}}/merge`。',
  '7. 完成后输出 PR 网页链接。',
  '',
  '## 注意',
  '- 认证头必须用 PRIVATE-TOKEN（不要用 Authorization: Bearer，GitCode 子资源端点对 Bearer 有 bug 会 404）。',
  '- 不读 settings.yaml；不回显 token；不用投递类工具。',
  '- 若失败先看错误信息，不盲目重试。全程与最终汇报都使用中文。',
].join('\n')

function substituteParams(template, params) {
  let out = template
  for (const [key, value] of Object.entries(params)) {
    out = out.split(`{{${key}}}`).join(String(value))
  }
  return out
}

// ── AI align action button: semantic merge of files both sides changed.
//    Deterministic reconcile (remote-only pull-back) already ran in the host
//    before this prompt is built; the agent only does the semantic judgement
//    on the reported both-modified files, then triggers a normal sync and
//    falls back to conflict resolution if a PR still can't merge. ──

const ALIGN_PROMPT_ZH = [
  '请执行 dsh-sync 的「AI 智能对齐」：把本机与远端都改过的文件做语义合并，然后触发一次同步完成推送。',
  '',
  '## 路径信息',
  '- 影子仓库（git 工作树，只读用于取版本）：{{shadowDir}}',
  '- 本机 live 同步根：',
  '  - 技能（dsh）：{{skillsDsh}}',
  '  - 技能（agents）：{{skillsAgents}}',
  '  - 会话：{{sessions}}',
  '  - 设置文件：{{settingsFile}}',
  '  - 插件清单：{{profiles}}',
  '- 影子路径 → live 路径映射：`skills/dsh/**` → 技能（dsh）根；`skills/agents/**` → 技能（agents）根；`skills/.skill-lock.json` → agents 根下 `.skill-lock.json`；`sessions/**` → 会话根；`settings/settings.yaml` → 设置文件；`plugins/**` → 插件清单根。',
  '- 备份目录：{{backupDir}}（改动前把 live 原文件按影子相对路径复制进去）',
  '- 本机 dsh web 地址：{{apiBase}}（用它触发同步，不需要令牌）',
  '- 访问令牌：{{token}}（仅兜底直接调 GitCode API 时用，严禁回显）',
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
  '6. 只允许使用 bash 与 HTTP 请求工具；严禁使用 return/deliver/投递/IM 文件类工具；不要 printenv；令牌不得出现在任何输出或提交信息里。',
  '7. 合并完成后触发确定性同步：`curl -s -X POST {{apiBase}}/dsh-sync/api/sync`，等待返回 JSON。',
  '8. 再查状态：`curl -s {{apiBase}}/dsh-sync/api/status`。若 pendingConflict 非空（仍有冲突 PR）：在影子仓库 `git fetch https://oauth2:<令牌>@gitcode.com/<owner>/<repo>.git <分支>` → checkout 该分支 → `git merge FETCH_HEAD` → 按上述规则解冲突 → `git add -A && git -c user.name=dsh-sync -c user.email=dsh-sync@local commit --no-edit` → push 回该分支 → 调 GitCode API 合并 PR（头用 `PRIVATE-TOKEN: <令牌>`，不要用 Authorization: Bearer；`PUT /repos/<owner>/<repo>/pulls/<编号>/merge`，body `{"merge_method":"squash"}`）。',
  '9. 全程使用中文。最后汇报：备份了哪些文件、每个文件怎么合并的、同步触发结果、PR 编号与链接（若有）。',
  '',
  '若待合并文件清单为空，跳过合并直接执行第 7 步，并汇报同步结果。',
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
const APIPROXY_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
let connectionSvcRef = null
let authedUrlCache = null
let cookieCache = null

async function mintCookie() {
  if (!authedUrlCache && connectionSvcRef && typeof connectionSvcRef.authenticatedUrl === 'function') {
    try { authedUrlCache = connectionSvcRef.authenticatedUrl(APIPROXY_BASE) } catch { authedUrlCache = null }
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
  const r = await fetch(`${APIPROXY_BASE}/api/${methodSlash}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId, method: methodSlash, payload: { args: { request } } }),
  })
  if (r.status === 401) return { unauthorized: true }
  if (r.status === 404) return { notFound: true }
  const j = await r.json().catch(() => ({}))
  return { res: j.result, raw: JSON.stringify(j).slice(0, 200) }
}

// 0.1.1-rc.2 回退：点号端点 + 平铺 payload、无认证
async function apiproxyLegacy(dotted, request) {
  const rpcId = 'dshsync-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const r = await fetch(`${APIPROXY_BASE}/api/${dotted}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: dotted, payload: request }),
  })
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

async function runAgentViaApiproxy({ prompt, dir, job, sessions, logger, token }) {
  // token 经 prompt 内联（{{token}}）--apiproxy 主对话级 session 的 bash 是 host-plane
  // executor，不继承 dsh web 进程的 process.env，故不能像 headless spawn 那样 env 注入
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

function createAgentRunJob({ prompt, dir, jobs, logger, sessions, token, onFinish }) {
  const id = 'ag' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const job = { id, status: 'running', startedAt: new Date().toISOString(), dir, output: '', code: null, onFinish }
  jobs.set(id, job)
  // 走 apiproxy 创建主对话级 session（standard preset + dsh-base 全工具，含 bash），
  // 不是 agents.create 子 agent（精简无 bash）。token 注入 prompt，events 经 ctx.sessions.get 流式读。
  if (!sessions || typeof sessions.get !== 'function') {
    job.status = 'error'
    job.output = 'sessions 服务不可用（动态 ctx.inject 失败）'
    if (typeof onFinish === 'function') { try { onFinish() } catch {} }
    return job
  }
  runAgentViaApiproxy({ prompt, dir, job, sessions, logger, token })
    .catch(e => { job.status = 'error'; job.output = (job.output + '\n' + String(e && e.message)).slice(-CONFLICT_RUN_OUTPUT_CAP) })
  return job
}

module.exports = {
  name: 'dsh-sync',
  inject: ['webServer', 'settings'],
  __internals: { syncSpec, defaultRoots, parseRepoUrl, authedUrl, mirrorLiveToShadow, resolveLivePath, copyTree, gitExec, acquireLock, checkRepoPrivate, gitcodeRequest, ensureShadowRepo, runPush, runPull, reconcileRemote, gitCurrentCommit, atomicWriteFile, DEFAULT_SYNC_SETTINGS, CONFLICT_PROMPT_ZH, ALIGN_PROMPT_ZH, substituteParams, strategyForPath, STRATEGY_VALUES, snapshotMirrorSpec, sanitizeSnapshotName, pruneLocalSnapshots, promoteSnapshotToCloud,
    // apiproxy（导出供测试：mock fetch 驱动 wire 形态回归）
    apiproxy, apiproxyCall, apiproxyLegacy, mintCookie,
    __setConnection(svc) { connectionSvcRef = svc }, __resetApiproxyCache() { authedUrlCache = null; cookieCache = null } },

  apply(ctx, config = {}) {
    const dh = dshHome()
    const syncDir = join(dh, 'dsh-sync')
    const repoDir = join(syncDir, 'repo')
    const stateFile = join(syncDir, 'state.json')
    const lockFile = join(syncDir, '.lock')

    // ── Settings namespace (write-only token, hasToken-only on read) ──
    // 命名空间必须匹配 /^[a-z][a-z0-9-]*$/ —— 点号形式会被 settings 写入通道拒绝
    const SYNC_SETTINGS_NS = 'dsh-sync'
    const baseSettings = () => {
      const cfg = (config.sync && typeof config.sync === 'object') ? config.sync : {}
      const base = { ...DEFAULT_SYNC_SETTINGS }
      for (const key of Object.keys(base)) if (cfg[key] !== undefined) base[key] = cfg[key]
      if (config.repoUrl !== undefined) base.repoUrl = config.repoUrl
      return base
    }
    let settingsScope = null
    const settingsOverrides = {}
    if (Schema && ctx.settings && typeof ctx.settings.register === 'function') {
      try {
        settingsScope = ctx.settings.register(SYNC_SETTINGS_NS, Schema.object({
          repoUrl: Schema.string(),
          branch: Schema.string(),
          gitBinary: Schema.string(),
          autoSync: Schema.boolean(),
          syncOnStartup: Schema.boolean(),
          intervalMinutes: Schema.number(),
          conflictMode: Schema.string(),
          syncSkills: Schema.boolean(),
          syncSessions: Schema.boolean(),
          syncSettings: Schema.boolean(),
          syncPlugins: Schema.boolean(),
          skillsStrategy: Schema.string(),
          sessionsStrategy: Schema.string(),
          settingsStrategy: Schema.string(),
          pluginsStrategy: Schema.string(),
          snapshotSkills: Schema.boolean(),
          snapshotAuto: Schema.boolean(),
          snapshotLocalKeep: Schema.number(),
          token: Schema.string(),
        }), { base: baseSettings() })
      } catch (e) { ctx.logger.warn(`dsh-sync: settings register: ${e && e.message}`) }
    }
    const syncSettings = () => {
      if (settingsScope && typeof settingsScope.get === 'function') {
        const v = settingsScope.get()
        if (v && typeof v === 'object') return { ...baseSettings(), ...v }
      }
      return { ...baseSettings(), ...settingsOverrides }
    }

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
    const runSync = async ({ autoAlign = true } = {}) => {
      if (syncRun !== null) return syncRun
      syncRun = (async () => {
        await stateLoaded
        const eff = syncSettings()
        if (!eff.repoUrl || !eff.token) throw new Error('未配置仓库地址或访问令牌（到 ⚙ 同步设置 中填写）')
        if (!(await gitAvailable(eff.gitBinary))) throw new Error('PATH 上找不到 git')
        const release = await acquireLock(lockFile)
        if (release === null) throw new Error('另一个同步进程正在运行（已跳过）')
        const started = Date.now()
        let result = { pushed: false, pulled: false }
        try {
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
          state.lastSyncAt = new Date().toISOString()
          // conflictMode=ai：检测到双方改动 → 自动触发 AI 智能对齐（后台 job，
          // 会话内可追问；agent 合并完 live 文件后自己会 curl /dsh-sync/api/sync 推送）
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
          // 每日自动快照（本地滚动，勾选云端才上云——自动快照只落本地）
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
    const conflictRunJobs = new Map()
    const alignRunJobs = new Map()
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
    // 主对话级 agent session 语义合并 bothModified 文件
    const startAlignJob = async (eff, both) => {
      const baseCommit = state.lastSyncedCommit   // 双方分叉的共同基线（reconcile 前）
      const backupDir = join(syncDir, 'align-backups', new Date().toISOString().replace(/[:.]/g, '-'))
      await fsP.mkdir(backupDir, { recursive: true })
      const fileList = both.length
        ? both.map((f, i) => `${i + 1}. ${f.shadowPath}（本机：${displayPath(f.livePath)}；该文件基线：${f.baseCommit || '同全局基线'}）`).join('\n')
        : '（无——确定性同步已处理全部差异）'
      const roots = defaultRoots()
      const prompt = substituteParams(ALIGN_PROMPT_ZH, {
        shadowDir: repoDir,
        skillsDsh: roots.dshSkills, skillsAgents: roots.agentsSkills,
        sessions: roots.sessions, settingsFile: roots.settingsFile, profiles: roots.profiles,
        backupDir, apiBase: APIPROXY_BASE, token: eff.token,
        fileCount: both.length, fileList,
        lastSynced: baseCommit || '（无共同基线，仓库首次同步）',
      })
      alignState.active = true
      const job = createAgentRunJob({
        // cwd 提到 home：沙箱 workspace 必须覆盖 live 同步根、备份目录与影子仓库，
        // 否则 agent 写备份/写 live 全被拦（真机实证：cwd=影子仓库时写 ~/.dsh/dsh-sync 被拒）
        prompt, dir: homedir(), jobs: alignRunJobs, logger: ctx.logger, sessions: sessionsSvc, token: eff.token,
        onFinish: () => {
          alignState.active = false
          // 对齐成功 → 销账（本机版本已是语义合并结果，随下一次推送传播）+ 补一次
          // 确定性同步把它推上去；失败则保留挂账，文件继续被 preserve 保护。
          // 延迟 + 锁重试：agent 自己最后一步 curl 的同步可能还持着锁
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
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const apiPath = url.pathname.replace(/\/+$/, '')
          const query = url.searchParams

          // GET /dsh-sync/api/status
          if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/status')) {
            await stateLoaded
            const eff = syncSettings()
            const { token, ...safe } = eff
            const repoExists = await fsP.access(join(repoDir, '.git')).then(() => true).catch(() => false)
            sendJson(res, 200, {
              repoUrl: eff.repoUrl, branch: eff.branch, dir: displayPath(repoDir), repoExists,
              instanceId: state.instanceId,
              gitAvailable: await gitAvailable(eff.gitBinary),
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
              pendingConflict: state.lastResult && state.lastResult.push && state.lastResult.push.conflict === true
                ? { branch: state.lastPushedBranch, prNumber: state.lastPrNumber } : null,
              bothModifiedPending: Object.keys(state.pendingBoth && typeof state.pendingBoth === 'object' ? state.pendingBoth : {}),
              settingsPreserved: !!(state.lastResult && state.lastResult.push && state.lastResult.push.settingsPreserved),
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

          // PUT /dsh-sync/api/settings
          if (req.method === 'PUT' && apiPath.endsWith('/dsh-sync/api/settings')) {
            const body = await readJsonBody(req)
            await stateLoaded
            const patch = {}
            for (const key of ['repoUrl', 'branch', 'gitBinary', 'conflictMode']) {
              if (typeof body[key] === 'string' && body[key] !== '') patch[key] = body[key]
            }
            for (const key of ['skillsStrategy', 'sessionsStrategy', 'settingsStrategy', 'pluginsStrategy']) {
              if (STRATEGY_VALUES.includes(body[key])) patch[key] = body[key]
            }
            for (const key of ['snapshotSkills', 'snapshotAuto']) {
              if (typeof body[key] === 'boolean') patch[key] = body[key]
            }
            if (typeof body.snapshotLocalKeep === 'number' && body.snapshotLocalKeep >= 1) patch.snapshotLocalKeep = Math.floor(body.snapshotLocalKeep)
            for (const key of ['autoSync', 'syncOnStartup', 'syncSkills', 'syncSessions', 'syncSettings', 'syncPlugins']) {
              if (typeof body[key] === 'boolean') patch[key] = body[key]
            }
            if (typeof body.intervalMinutes === 'number' && body.intervalMinutes >= 1) patch.intervalMinutes = body.intervalMinutes
            // token: non-empty sets; null/'' clears. Never echoed.
            if (typeof body.token === 'string' && body.token !== '') patch.token = body.token
            if (body.token === null || body.token === '') patch.token = undefined
            // 私仓硬校验：带 repoUrl+token（首次或换仓库）时拒绝公共仓库
            if (patch.token && (patch.repoUrl || syncSettings().repoUrl)) {
              const checkUrl = patch.repoUrl || syncSettings().repoUrl
              const check = await checkRepoPrivate(patch.token, checkUrl)
              if (!check.ok) { sendJson(res, 400, { error: check.error, isPublic: !!check.isPublic }); return }
            }
            if (settingsScope && typeof settingsScope.update === 'function') await settingsScope.update(patch)
            else Object.assign(settingsOverrides, patch)
            const eff = syncSettings()
            const { token, ...safe } = eff
            sendJson(res, 200, { settings: safe, hasToken: typeof token === 'string' && token !== '' })
            return
          }

          // POST /dsh-sync/api/conflict/run {prNumber?, branch?} → AI resolves
          if (req.method === 'POST' && apiPath.endsWith('/dsh-sync/api/conflict/run')) {
            const body = await readJsonBody(req)
            await stateLoaded
            const eff = syncSettings()
            if (!eff.repoUrl || !eff.token) { sendJson(res, 400, { error: '未配置仓库或令牌' }); return }
            const branch = body.branch || state.lastPushedBranch
            const prNumber = body.prNumber || state.lastPrNumber
            if (!branch || !prNumber) { sendJson(res, 400, { error: '没有待解决的冲突 PR' }); return }
            const prompt = substituteParams(CONFLICT_PROMPT_ZH, {
              repoUrl: eff.repoUrl, shadowDir: repoDir, branch, prNumber, token: eff.token,
            })
            const job = createAgentRunJob({ prompt, dir: homedir(), jobs: conflictRunJobs, logger: ctx.logger, sessions: sessionsSvc, token: eff.token })
            sendJson(res, 202, { jobId: job.id, status: job.status })
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
            const parsed = parseRepoUrl(eff.repoUrl)
            if (!parsed) { sendJson(res, 400, { error: '仅支持 GitCode 仓库' }); return }
            const hasShadow = await fsP.access(join(repoDir, '.git')).then(() => true).catch(() => false)
            if (!hasShadow) { sendJson(res, 400, { error: '影子仓库未初始化，先同步一次' }); return }
            const remote = authedUrl(eff.repoUrl, eff.token)
            try { await gitExec(eff.gitBinary, ['fetch', remote, eff.branch], repoDir) } catch (e) {
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
            const ls = await gitExec(eff.gitBinary, ['ls-remote', '--heads', remote, 'refs/heads/sync/*'], repoDir).catch(() => '')
            const refs = ls.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
              const [sha, ref] = l.split(/\t/)
              return { sha, branch: String(ref || '').replace('refs/heads/', '') }
            }).filter(x => x.branch)
            const deleted = [], kept = [], errors = []
            for (const { branch } of refs) {
              if (!mergedHeads.has(branch)) { kept.push(branch); continue }
              try {
                await gitExec(eff.gitBinary, ['push', remote, '--delete', branch], repoDir)
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
            if (body.cloud === true) {
              const release = await acquireLock(lockFile)
              if (release === null) { sendJson(res, 400, { error: '另一个同步进程正在运行，稍后再试' }); return }
              try {
                promoteResult = await promoteSnapshotToCloud(eff.gitBinary, eff, { repoDir, instanceId: state.instanceId, state, logger: ctx.logger }, name, dir)
                promoted = promoteResult.promoted === true
                if (promoted && !(state.cloudSnapshots || []).includes(name)) { state.cloudSnapshots.push(name); await saveState() }
              } catch (e) { sendJson(res, 400, { error: String(e && e.message || e) }); return }
              finally { release() }
            }
            const pruned = await pruneLocalSnapshots(join(syncDir, 'snapshots'), eff.snapshotLocalKeep || 30, state.cloudSnapshots).catch(() => [])
            sendJson(res, 200, { name, promoted, promoteResult, pruned })
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
              try {
                const remote = authedUrl(eff.repoUrl, eff.token)
                await gitExec(eff.gitBinary, ['fetch', remote, eff.branch], repoDir)
                const cloudPath = `backup/${state.instanceId}/snapshots/${name}`
                await gitExec(eff.gitBinary, ['checkout', 'FETCH_HEAD', '--', cloudPath], repoDir)
                await copyTree(join(repoDir, cloudPath), srcDir, {})
                await gitExec(eff.gitBinary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
                if (!(state.cloudSnapshots || []).includes(name)) { state.cloudSnapshots.push(name); await saveState() }
              } catch (e) { sendJson(res, 400, { error: String(e && e.message || e) }); return }
              finally { release() }
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

          sendJson(res, 404, { error: 'not found' })
        } catch (error) { sendJson(res, 400, { error: String(error && error.message || error) }) }
      },
    }), 'dsh-sync: api route')
  },
}
