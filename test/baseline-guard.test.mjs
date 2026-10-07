/**
 * 同步基线守护 + apiproxy 基地址回归（0.4.8）。
 *
 * 背景（真机实证 2026-10-06，Windows + 桌面版 dsh）：
 *  1) 远端 main 被 force-push / 平台合并丢弃旧 tip 后，state.lastSyncedCommit 仍在本地
 *     对象库里，却不是新 main 的祖先。reconcile 的 `git diff 基线 FETCH_HEAD` 于是把
 *     「凡内容不同」都算成「远端改过」：本机正在写入的会话日志被误判 bothModified，
 *     推送时被 preserve 回退成远端版本 → sessions 永远推不上去，挂账也永不解开。
 *  2) 桌面版插件进程没有 DSH_WEB_URL 环境变量，而 apiproxy 基地址写死 3080；桌面宿主
 *     用的是随机端口（实测 43120）→ AI 智能对齐/解决冲突只报裸 `fetch failed`。
 *
 * 用纯本地仓库（不联网、不 fetch）直接驱动 resolveSyncBase / revalidatePendingBoth，
 * 把 FETCH_HEAD 作为「远端 tip」手工写进 .git/FETCH_HEAD。
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

const silent = { warn: () => {}, info: () => {} }
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
}
const sh = (args, cwd) => new Promise((res, rej) => {
  execFile('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd, env },
    (e, o, er) => e ? rej(new Error(`${args.join(' ')}: ${String(er || e.message).slice(-200)}`)) : res(String(o)))
})
const head = async (cwd) => (await sh(['rev-parse', 'HEAD'], cwd)).trim()
const commit = async (cwd, msg) => { await sh(['add', '-A'], cwd); await sh(['commit', '-q', '-m', msg], cwd); return head(cwd) }
const w = async (cwd, rel, s) => { await fsp.mkdir(join(cwd, rel, '..'), { recursive: true }); await fsp.writeFile(join(cwd, rel), s) }
// 「远端 tip」= FETCH_HEAD 伪引用文件（git 会把它当 refs 解析，无需真的 fetch）
const setFetchHead = (cwd, sha) => fsp.writeFile(join(cwd, '.git', 'FETCH_HEAD'), `${sha}\t\tbranch 'main' of /local/hub\n`)

/**
 * 仓库形态（复刻真机）：
 *   I1  共同祖先：sessions/a.log = remote-v1、settings/settings.yaml = s0
 *   D   被丢弃的旧 tip（从 I1 分出，改过 sessions/a.log）——不是 C1 的祖先
 *   C1  现在的远端 main：不动 sessions/a.log，改 settings.yaml、加 plugins/p.json
 *   O   无关历史（orphan root）：与 C1 无共同祖先
 */
async function mkScenario() {
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'dshsync-base-'))
  const repo = join(tmp, 'repo')
  await fsp.mkdir(repo, { recursive: true })
  await sh(['init', '-q', '-b', 'main'], repo)
  await w(repo, 'sessions/a.log', 'remote-v1\n')
  await w(repo, 'settings/settings.yaml', 's0\n')
  const I1 = await commit(repo, 'I1')
  await sh(['checkout', '-q', '-b', 'side', I1], repo)
  await w(repo, 'sessions/a.log', 'dead-v1\n')
  const D = await commit(repo, 'D')
  await sh(['checkout', '-q', 'main'], repo)
  await w(repo, 'settings/settings.yaml', 's1\n')
  await w(repo, 'plugins/p.json', '{}\n')
  const C1 = await commit(repo, 'C1')
  await sh(['checkout', '-q', '--orphan', 'orphan'], repo)
  const O = await commit(repo, 'O')
  await sh(['checkout', '-q', 'main'], repo)
  await setFetchHead(repo, C1)
  return { tmp, repo, I1, D, C1, O }
}

test('resolveSyncBase：基线可达用自己，不可达退化到共同祖先，无共同祖先返回 null', async () => {
  const s = await mkScenario()
  assert.equal(await I.resolveSyncBase('git', s.repo, s.C1, silent), s.C1)
  assert.equal(await I.resolveSyncBase('git', s.repo, s.I1, silent), s.I1)
  // 被丢弃的旧 tip（真机 75b890bf 那种）→ 退化为共同祖先，diff 不再把本机文件当远端改动
  assert.equal(await I.resolveSyncBase('git', s.repo, s.D, silent), s.I1)
  assert.equal(await I.resolveSyncBase('git', s.repo, s.O, silent), null)
  assert.equal(await I.resolveSyncBase('git', s.repo, null, silent), null)
})

test('revalidatePendingBoth：失效基线下的挂账被销账/修正，会话日志不再永久挂账', async () => {
  const s = await mkScenario()
  const state = {
    pendingBoth: {
      'sessions/a.log': s.D,          // 远端在共同祖先之后没动过它 → 销账（真机 sessions 卡死形态）
      'settings/settings.yaml': s.D,  // 远端确实改过 → 记账基线修正到共同祖先，冲突判定保留
      'plugins/p.json': s.I1,         // 记账基线仍可达（正常挂账）→ 原样保留
      'skills/gone.md': s.O,          // 无共同祖先 → 销账
    },
  }
  const r = await I.revalidatePendingBoth('git', s.repo, state, silent)
  assert.deepEqual([...r.cleared].sort(), ['sessions/a.log', 'skills/gone.md'])
  assert.equal(state.pendingBoth['sessions/a.log'], undefined)
  assert.equal(state.pendingBoth['settings/settings.yaml'], s.I1)
  assert.equal(state.pendingBoth['plugins/p.json'], s.I1)
})

test('apiproxy 基地址：3080 兜底、桌面宿主端口覆盖、网络失败信息带基地址', async () => {
  const realFetch = globalThis.fetch
  try {
    assert.equal(I.APIPROXY_FALLBACK_BASE, process.env.DSH_WEB_URL || 'http://127.0.0.1:3080')
    assert.equal(I.apiproxyBaseNow(), I.APIPROXY_FALLBACK_BASE)
    // apply() 用 ctx.webServer.port 调它：桌面版随机端口（真机 43120）必须覆盖 3080
    assert.equal(I.setApiproxyPort(43120), 'http://127.0.0.1:43120')
    assert.equal(I.setApiproxyPort(0), 'http://127.0.0.1:43120')
    assert.equal(I.setApiproxyPort('abc'), 'http://127.0.0.1:43120')
    assert.equal(I.setApiproxyPort(undefined), 'http://127.0.0.1:43120')
    globalThis.fetch = () => { throw new Error('fetch failed') }
    await assert.rejects(() => I.apiproxyCall('session/create', {}, null),
      /基地址 http:\/\/127\.0\.0\.1:43120/)
  } finally { globalThis.fetch = realFetch }
})
