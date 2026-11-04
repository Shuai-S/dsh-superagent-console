/**
 * Isolated rehearsal for the online installer — safe to run any time.
 *
 * Everything is throwaway and clearly separated from the real deployment:
 *   - profile `superagent-test` (created from the web template, then deleted)
 *   - engine checkout in /tmp/sa-console-rehearsal/engine
 *   - engine port 3099 (real engine uses 3082)
 *   - tmux session dsh-superagent-test (real one is dsh-superagent)
 *
 * `node scripts/test-install.mjs --status-only` only runs detection probes.
 */
import { detect, runInstall } from '../lib/index.js'

const args = new Set(process.argv.slice(2))
const ROOT = '/tmp/sa-console-rehearsal'
const config = {
  target: 'http://127.0.0.1:3099',
  repoUrl: 'git@github.com:deepseek-ai/dsh-superagent-prototype.git',
  engineDir: `${ROOT}/engine`,
  profileName: 'superagent-test',
  extraPath: '~/.local/bin:/usr/local/bin:/opt/homebrew/bin',
}

function show(prefix, result) {
  console.log(prefix, result.state, JSON.stringify({
    reachable: result.engineReachable,
    profile: result.profileInstalled,
    patchMissing: result.patchMissing,
    checkout: result.checkoutValid,
    prereqFails: result.prereqs.filter((item) => !item.ok).map((item) => item.name),
  }))
  if (result.health) console.log(prefix, 'health exit', result.health.exit, 'pids', result.health.pids, 'setup:', result.health.setup ?? 'none')
}

const pre = await detect(config)
show('pre-install :', pre)

if (args.has('--status-only')) process.exit(0)

console.log('running install pipeline…')
const final = await runInstall(config)
for (const [id, stage] of Object.entries(final.stages)) {
  const firstLine = (stage.detail ?? '').split('\n')[0]
  console.log(`  ${id.padEnd(9)} ${stage.status.padEnd(8)} ${firstLine}`)
}
if (final.error) {
  console.error('INSTALL FAILED:', final.error)
  process.exit(1)
}

const post = await detect(config)
show('post-install:', post)
if (post.state !== 'running') {
  console.error('REHEARSAL FAILED: engine not running after install')
  process.exit(1)
}
console.log('REHEARSAL OK — engine running at', post.target)
