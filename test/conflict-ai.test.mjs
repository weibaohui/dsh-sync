/**
 * dsh-sync AI-run credential-surface tests (issue #9).
 *
 * The AI agent runs (conflict / align / remote-align) must never carry the
 * GitCode token: prompt templates hold no credential placeholders, and all
 * credential-touching git/REST steps live in host-side prepareConflictTree /
 * finalizeConflictBranch (exercised here against a real local bare repo that
 * parses as a gitcode.com URL, with GitCode REST mocked on globalThis.fetch).
 * The conflictMode gate must cover every AI-run endpoint, not just the
 * auto-trigger path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { PassThrough } from 'node:stream'

const require = createRequire(import.meta.url)
const I = require('../src/index.js').__internals

const sh = (args, cwd) => new Promise((res, rej) => {
  execFile('git', args, { cwd }, (e, o, er) => e ? rej(new Error(`${args.join(' ')}: ${String(er || e.message).slice(-200)}`)) : res(String(o)))
})
const gitNoUser = (args, cwd) => sh(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd)
const mkdtemp = async () => fsp.mkdtemp(join(tmpdir(), 'dshsync-ai-'))
// eff.repoUrl 要过 parseRepoUrl（只认 gitcode.com/<owner>/<repo>）：Windows 上裸仓库真实路径
// 是反斜杠形式，先转成 / 形式再交给它，git 一样能推。
const asRepoUrl = (p) => p.split(sep).join('/')

// ── Prompt credential regression: the token must have no path into the prompt ──

test('AI prompt templates carry no credential material', () => {
  for (const [name, tpl] of [['CONFLICT', I.CONFLICT_PROMPT_ZH], ['ALIGN', I.ALIGN_PROMPT_ZH], ['REMOTE_ALIGN', I.REMOTE_ALIGN_PROMPT_ZH]]) {
    assert.ok(!tpl.includes('{{token}}'), `${name} template must not have a {{token}} placeholder`)
    assert.ok(!tpl.includes('oauth2:'), `${name} template must not embed tokens in URLs`)
    assert.ok(!tpl.includes('PRIVATE-TOKEN'), `${name} template must not instruct authenticated API calls`)
    assert.ok(!tpl.includes('api.gitcode.com'), `${name} template must not point the agent at GitCode REST`)
  }
  // even if a caller re-adds a token param, no placeholder means no substitution
  const filled = I.substituteParams(I.CONFLICT_PROMPT_ZH, { token: 'supersecret' })
  assert.ok(!filled.includes('supersecret'), 'substitution must have nothing to substitute into')
  // the agent must not self-trigger sync (post-run sync is host-driven now)
  assert.ok(!I.ALIGN_PROMPT_ZH.includes('/dsh-sync/api/sync'), 'ALIGN agent must not call the sync API itself')
  assert.ok(!I.REMOTE_ALIGN_PROMPT_ZH.includes('/dsh-sync/api/sync'), 'REMOTE_ALIGN agent must not call the sync API itself')
})

// ── prepareConflictTree: real git, conflict left in the working tree ──

test('prepareConflictTree checks out the branch tip and merges main into it', async () => {
  const tmp = await mkdtemp()
  // bare remote under a path that parses as a gitcode.com repo (owner=o repo=r)
  const bareRepo = join(tmp, 'gitcode.com', 'o', 'r.git')
  await fsp.mkdir(join(tmp, 'gitcode.com', 'o'), { recursive: true })
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  // seed main with a file
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await sh(['init', '-b', 'main'], seed)
  await fsp.writeFile(join(seed, 'foo.md'), 'base\n')
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  // shadow clone: create the sync branch with a divergent change, push it
  const repoDir = join(tmp, 'repo')
  await sh(['clone', bareRepo, repoDir])
  await gitNoUser(['checkout', '-b', 'sync/x/1'], repoDir)
  await fsp.writeFile(join(repoDir, 'foo.md'), 'local change\n')
  await gitNoUser(['add', '-A'], repoDir)
  await gitNoUser(['commit', '-m', 'local'], repoDir)
  await sh(['push', 'origin', 'sync/x/1'], repoDir)
  // another machine advances main, touching the same file
  const other = join(tmp, 'other')
  await sh(['clone', bareRepo, other])
  await fsp.writeFile(join(other, 'foo.md'), 'remote change\n')
  await gitNoUser(['add', '-A'], other)
  await gitNoUser(['commit', '-m', 'remote'], other)
  await sh(['push', 'origin', 'main'], other)

  const eff = { repoUrl: asRepoUrl(bareRepo), branch: 'main', gitBinary: 'git', token: '' }
  try {
    const prep = await I.prepareConflictTree('git', eff, { repoDir, branch: 'sync/x/1' })
    assert.equal(prep.autoMerged, false)
    assert.deepEqual(prep.conflicts, ['foo.md'])
    const content = await fsp.readFile(join(repoDir, 'foo.md'), 'utf8')
    assert.ok(content.includes('<<<<<<<'), 'working tree must hold conflict markers')
    // HEAD is on the sync branch at its remote tip + a merge in progress
    assert.equal((await sh(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).trim(), 'sync/x/1')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── finalizeConflictBranch: push → poll mergeable → squash merge → cleanup ──

test('finalizeConflictBranch: resolved branch pushes, PR merges, shadow advances', async () => {
  const tmp = await mkdtemp()
  const bareRepo = join(tmp, 'gitcode.com', 'o', 'r.git')
  await fsp.mkdir(join(tmp, 'gitcode.com', 'o'), { recursive: true })
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await sh(['init', '-b', 'main'], seed)
  await fsp.writeFile(join(seed, 'foo.md'), 'base\n')
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  const repoDir = join(tmp, 'repo')
  await sh(['clone', bareRepo, repoDir])
  await gitNoUser(['checkout', '-b', 'sync/x/1'], repoDir)
  await fsp.writeFile(join(repoDir, 'foo.md'), 'local change\n')
  await gitNoUser(['add', '-A'], repoDir)
  await gitNoUser(['commit', '-m', 'local'], repoDir)
  await sh(['push', 'origin', 'sync/x/1'], repoDir)
  // diverge main so prepare leaves a conflict
  const other = join(tmp, 'other')
  await sh(['clone', bareRepo, other])
  await fsp.writeFile(join(other, 'foo.md'), 'remote change\n')
  await gitNoUser(['add', '-A'], other)
  await gitNoUser(['commit', '-m', 'remote'], other)
  await sh(['push', 'origin', 'main'], other)
  const eff = { repoUrl: asRepoUrl(bareRepo), branch: 'main', gitBinary: 'git', token: 'tok' }
  const state = {}
  // mock GitCode REST: PR #7 mergeable → squash merge ok
  const calls = []
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = (init.method || 'GET').toUpperCase()
    calls.push(method + ' ' + u)
    if (/\/pulls\/7$/.test(u) && method === 'GET') return mk({ number: 7, mergeable: true })
    if (/\/pulls\/7\/merge$/.test(u) && method === 'PUT') return mk({}, 200)
    return mk({ message: 'unmocked ' + u }, 404)
  }
  try {
    await I.prepareConflictTree('git', eff, { repoDir, branch: 'sync/x/1' })
    // simulate the agent: resolve the conflict and commit
    await fsp.writeFile(join(repoDir, 'foo.md'), 'merged change\n')
    await gitNoUser(['add', '-A'], repoDir)
    await gitNoUser(['commit', '--no-edit'], repoDir)

    const r = await I.finalizeConflictBranch('git', eff, { repoDir, branch: 'sync/x/1', prNumber: 7, state, pollGapMs: 10 })
    assert.equal(r.merged, true)
    assert.deepEqual(calls.filter(c => c.startsWith('PUT')), ['PUT https://api.gitcode.com/api/v5/repos/o/r/pulls/7/merge'])
    // remote sync branch deleted after merge
    const ls = await sh(['ls-remote', bareRepo], tmp)
    assert.ok(!ls.includes('sync/x/1'), 'merged sync branch must be deleted from the remote')
    assert.ok(ls.includes('refs/heads/main'), 'main still present')
    // shadow advanced onto main; baseline recorded matches remote main
    assert.equal((await sh(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).trim(), 'main')
    assert.ok(state.lastSyncedCommit, 'lastSyncedCommit recorded')
    assert.equal(state.lastSyncedCommit, (await sh(['rev-parse', 'HEAD'], repoDir)).trim())
    assert.equal(state.lastSyncedCommit, (await sh(['--git-dir', bareRepo, 'rev-parse', 'main'], tmp)).trim())
  } finally {
    globalThis.fetch = origFetch
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

test('finalizeConflictBranch: unresolved conflict refuses to push', async () => {
  const tmp = await mkdtemp()
  const bareRepo = join(tmp, 'gitcode.com', 'o', 'r.git')
  await fsp.mkdir(join(tmp, 'gitcode.com', 'o'), { recursive: true })
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await sh(['init', '-b', 'main'], seed)
  await fsp.writeFile(join(seed, 'foo.md'), 'base\n')
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  const repoDir = join(tmp, 'repo')
  await sh(['clone', bareRepo, repoDir])
  await gitNoUser(['checkout', '-b', 'sync/x/1'], repoDir)
  await fsp.writeFile(join(repoDir, 'foo.md'), 'local change\n')
  await gitNoUser(['add', '-A'], repoDir)
  await gitNoUser(['commit', '-m', 'local'], repoDir)
  await sh(['push', 'origin', 'sync/x/1'], repoDir)
  const other = join(tmp, 'other')
  await sh(['clone', bareRepo, other])
  await fsp.writeFile(join(other, 'foo.md'), 'remote change\n')
  await gitNoUser(['add', '-A'], other)
  await gitNoUser(['commit', '-m', 'remote'], other)
  await sh(['push', 'origin', 'main'], other)

  const eff = { repoUrl: asRepoUrl(bareRepo), branch: 'main', gitBinary: 'git', token: 'tok' }
  const state = {}
  let restCalls = 0
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    restCalls++
    return mk({ message: 'must not be called' }, 500)
  }
  try {
    await I.prepareConflictTree('git', eff, { repoDir, branch: 'sync/x/1' })
    // agent did NOT resolve: conflicts still in the tree
    const r = await I.finalizeConflictBranch('git', eff, { repoDir, branch: 'sync/x/1', prNumber: 7, state })
    assert.equal(r.merged, false)
    assert.match(r.reason, /未解决/)
    assert.equal(restCalls, 0, 'no REST call may happen while conflicts remain')
    const ls = await sh(['ls-remote', bareRepo], tmp)
    assert.ok(ls.includes('sync/x/1'), 'branch must stay untouched')
    assert.equal(state.lastSyncedCommit, undefined, 'baseline must not advance')
  } finally {
    globalThis.fetch = origFetch
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

test('finalizeConflictBranch: PR still conflicted → no merge, branch kept', async () => {
  const tmp = await mkdtemp()
  const bareRepo = join(tmp, 'gitcode.com', 'o', 'r.git')
  await fsp.mkdir(join(tmp, 'gitcode.com', 'o'), { recursive: true })
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await sh(['init', '-b', 'main'], seed)
  await fsp.writeFile(join(seed, 'foo.md'), 'base\n')
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  const repoDir = join(tmp, 'repo')
  await sh(['clone', bareRepo, repoDir])
  await gitNoUser(['checkout', '-b', 'sync/x/1'], repoDir)
  await fsp.writeFile(join(repoDir, 'other.md'), 'local only, no conflict with main\n')
  await gitNoUser(['add', '-A'], repoDir)
  await gitNoUser(['commit', '-m', 'local'], repoDir)
  await sh(['push', 'origin', 'sync/x/1'], repoDir)

  const eff = { repoUrl: asRepoUrl(bareRepo), branch: 'main', gitBinary: 'git', token: 'tok' }
  const state = {}
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = (init.method || 'GET').toUpperCase()
    if (/\/pulls\/7$/.test(u) && method === 'GET') return mk({ number: 7, mergeable: false })
    return mk({ message: 'unmocked ' + u }, 404)
  }
  try {
    // mergeable=false 需连续轮询到最后一拍仍是 false 才判失败（推送后 GitCode 异步重算）
    const r = await I.finalizeConflictBranch('git', eff, { repoDir, branch: 'sync/x/1', prNumber: 7, state, pollTries: 2, pollGapMs: 10 })
    assert.equal(r.merged, false)
    assert.match(r.reason, /mergeable=false/)
    assert.equal(state.lastSyncedCommit, undefined)
  } finally {
    globalThis.fetch = origFetch
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── conflictMode gate: every AI-run endpoint, not just the auto-trigger ──

function makeHarness({ config = {} } = {}) {
  const plugin = require('../src/index.js')
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: { register: () => ({ get: () => ({}), update: async () => {}, watch: () => {} }) },
    connection: { requestRejection: () => undefined },
    effect: (factory) => factory(),
    on: () => () => {},
    get: () => undefined,
    sessions: {},
    webServer: { register: (route) => routes.push(route) },
  }
  plugin.apply(ctx, config)
  return routes
}
const post = (route, url, body) => new Promise((resolve) => {
  const req = new PassThrough()
  req.method = 'POST'
  req.url = url
  req.headers = {}
  const res = { statusCode: null, body: null }
  res.writeHead = (status, headers) => { res.statusCode = status }
  res.end = (payload) => {
    res.body = payload
    resolve(res)
  }
  route.handler(req, res)
  if (body !== undefined) req.end(JSON.stringify(body))
  else req.end()
})

test('conflictMode=manual refuses every AI-run endpoint with 403', async () => {
  const dh = await mkdtemp()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dh
  try {
    const routes = makeHarness({ config: { sync: { conflictMode: 'manual', repoUrl: 'https://gitcode.com/o/r', token: 'tok' } } })
    const route = routes[0]
    const r1 = await post(route, '/dsh-sync/api/conflict/run', {})
    assert.equal(r1.statusCode, 403)
    assert.match(String(r1.body), /manual/)
    const r2 = await post(route, '/dsh-sync/api/align/run', {})
    assert.equal(r2.statusCode, 403)
    const r3 = await post(route, '/dsh-sync/api/remote/align', { paths: ['settings/settings.yaml'] })
    assert.equal(r3.statusCode, 403)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await fsp.rm(dh, { recursive: true, force: true }).catch(() => {})
  }
})

test('conflictMode=ai passes the gate (fails later on missing PR, not on the gate)', async () => {
  const dh = await mkdtemp()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dh
  try {
    const routes = makeHarness({ config: { sync: { conflictMode: 'ai', repoUrl: 'https://gitcode.com/o/r', token: 'tok' } } })
    const route = routes[0]
    const r = await post(route, '/dsh-sync/api/conflict/run', {})
    assert.equal(r.statusCode, 400, 'gate must not fire in ai mode')
    assert.match(String(r.body), /没有待解决的冲突 PR/)
    assert.notEqual(r.statusCode, 403)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await fsp.rm(dh, { recursive: true, force: true }).catch(() => {})
  }
})
