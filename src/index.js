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
 * merge : surface a conflict action. Pull = fetch → for files remote changed
 * since lastSyncedCommit, write the remote version back to live only when the
 * local copy is untouched (three-way; locally-modified files wait for the
 * next push). Conflicts an agent cannot auto-resolve stay open as PRs.
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

function syncSpec(eff, roots = defaultRoots()) {
  const groups = []
  if (eff.syncSkills) groups.push({
    name: 'skills',
    sources: [
      { from: roots.dshSkills, to: 'skills/dsh' },
      // 软链解引用成实文件：跨机不能指望同一个 link target 存在
      { from: roots.agentsSkills, to: 'skills/agents', followSymlinks: true },
      { from: roots.agentsLock, to: 'skills/.skill-lock.json', file: true },
    ],
  })
  if (eff.syncSessions) groups.push({
    name: 'sessions',
    sources: [{ from: roots.sessions, to: 'sessions', excludeNames: new Set(['session_projcache.json']) }],
  })
  if (eff.syncSettings) groups.push({
    name: 'settings',
    // 整文件同步、不脱敏——前提是私仓校验通过
    sources: [{ from: roots.settingsFile, to: 'settings/settings.yaml', file: true }],
  })
  if (eff.syncPlugins) groups.push({
    name: 'plugins',
    sources: [{
      from: roots.profiles, to: 'plugins',
      // 只存声明：package.json / patch / 锁文件。node_modules 按机重装，
      // .dsh-market 是市场缓存，cordis.yml 是 loader 产物（可重建）
      includeFiles: new Set(['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']),
      excludeDirs: new Set(['node_modules', '.dsh-market']),
      excludeNames: new Set(['cordis.yml']),
    }],
  })
  return groups
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

async function runPush(binary, eff, { repoDir, instanceId, state, logger, roots }) {
  const remote = await ensureShadowRepo(binary, eff, repoDir)
  const spec = syncSpec(eff, roots)

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
  await mirrorLiveToShadow(spec, repoDir)

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
    return { pushed: true, prSkipped: true, branch }
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
    // advance shadow to the merged main
    await gitExec(binary, ['fetch', remote, eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['checkout', eff.branch], repoDir).catch(() => {})
    await gitExec(binary, ['reset', '--hard', 'FETCH_HEAD'], repoDir).catch(() => {})
    state.lastSyncedCommit = await gitCurrentCommit(binary, repoDir)
    return { pushed: true, merged: true, prNumber }
  }
  // conflict → leave PR open; client shows the "AI 解决冲突" action button
  return { pushed: true, prConflict: true, prNumber, conflict: true }
}

// ── Three-way pull: remote deltas → live, only for untouched files ──

async function runPull(binary, eff, { repoDir, state, logger, roots }) {
  const remote = authedUrl(eff.repoUrl, eff.token)
  const spec = syncSpec(eff, roots)
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
  for (const p of changed) {
    const livePath = resolveLivePath(spec, p)
    if (!livePath) { skipped++; continue }
    let liveBuf = null
    try { liveBuf = await fsP.readFile(livePath) } catch {}
    let lastSyncedBuf = null
    try { lastSyncedBuf = await gitShowBuf(binary, `${lastSynced}:${p}`, repoDir) } catch { lastSyncedBuf = Buffer.alloc(0) }
    const untouched = liveBuf === null ? (lastSyncedBuf.length === 0) : Buffer.compare(liveBuf, lastSyncedBuf) === 0
    if (!untouched) { skipped++; continue }   // 本地动过 → 留给下个 push
    try {
      const remoteBuf = await gitShowBuf(binary, `FETCH_HEAD:${p}`, repoDir)
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
  '- 访问令牌：已注入环境变量 $DSH_SYNC_TOKEN（用 `printenv DSH_SYNC_TOKEN` 读取）。',
  '',
  '## 工具限制（硬性）',
  '- 只允许使用 bash（git/curl 命令）和 HTTP 请求工具。',
  '- **严禁**使用任何 return / deliver / 投递 / IM 文件类工具（如 dsh_im_return_file）。不要把任何文件“投递”或“返回”出去。',
  '- **不要读取 ~/.dsh/settings.yaml**——token 已在 $DSH_SYNC_TOKEN 里，别碰配置文件。',
  '- token 是敏感凭据，任何输出、日志、结果里都不要回显其明文。',
  '',
  '## 执行步骤',
  '1. 取 token：`printenv DSH_SYNC_TOKEN`（不要读 settings.yaml）。',
  '2. 在影子仓库内：`cd {{shadowDir}} && git fetch https://oauth2:$(printenv DSH_SYNC_TOKEN)@gitcode.com/<owner>/<repo>.git main`（token 嵌 URL、不落 .git/config），然后 `git checkout {{branch}}`，再 `git merge FETCH_HEAD` 触发冲突。',
  '3. 查看冲突文件：`git diff --name-only --diff-filter=U` 和 `git status`。对每个冲突文件分析两边版本决定取舍或合并（保留两边有效改动；README 等无语义文件取任一即可）。',
  '4. 解决后：`git add -A && git -c user.name=dsh-sync -c user.email=dsh-sync@local commit --no-edit`，再 `git push https://oauth2:$(printenv DSH_SYNC_TOKEN)@gitcode.com/<owner>/<repo>.git HEAD:{{branch}}`。',
  '5. 查 PR 可合并：`curl -s -H "PRIVATE-TOKEN: $(printenv DSH_SYNC_TOKEN)" https://api.gitcode.com/api/v5/repos/<owner>/<repo>/pulls/{{prNumber}}`，确认 mergeable 为 true。',
  '6. 合并：`curl -s -X PUT -H "PRIVATE-TOKEN: $(printenv DSH_SYNC_TOKEN)" -H "Content-Type: application/json" -d \'{"merge_method":"squash"}\' https://api.gitcode.com/api/v5/repos/<owner>/<repo>/pulls/{{prNumber}}/merge`。',
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

function createConflictRunJob({ binary, prompt, dir, jobs, logger, token }) {
  const id = 'cf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const job = { id, status: 'running', startedAt: new Date().toISOString(), dir, output: '', code: null }
  jobs.set(id, job)
  // standard preset 的 in-process agent 实测只有 thinking + 插件全局工具（如 dsh_im_return_file），
  // 无 bash/git/curl——跑不了冲突解决。headless profile 装 dsh-base（提供 bash-sandbox/tool-bash），
  // agent 有 bash，故 conflict 走 headless spawn。token 经 env 注入（不读 settings.yaml）。
  let child
  try { child = require('node:child_process').spawn(binary, ['--profile', 'headless', prompt], { cwd: dir, env: { ...process.env, DSH_SYNC_TOKEN: token || '' } }) }
  catch (e) { job.status = 'error'; job.output = String(e && e.message); return job }
  const append = (chunk) => { job.output = (job.output + String(chunk)).slice(-CONFLICT_RUN_OUTPUT_CAP) }
  child.stdout && child.stdout.on('data', append)
  child.stderr && child.stderr.on('data', append)
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; job.status = 'error'; job.output += '\n[killed: timeout]' }, CONFLICT_RUN_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  child.on('error', (e) => { clearTimeout(timer); job.status = 'error'; append('\n' + String(e && e.message)) })
  child.on('close', (code) => { clearTimeout(timer); if (job.status === 'running') { job.status = code === 0 ? 'done' : 'error'; job.code = code } })
  return job
}

module.exports = {
  name: 'dsh-sync',
  inject: ['webServer', 'settings'],
  __internals: { syncSpec, defaultRoots, parseRepoUrl, authedUrl, mirrorLiveToShadow, resolveLivePath, copyTree, gitExec, acquireLock, checkRepoPrivate, gitcodeRequest, ensureShadowRepo, runPush, runPull, gitCurrentCommit, atomicWriteFile, DEFAULT_SYNC_SETTINGS, CONFLICT_PROMPT_ZH, substituteParams },

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
    let state = { instanceId: undefined, lastSyncedCommit: undefined, lastSyncAt: undefined, lastResult: undefined }
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

    // ── Sync run: lock → push → pull → save ──
    let syncRun = null
    const runSync = async () => {
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
          result.push = await runPush(eff.gitBinary, eff, ctx2).catch(e => { result.pushError = String(e && e.message); return null })
          result.pull = await runPull(eff.gitBinary, eff, ctx2).catch(e => { result.pullError = String(e && e.message); return null })
          state.lastSyncAt = new Date().toISOString()
          state.lastResult = { ...result, at: state.lastSyncAt, durationMs: Date.now() - started }
          await saveState()
        } finally { release() }
        return result
      })().finally(() => { syncRun = null })
      return syncRun
    }

    // ── Conflict-resolution jobs (action button → headless spawn) ──
    const conflictRunJobs = new Map()

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
              hasToken: typeof token === 'string' && token !== '',
              syncing: syncRun !== null,
              pendingConflict: state.lastResult && state.lastResult.push && state.lastResult.push.conflict === true
                ? { branch: state.lastPushedBranch, prNumber: state.lastPrNumber } : null,
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
              repoUrl: eff.repoUrl, shadowDir: repoDir, branch, prNumber,
            })
            const binary = process.env.DSHSYNC_DSH_BIN || 'dsh'
            const job = createConflictRunJob({ binary, prompt, dir: repoDir, jobs: conflictRunJobs, logger: ctx.logger, token: eff.token })
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

          sendJson(res, 404, { error: 'not found' })
        } catch (error) { sendJson(res, 400, { error: String(error && error.message || error) }) }
      },
    }), 'dsh-sync: api route')
  },
}
