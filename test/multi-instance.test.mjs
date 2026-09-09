/**
 * dsh-sync 多实例（多副本）仿真测试。
 *
 * 在一台机器上模拟 N 个副本：每个副本有独立的 live 根、独立影子仓库、
 * 独立 state（instanceId/pendingBoth/基线），共享同一个本地裸仓库作为"云端"。
 * 引擎走 __internals 的真实 reconcileRemote / runPush / runPull，与宿主内
 * runSync 的确定性部分同构（不含锁与 AI 对齐——对齐在用例里以"写回合并结果 +
 * 清账"的方式模拟，与真实 align 成功路径等价）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
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
const mkdtemp = async () => fsp.mkdtemp(join(tmpdir(), 'dshsync-mi-'))
const silent = { warn: () => {}, info: () => {} }
const read = (p) => fs.readFileSync(p, 'utf8')
const write = async (p, s) => { await fsp.mkdir(join(p, '..'), { recursive: true }); await fsp.writeFile(p, s) }

// 一个副本：独立 live 根 + 影子仓库 + state；hub = 共享裸仓库
async function mkReplica(tmp, name, eff) {
  const live = join(tmp, name, 'live')
  const repoDir = join(tmp, name, 'repo')
  const state = { instanceId: name }
  const roots = {
    dshSkills: join(live, '.dsh', 'skills'),
    agentsSkills: join(live, '.nope-agents'),
    agentsLock: join(live, '.nope-lock'),
    sessions: join(live, '.nope-s'),
    settingsFile: join(live, '.dsh', 'settings.yaml'),
    profiles: join(live, '.nope-p'),
  }
  await fsp.mkdir(join(live, '.dsh', 'skills'), { recursive: true })
  await write(join(live, '.dsh', 'settings.yaml'), `owner: ${name}\n`)
  await I.ensureShadowRepo('git', eff, repoDir)
  // 不预置 lastSyncedCommit —— 与真实新副本一致，首接语义（并集下载）由引擎处理
  return { name, live, repoDir, state, roots, eff }
}

// 与宿主 runSync 的确定性部分同构：reconcile → 挂账合并 → push(preserve) → pull
async function driveSync(r) {
  const rec = await I.reconcileRemote('git', r.eff, { repoDir: r.repoDir, state: r.state, logger: silent, roots: r.roots })
  const fresh = (rec && Array.isArray(rec.bothModified)) ? rec.bothModified : []
  r.state.pendingBoth = r.state.pendingBoth && typeof r.state.pendingBoth === 'object' ? r.state.pendingBoth : {}
  const spec = I.syncSpec(r.eff, r.roots, r.state.instanceId)
  const pendings = Object.keys(r.state.pendingBoth)
    .filter(p => !fresh.some(f => f.shadowPath === p))
    .map(p => {
      const livePath = I.resolveLivePath(spec, p)
      return livePath ? { shadowPath: p, livePath, baseCommit: r.state.pendingBoth[p] } : null
    })
    .filter(Boolean)
  const both = [...fresh, ...pendings]
  const push = await I.runPush('git', r.eff, { repoDir: r.repoDir, instanceId: r.state.instanceId, state: r.state, logger: silent, roots: r.roots, preserve: both.map(f => f.shadowPath) })
  // 模拟 GitCode 的 PR 合并：runPush 在非 GitCode 远端只推分支（prSkipped），
  // 这里把分支快进为 hub main，等价于 PR 被合并
  if (push.pushed && push.prSkipped && r.state.lastPushedBranch) {
    await sh(['fetch', r.eff.repoUrl, r.state.lastPushedBranch], r.repoDir).catch(() => {})
    await sh(['push', r.eff.repoUrl, 'FETCH_HEAD:main'], r.repoDir).catch(() => {})
  }
  const pull = await I.runPull('git', r.eff, { repoDir: r.repoDir, state: r.state, logger: silent, roots: r.roots })
  return { rec, push, pull }
}

async function mkHub(tmp) {
  const bareRepo = join(tmp, 'hub.git')
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(join(seed, 'skills', 'dsh', 'base'), { recursive: true })
  await write(join(seed, '.gitattributes'), '*.jsonl merge=union\n')
  await write(join(seed, 'skills', 'dsh', 'base', 'SKILL.md'), 'base\n')
  await sh(['init', '-b', 'main'], seed)
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  return bareRepo
}

const hubHead = async (hub, path, viaRepo) => {
  await sh(['fetch', hub, 'main'], viaRepo).catch(() => {})
  return sh(['show', `FETCH_HEAD:${path}`], viaRepo).catch(() => null)
}

test('三副本并集收敛：各自新增的技能两轮同步后全量互通', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  const eff = { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, token: '' }
  const r1 = await mkReplica(tmp, 'r1-mac', eff)
  const r2 = await mkReplica(tmp, 'r2-linux', eff)
  const r3 = await mkReplica(tmp, 'r3-termux', eff)
  try {
    await write(join(r1.live, '.dsh', 'skills', 'alpha', 'SKILL.md'), 'alpha from r1\n')
    await write(join(r2.live, '.dsh', 'skills', 'bravo', 'SKILL.md'), 'bravo from r2\n')
    await write(join(r3.live, '.dsh', 'skills', 'charlie', 'SKILL.md'), 'charlie from r3\n')
    for (const r of [r1, r2, r3]) await driveSync(r)
    for (const r of [r1, r2, r3]) await driveSync(r)
    for (const r of [r1, r2, r3]) {
      for (const s of ['alpha', 'bravo', 'charlie']) {
        assert.ok(fs.existsSync(join(r.live, '.dsh', 'skills', s, 'SKILL.md')), `${r.name} 拥有 ${s}`)
      }
      assert.equal(read(join(r.live, '.dsh', 'skills', 'base', 'SKILL.md')), 'base\n', 'base 保留')
    }
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('双改挂账：先推者保位，模拟对齐解账后双方收敛为合并结果', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  const eff = { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, token: '' }
  const r1 = await mkReplica(tmp, 'r1', eff)
  const r2 = await mkReplica(tmp, 'r2', eff)
  try {
    // 共同基线：双方先同步一次拿到 base（skills/dsh/shared）
    await write(join(r1.live, '.dsh', 'skills', 'shared', 'SKILL.md'), 'common base\n')
    await driveSync(r1)
    await driveSync(r2)
    assert.equal(read(join(r2.live, '.dsh', 'skills', 'shared', 'SKILL.md')), 'common base\n')
    // 双方各自改同一文件（不同行）
    await write(join(r1.live, '.dsh', 'skills', 'shared', 'SKILL.md'), 'common base\nr1 line\n')
    await write(join(r2.live, '.dsh', 'skills', 'shared', 'SKILL.md'), 'common base\nr2 line\n')
    await driveSync(r1)   // r1 先推：main = base + r1 line
    const res2 = await driveSync(r2)   // r2 后推：bothModified 挂账 + preserve
    assert.equal((res2.rec.bothModified || []).some(f => f.shadowPath === 'skills/dsh/shared/SKILL.md'), true, 'r2 检出 bothModified')
    assert.equal(read(join(r2.live, '.dsh', 'skills', 'shared', 'SKILL.md')), 'common base\nr2 line\n', 'r2 本机行保留')
    assert.deepEqual(r2.state.pendingBoth['skills/dsh/shared/SKILL.md'] !== undefined, true, '真基线挂账')
    // main 上仍是 r1 版（preserve 生效，未静默覆盖）
    // 模拟 AI 对齐成功：写回合并结果 + 销账
    await write(join(r2.live, '.dsh', 'skills', 'shared', 'SKILL.md'), 'common base\nr1 line\nr2 line\n')
    delete r2.state.pendingBoth['skills/dsh/shared/SKILL.md']
    await driveSync(r2)   // 推合并结果上 main
    await driveSync(r1)   // r1 拉回合并结果（本机未再动 → 应用）
    assert.equal(read(join(r1.live, '.dsh', 'skills', 'shared', 'SKILL.md')), 'common base\nr1 line\nr2 line\n', 'r1 收敛到合并结果')
    assert.equal(read(join(r2.live, '.dsh', 'skills', 'shared', 'SKILL.md')), 'common base\nr1 line\nr2 line\n', 'r2 保持合并结果')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('backup 策略三副本：settings 各机独立上云，互不覆盖，live 不被拉花', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  const r1 = await mkReplica(tmp, 'r1', { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: false, syncSettings: true, syncPlugins: false, token: '' })
  const r2 = await mkReplica(tmp, 'r2', { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: false, syncSettings: true, syncPlugins: false, token: '' })
  try {
    for (const r of [r1, r2]) await driveSync(r)
    for (const r of [r1, r2]) await driveSync(r)
    // 各机的 settings 落各自 backup 命名空间
    assert.equal(await hubHead(hub, `backup/r1/settings/settings.yaml`, r1.repoDir).then(s => s.trim()), `owner: r1`)
    assert.equal(await hubHead(hub, `backup/r2/settings/settings.yaml`, r1.repoDir).then(s => s.trim()), `owner: r2`)
    // 共享路径不存在（backup 策略不写共享树）
    assert.equal(await hubHead(hub, 'settings/settings.yaml', r1.repoDir), null, 'shared settings path untouched')
    // 双方 live 都还是自己的配置（没有被对端整文件替换）
    assert.equal(read(join(r1.live, '.dsh', 'settings.yaml')), 'owner: r1\n')
    assert.equal(read(join(r2.live, '.dsh', 'settings.yaml')), 'owner: r2\n')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('remote 策略副本：只读镜像——自动吃到 union 副本的内容，本地改动被冲掉且不外推', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  const r1 = await mkReplica(tmp, 'r1-union', { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, token: '' })
  const r3 = await mkReplica(tmp, 'r3-mirror', { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, skillsStrategy: 'remote', token: '' })
  try {
    // 初始：r1 推一个文件，r3 镜像吃到
    await write(join(r1.live, '.dsh', 'skills', 'feed', 'SKILL.md'), 'from r1 v1\n')
    await driveSync(r1)
    await driveSync(r3)
    assert.equal(read(join(r3.live, '.dsh', 'skills', 'feed', 'SKILL.md')), 'from r1 v1\n', '镜像吃到远端内容')
    // r3 本地乱改 → 下一次同步被远端冲掉，且不外推（main 不变）
    await write(join(r3.live, '.dsh', 'skills', 'feed', 'SKILL.md'), 'r3 本地乱改\n')
    await driveSync(r3)
    await driveSync(r3)
    assert.equal(read(join(r3.live, '.dsh', 'skills', 'feed', 'SKILL.md')), 'from r1 v1\n', '本地改动被远端冲掉')
    assert.equal(await hubHead(hub, 'skills/dsh/feed/SKILL.md', r1.repoDir).then(s => s.trim()), 'from r1 v1', 'main 未被 r3 改动污染')
    // r1 更新 → r3 自动跟上
    await write(join(r1.live, '.dsh', 'skills', 'feed', 'SKILL.md'), 'from r1 v2\n')
    await driveSync(r1)
    await driveSync(r3)
    assert.equal(read(join(r3.live, '.dsh', 'skills', 'feed', 'SKILL.md')), 'from r1 v2\n', '远端更新自动跟上')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('第四机首接：并集加入，不删其他副本的内容，自己内容也能推上去', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  const eff = { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, token: '' }
  const r1 = await mkReplica(tmp, 'r1', eff)
  await write(join(r1.live, '.dsh', 'skills', 'only-r1', 'SKILL.md'), 'r1 special\n')
  await driveSync(r1)
  const r4 = await mkReplica(tmp, 'r4-newcomer', eff)   // 全新副本，lastSyncedCommit 为空 → 首接
  await write(join(r4.live, '.dsh', 'skills', 'only-r4', 'SKILL.md'), 'r4 special\n')
  try {
    await driveSync(r4)
    // main 同时拥有 r1 与 r4 的内容（首接并集，不删别人）
    assert.ok(await hubHead(hub, 'skills/dsh/only-r1/SKILL.md', r1.repoDir).then(s => (s || '').includes('r1 special')), 'r1 内容未被首接删除')
    assert.ok(await hubHead(hub, 'skills/dsh/only-r4/SKILL.md', r1.repoDir).then(s => (s || '').includes('r4 special')), 'r4 内容已上云')
    await driveSync(r4)
    assert.ok(fs.existsSync(join(r4.live, '.dsh', 'skills', 'only-r1', 'SKILL.md')), 'r4 拉回 r1 内容')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

// ── 远端技能库：索引各主机备份 + 选择性安装 ──────────────────────────────

test('remoteSkillsIndex/install: 从其他主机的备份命名空间挑选技能装到本机', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  const baseEff = { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, token: '' }
  const r1 = await mkReplica(tmp, 'r1', baseEff)
  const r2 = await mkReplica(tmp, 'r2', { ...baseEff, skillsStrategy: 'backup' })
  try {
    // r1（union 策略）推共享技能；r2（backup 策略）技能进自己的备份命名空间
    await write(join(r1.live, '.dsh', 'skills', 'shared-one', 'SKILL.md'), '# shared one\n')
    await write(join(r1.live, '.dsh', 'skills', 'shared-two', 'SKILL.md'), '# shared two\n')
    await write(join(r2.live, '.dsh', 'skills', 'private-r2', 'SKILL.md'), '# r2 private\n')
    await write(join(r2.live, '.dsh', 'skills', 'private-r2', 'references', 'a.md'), 'ref\n')
    await driveSync(r1)
    await driveSync(r2)
    // r1 视角的云端索引：union（2 个技能）+ r2 的备份（1 个技能），不含 r1 自己
    const index = await I.remoteSkillsIndex('git', r1.eff, { repoDir: r1.repoDir, instanceId: 'r1' })
    const ids = index.sources.map(s => s.id).sort().join(',')
    assert.equal(ids, 'r2,union', 'sources = union + 其他主机备份: ' + ids)
    const union = index.sources.find(s => s.id === 'union')
    assert.equal(union.trees[0].tree, 'dsh')
    assert.equal(union.trees[0].skills.length, 3, 'union 有三个技能（含种子 base）')
    const r2src = index.sources.find(s => s.id === 'r2')
    assert.equal(r2src.trees[0].skills[0].name, 'private-r2')
    assert.equal(r2src.trees[0].skills[0].files, 2, '文件数统计正确')
    // 安装 r2 的私有技能到 r1（overwrite=false）
    const res = await I.installRemoteSkills('git', r1.eff, { repoDir: r1.repoDir, roots: r1.roots }, {
      source: 'r2', skills: [{ tree: 'dsh', name: 'private-r2' }], overwrite: false,
    })
    assert.deepEqual(res.installed, ['dsh/private-r2'])
    assert.equal(read(join(r1.live, '.dsh', 'skills', 'private-r2', 'SKILL.md')), '# r2 private\n', '技能内容落盘')
    assert.equal(read(join(r1.live, '.dsh', 'skills', 'private-r2', 'references', 'a.md')), 'ref\n', '子目录文件一并安装')
    // 再装一次（同名）：默认跳过；overwrite=true 替换
    const res2 = await I.installRemoteSkills('git', r1.eff, { repoDir: r1.repoDir, roots: r1.roots }, {
      source: 'r2', skills: [{ tree: 'dsh', name: 'private-r2' }], overwrite: false,
    })
    assert.deepEqual(res2.skipped, ['dsh/private-r2'], '同名默认跳过')
    await write(join(r2.live, '.dsh', 'skills', 'private-r2', 'SKILL.md'), '# r2 v2\n')
    await driveSync(r2)
    const res3 = await I.installRemoteSkills('git', r1.eff, { repoDir: r1.repoDir, roots: r1.roots }, {
      source: 'r2', skills: [{ tree: 'dsh', name: 'private-r2' }], overwrite: true,
    })
    assert.deepEqual(res3.installed, ['dsh/private-r2'], 'overwrite=true 替换')
    assert.equal(read(join(r1.live, '.dsh', 'skills', 'private-r2', 'SKILL.md')), '# r2 v2\n')
    // 安装不存在的技能 → failed
    const res4 = await I.installRemoteSkills('git', r1.eff, { repoDir: r1.repoDir, roots: r1.roots }, {
      source: 'r2', skills: [{ tree: 'dsh', name: 'no-such' }], overwrite: true,
    })
    assert.equal(res4.failed.length, 1)
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})
