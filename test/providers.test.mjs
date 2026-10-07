import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const I = require('../src/index.js').__internals

// 0.4.5：非 GitCode 托管方支持。detectRepoProvider 只做纯字符串识别，
// 每个未知/自建主机都必须落到 'generic'（= 私有性无法远端判定）。

test('detectRepoProvider: 已知托管方 / 自建主机 / ssh 形式', () => {
  assert.deepEqual(I.detectRepoProvider('https://gitcode.com/o/r.git'), { kind: 'gitcode', host: 'gitcode.com', owner: 'o', repo: 'r' })
  assert.equal(I.detectRepoProvider('https://github.com/o/r').kind, 'github')
  const gl = I.detectRepoProvider('https://gitlab.com/group/sub/r.git')
  assert.equal(gl.kind, 'gitlab')
  assert.equal(gl.owner, 'group/sub', 'GitLab 嵌套 group 的 owner 要带路径')
  assert.equal(gl.repo, 'r')
  assert.equal(I.detectRepoProvider('https://gitee.com/o/r').kind, 'gitee')
  assert.equal(I.detectRepoProvider('git@github.com:o/r.git').kind, 'github')
  assert.equal(I.detectRepoProvider('https://git.internal.corp/team/repo.git').kind, 'generic')
  assert.equal(I.detectRepoProvider('http://192.168.1.9/o/r.git').kind, 'generic')
  assert.equal(I.detectRepoProvider('').kind, 'none')
  assert.equal(I.detectRepoProvider('not a url').owner, '')
})

test('gitUsernameForProvider: GitHub 要 x-access-token，其余 oauth2', () => {
  assert.equal(I.gitUsernameForProvider('https://github.com/o/r.git'), 'x-access-token')
  assert.equal(I.gitUsernameForProvider('https://gitlab.com/o/r.git'), 'oauth2')
  assert.equal(I.gitUsernameForProvider('https://gitcode.com/o/r.git'), 'oauth2')
  assert.equal(I.gitUsernameForProvider(undefined), 'oauth2')
  const env = I.gitAuthEnv({ token: 't', repoUrl: 'https://github.com/o/r.git' })
  assert.equal(env.DSH_SYNC_USER, 'x-access-token')
  assert.equal(env.DSH_SYNC_TOKEN, 't')
  assert.ok(I.ASKPASS_SH.includes('DSH_SYNC_USER'), 'askpass 必须按 provider 取用户名')
})

test('checkRepoAccess: 已知 provider 查 REST 判私有性', async () => {
  const orig = globalThis.fetch
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })
  const seen = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    seen.push({ u, h: (init && init.headers) || {} })
    if (u === 'https://api.github.com/repos/o/priv') return mk({ private: true, default_branch: 'trunk' })
    if (u === 'https://api.github.com/repos/o/pub') return mk({ private: false })
    if (u.startsWith('https://gitee.com/api/v5/repos/o/priv')) return mk({ private: true, default_branch: 'main' })
    if (u === 'https://gitlab.com/api/v4/projects/g%2Fsub%2Fpriv') return mk({ visibility: 'internal' })
    if (u === 'https://gitlab.com/api/v4/projects/g%2Fsub%2Fpub') return mk({ visibility: 'public' })
    if (u.includes('api.gitcode.com')) return mk({ private: true, default_branch: 'main' })
    return mk({ message: 'not found' }, 404)
  }
  try {
    const gh = await I.checkRepoAccess('tok', 'https://github.com/o/priv.git')
    assert.equal(gh.ok, true)
    assert.equal(gh.verified, true)
    assert.equal(gh.defaultBranch, 'trunk')
    assert.equal(seen[0].h.Authorization, 'Bearer tok')
    const pub = await I.checkRepoAccess('tok', 'https://github.com/o/pub.git')
    assert.equal(pub.ok, false)
    assert.equal(pub.isPublic, true)
    assert.equal(pub.provider.kind, 'github')
    // GitLab：internal 不算公开；项目路径必须整体 urlencode
    assert.equal((await I.checkRepoAccess('tok', 'https://gitlab.com/g/sub/priv.git')).ok, true)
    assert.equal((await I.checkRepoAccess('tok', 'https://gitlab.com/g/sub/pub.git')).ok, false)
    assert.ok(seen.some(s => s.u === 'https://gitlab.com/api/v4/projects/g%2Fsub%2Fpriv' && s.h['PRIVATE-TOKEN'] === 'tok'),
      'GitLab 需要 PRIVATE-TOKEN + urlencode 的项目路径')
    assert.equal((await I.checkRepoAccess('tok', 'https://gitee.com/o/priv.git')).ok, true)
    const gc = await I.checkRepoAccess('tok', 'https://gitcode.com/o/r.git')
    assert.equal(gc.ok, true)
    assert.equal(gc.provider.kind, 'gitcode')
    // Gitee 的 v5 API 只认 ?access_token=（官方要求），别的 provider 一律走 header
    assert.ok(!seen.some(s => /(github|gitlab|gitcode|git\.internal)/.test(s.u) && s.u.includes('tok')), 'token 只能走 header')
    assert.ok(seen.some(s => s.u.startsWith('https://gitee.com/api/v5/repos/o/priv') && s.u.includes('access_token=tok')), 'Gitee 走 access_token 查询参数')
    const bad = await I.checkRepoAccess('tok', 'not a url')
    assert.equal(bad.ok, false)
    assert.ok(/无法解析仓库地址/.test(bad.error))
  } finally { globalThis.fetch = orig }
})

test('checkRepoAccess: 自建/未知主机判不了私有性 → 必须用户确认风险', async () => {
  const no = await I.checkRepoAccess('tok', 'https://git.internal.corp/team/repo.git')
  assert.equal(no.ok, false)
  assert.equal(no.needConfirm, true)
  assert.equal(no.code, 'UNVERIFIED_REPO')
  assert.equal(no.provider.kind, 'generic')
  assert.ok(/私有/.test(no.error) && /泄露/.test(no.error), '文案必须说清密钥泄露风险: ' + no.error)
  const yes = await I.checkRepoAccess('tok', 'https://git.internal.corp/team/repo.git', { allowUnverified: true })
  assert.equal(yes.ok, true)
  assert.equal(yes.verified, false)
  assert.equal(yes.unverified, true)
})
