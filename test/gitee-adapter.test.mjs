/**
 * dsh-sync gitee 适配测试（issue #18）。
 *
 * 根因：parseRepoUrl 只认 gitcode.com，Gitee 远端永远走 prSkipped（PR 永不创建，
 * main 停滞、孤儿分支堆积）；gitcodeRequest 硬编码 PRIVATE-TOKEN 头，而 Gitee
 * 实测只认 access_token query 参数。修复（方案 A provider 抽象层）后这里断言：
 *   1. parseRepoUrl 识别 gitee（https / scp / 路径子串回退），GitHub/GitLab/自建仍 null；
 *   2. providerRequest 按 provider 分派 base URL 与凭证位置（gitee: access_token
 *      query，含已有 query 时用 & 续接；gitcode: PRIVATE-TOKEN 原样保留）；
 *   3. createPullRequest 的 prune_source_branch 透传；
 *   4. runPush 对 gitee 远端真实走 分支→PR→合并（本地裸仓库路径伪装 + mock REST）；
 *   5. PR 创建失败 / 合并被拒（Gitee 405 业务拒绝）不再 throw，返回结构化结果并
 *      保住 lastPushedBranch / lastPrNumber（孤儿分支堆积的根因修复）；
 *   6. finalizeConflictBranch 在无 PR 支持的远端不再谎报 merged:true。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'

const require = createRequire(import.meta.url)
const I = require('../src/index.js').__internals

const sh = (args, cwd) => new Promise((res, rej) => {
  execFile('git', args, { cwd }, (e, o, er) => e ? rej(new Error(`${args.join(' ')}: ${String(er || e.message).slice(-200)}`)) : res(String(o)))
})
const gitNoUser = (args, cwd) => sh(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd)
const mkdtemp = async () => fsp.mkdtemp(join(tmpdir(), 'dshsync-gitee-'))
const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })

// ── 1. parseRepoUrl 多平台 ──

test('providerSupportsPr / PROVIDER_API_BASE：只有 gitcode 与 gitee', () => {
  assert.equal(I.providerSupportsPr('gitcode'), true)
  assert.equal(I.providerSupportsPr('gitee'), true)
  assert.equal(I.providerSupportsPr('github'), false)
  assert.equal(I.providerSupportsPr('gitlab'), false)
  assert.equal(I.providerSupportsPr('generic'), false)
  assert.equal(I.providerSupportsPr(undefined), false)
  assert.equal(I.PROVIDER_API_BASE.gitee, 'https://gitee.com/api/v5')
  assert.equal(I.prProviderLabels(), 'GitCode/Gitee')
})

// ── 2. providerRequest 按 provider 分派 ──

test('providerRequest: gitee 走 access_token query（已有 query 用 & 续接），gitcode 保留 PRIVATE-TOKEN', async () => {
  const orig = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init = {}) => { seen.push({ u: String(url), h: init.headers || {}, b: init.body }); return mk({ ok: 1 }) }
  try {
    await I.providerRequest('gitee', 'tok', 'GET', '/repos/o/r/pulls/7')
    await I.providerRequest('gitee', 'tok', 'GET', '/repos/o/r/pulls?state=merged&per_page=100&page=1')
    await I.providerRequest('gitcode', 'tok', 'GET', '/repos/o/r/pulls/7')
    const g1 = seen[0], g2 = seen[1], gc = seen[2]
    assert.equal(g1.u, 'https://gitee.com/api/v5/repos/o/r/pulls/7?access_token=tok', 'gitee 凭证是 query 参数')
    assert.equal(g2.u, 'https://gitee.com/api/v5/repos/o/r/pulls?state=merged&per_page=100&page=1&access_token=tok', '已有 query 时必须用 & 续接')
    assert.equal(g1.h['PRIVATE-TOKEN'], undefined, 'gitee 不发 PRIVATE-TOKEN（实测 401）')
    assert.equal(gc.u, 'https://api.gitcode.com/api/v5/repos/o/r/pulls/7')
    assert.equal(gc.h['PRIVATE-TOKEN'], 'tok', 'gitcode 实测结论不动：PRIVATE-TOKEN 头')
    assert.ok(!gc.u.includes('tok'), 'gitcode 的 token 不进 URL')
    await assert.rejects(() => I.providerRequest('github', 'tok', 'GET', '/x'), /不支持 PR 合并的远端类型/)
  } finally { globalThis.fetch = orig }
})

// ── 3. prune_source_branch 透传 ──

test('createPullRequest: pruneSourceBranch 只在请求时进 payload', async () => {
  const orig = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init = {}) => { bodies.push(JSON.parse(init.body || '{}')); return mk({ number: 1 }, 201) }
  try {
    await I.createPullRequest('gitee', 'tok', 'o', 'r', { head: 'sync/x/1', base: 'main', title: 't', body: 'b' })
    await I.createPullRequest('gitee', 'tok', 'o', 'r', { head: 'sync/x/2', base: 'main', pruneSourceBranch: true })
    assert.equal(bodies[0].prune_source_branch, undefined)
    assert.equal(bodies[1].prune_source_branch, true, 'Gitee 服务端删源分支的开关要能传到')
    assert.equal(bodies[1].head, 'sync/x/2')
    assert.equal(bodies[1].base, 'main')
  } finally { globalThis.fetch = orig }
})

// ── 4. runPush 对 gitee 远端：分支 → PR → 合并（本地裸仓库伪装 + mock REST）──

/** 搭一个「远端是本地裸仓库、但 repoUrl 路径里嵌着 gitee.com/o/r.git」的环境：
 *  git 推送走本地路径，PR REST 全部命中 mock——与 conflict-ai.test.mjs 同款。 */
async function setupGiteeLikeRepo(tmp) {
  const bareRepo = join(tmp, 'gitee.com', 'o', 'r.git')
  await fsp.mkdir(join(tmp, 'gitee.com', 'o'), { recursive: true })
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await fsp.writeFile(join(seed, 'foo.md'), 'base\n')
  await sh(['init', '-b', 'main'], seed)
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  const repoDir = join(tmp, 'repo')
  await sh(['clone', bareRepo, repoDir])
  return { bareRepo, repoDir }
}

function giteeLiveRoots(tmp) {
  return {
    dshSkills: join(tmp, 'live', 'skills'),
    agentsSkills: join(tmp, 'live', 'nope-a'),
    agentsLock: join(tmp, 'live', 'nope-l'),
    homeAgentsSkills: join(tmp, 'live', 'nope-h'),
    sessions: join(tmp, 'live', 'nope-s'),
    settingsFile: join(tmp, 'live', 'settings.yaml'),
    profiles: join(tmp, 'live', 'nope-p'),
  }
}

test('runPush: gitee 远端真实走 分支→PR→合并，REST 走 access_token query', async () => {
  const tmp = await mkdtemp()
  const orig = globalThis.fetch
  try {
    const { bareRepo, repoDir } = await setupGiteeLikeRepo(tmp)
    const live = join(tmp, 'live')
    await fsp.mkdir(join(live, 'skills'), { recursive: true })
    await fsp.writeFile(join(live, 'skills', 'SKILL.md'), '# from gitee test\n')
    const calls = []
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url), method = (init.method || 'GET').toUpperCase()
      calls.push(method + ' ' + u)
      // gitee 的 URL 全部带 ?access_token= 尾巴，路径正则要容忍 query
      if (/\/pulls(\?|$)/.test(u) && method === 'POST') return mk({ number: 6, mergeable: true }, 201)
      if (/\/pulls\/6(\?|$)/.test(u) && method === 'GET') return mk({ number: 6, mergeable: true })
      if (/\/pulls\/6\/merge(\?|$)/.test(u) && method === 'PUT') return mk({}, 200)
      return mk({ message: 'unmocked ' + u }, 404)
    }
    const eff = { repoUrl: join(tmp, 'gitee.com', 'o', 'r.git'), branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, token: 'tok' }
    const state = { instanceId: 'testhost-gitee1' }
    const result = await I.runPush('git', eff, {
      repoDir, instanceId: state.instanceId, state,
      logger: { warn: () => {} }, roots: giteeLiveRoots(tmp),
    })
    // PR 真的创建了、合并了（修复前：prSkipped:true，远端永不出现 PR）
    assert.equal(result.pushed, true)
    assert.equal(result.prSkipped, undefined, 'gitee 不应再走 prSkipped 短路')
    assert.equal(result.merged, true)
    assert.equal(result.prNumber, 6)
    assert.ok(state.lastPrNumber === 6, 'lastPrNumber 落盘')
    // REST 调用全部打在 gitee 的 access_token query 形态上
    const post = calls.find(c => c.startsWith('POST'))
    assert.ok(post && /https:\/\/gitee\.com\/api\/v5\/repos\/o\/r\/pulls\?access_token=tok$/.test(post), post)
    const put = calls.find(c => c.startsWith('PUT'))
    assert.ok(put && /\/pulls\/6\/merge\?access_token=tok$/.test(put), put)
    assert.ok(!calls.some(c => c.includes('PRIVATE')), 'token 不走头')
    // 合并后远端 sync 分支清理（best-effort push --delete 对本地裸仓库真实生效）
    const ls = await sh(['ls-remote', bareRepo], tmp)
    assert.ok(!ls.includes('sync/testhost-gitee1/'), 'merged sync branch must be deleted')
  } finally {
    globalThis.fetch = orig
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 5. PR 失败不再 throw（孤儿分支堆积根因）──

test('runPush: 合并被拒（Gitee 405 业务拒绝）不 throw，结构化返回并保住 PR 号', async () => {
  const tmp = await mkdtemp()
  const orig = globalThis.fetch
  try {
    const { repoDir } = await setupGiteeLikeRepo(tmp)
    await fsp.mkdir(join(tmp, 'live', 'skills'), { recursive: true })
    await fsp.writeFile(join(tmp, 'live', 'skills', 'SKILL.md'), '# x\n')
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url), method = (init.method || 'GET').toUpperCase()
      if (/\/pulls(\?|$)/.test(u) && method === 'POST') return mk({ number: 8 }, 201)
      if (/\/pulls\/8(\?|$)/.test(u) && method === 'GET') return mk({ number: 8, mergeable: true })
      // Gitee 对「未通过仓库审查」的 PR 用 HTTP 405 表达业务拒绝，message 在 body
      if (/\/pulls\/8\/merge(\?|$)/.test(u) && method === 'PUT') return mk({ message: '此 Pull Request 未通过设置的审查' }, 405)
      return mk({ message: 'unmocked ' + u }, 404)
    }
    const eff = { repoUrl: join(tmp, 'gitee.com', 'o', 'r.git'), branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, token: 'tok' }
    const state = { instanceId: 'testhost-gitee2' }
    // 修复前这里 throw「合并 PR 失败（HTTP 405）」，state 丢分支名 → 孤儿分支堆积
    const result = await I.runPush('git', eff, {
      repoDir, instanceId: state.instanceId, state,
      logger: { warn: () => {} }, roots: giteeLiveRoots(tmp),
    })
    assert.equal(result.pushed, true)
    assert.equal(result.mergeRejected, true)
    assert.equal(result.prNumber, 8)
    assert.ok(result.reason.includes('405') && result.reason.includes('未通过设置的审查'), '响应体里的业务原因必须带出来: ' + result.reason)
    assert.ok(state.lastPushedBranch.startsWith('sync/testhost-gitee2/'), '分支名必须落盘，PR 不再无人认领')
    assert.equal(state.lastPrNumber, 8)
  } finally {
    globalThis.fetch = orig
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

test('runPush: 创建 PR 失败不 throw，返回 prFailed + 分支名', async () => {
  const tmp = await mkdtemp()
  const orig = globalThis.fetch
  try {
    const { repoDir } = await setupGiteeLikeRepo(tmp)
    await fsp.mkdir(join(tmp, 'live', 'skills'), { recursive: true })
    await fsp.writeFile(join(tmp, 'live', 'skills', 'SKILL.md'), '# x\n')
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url), method = (init.method || 'GET').toUpperCase()
      if (/\/pulls(\?|$)/.test(u) && method === 'POST') return mk({ message: '目标分支被保护' }, 400)
      return mk({ message: 'unmocked ' + u }, 404)
    }
    const eff = { repoUrl: join(tmp, 'gitee.com', 'o', 'r.git'), branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, token: 'tok' }
    const state = { instanceId: 'testhost-gitee3' }
    const result = await I.runPush('git', eff, {
      repoDir, instanceId: state.instanceId, state,
      logger: { warn: () => {} }, roots: giteeLiveRoots(tmp),
    })
    assert.equal(result.pushed, true, '分支已推送是事实')
    assert.equal(result.prFailed, true)
    assert.equal(result.prCreated, false)
    assert.ok(result.branch.startsWith('sync/testhost-gitee3/'), '返回里带分支名')
    assert.ok(state.lastPushedBranch === result.branch, 'state 落盘分支名（修复前 throw 丢失）')
    assert.equal(state.lastPrNumber, undefined)
    assert.ok(result.reason.includes('400') && result.reason.includes('目标分支被保护'), '失败原因带响应体: ' + result.reason)
  } finally {
    globalThis.fetch = orig
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 6. finalizeConflictBranch 不再谎报 merged:true ──

test('finalizeConflictBranch: 无 PR 支持的远端返回 merged:false + prSkipped + reason（不再谎报）', async () => {
  const tmp = await mkdtemp()
  const orig = globalThis.fetch
  try {
    // 普通本地裸仓库路径：不含任何已知托管主机 → parseRepoUrl null
    const bareRepo = join(tmp, 'remote.git')
    await sh(['init', '--bare', '-b', 'main', bareRepo])
    const seed = join(tmp, 'seed')
    await fsp.mkdir(seed, { recursive: true })
    await fsp.writeFile(join(seed, 'foo.md'), 'base\n')
    await sh(['init', '-b', 'main'], seed)
    await gitNoUser(['add', '-A'], seed)
    await gitNoUser(['commit', '-m', 'seed'], seed)
    await sh(['push', bareRepo, 'main'], seed)
    const repoDir = join(tmp, 'repo')
    await sh(['clone', bareRepo, repoDir])
    await gitNoUser(['checkout', '-b', 'sync/x/1'], repoDir)
    await fsp.writeFile(join(repoDir, 'foo.md'), 'resolved\n')
    await gitNoUser(['add', '-A'], repoDir)
    await gitNoUser(['commit', '-m', 'resolved'], repoDir)
    await sh(['push', 'origin', 'sync/x/1'], repoDir)
    let restCalled = 0
    globalThis.fetch = async () => { restCalled++; return mk({}, 500) }
    const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', token: 'tok' }
    const state = {}
    // 修复前：这里返回 { merged: true, prSkipped: true } —— UI 显示「已合并」
    // 而远端 main 纹丝不动（issue#18 第三处、也是最严重的一处）
    const r = await I.finalizeConflictBranch('git', eff, { repoDir, branch: 'sync/x/1', prNumber: 7, state })
    assert.equal(r.merged, false, '不能再谎报 merged:true')
    assert.equal(r.prSkipped, true)
    assert.equal(r.branch, 'sync/x/1')
    assert.ok(/不支持 PR 合并/.test(r.reason) && /main/.test(r.reason), 'reason 说清分支已推送需手动合并: ' + r.reason)
    assert.equal(restCalled, 0, '无 PR 面的远端不得发起 REST 调用')
    // 分支确实推上去了（等待人工合并的事实仍在）
    const ls = await sh(['ls-remote', bareRepo], tmp)
    assert.ok(ls.includes('sync/x/1'), '分支已推送')
  } finally {
    globalThis.fetch = orig
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
