#!/usr/bin/env node
/**
 * Stamp public/build-info.json with what is ACTUALLY about to be deployed.
 *
 * WHY THIS EXISTS
 * ---------------
 * netlify/functions/deploy-drift-check.js reads /build-info.json off the live
 * site every hour and compares it to GitHub's main. That is the alarm for the
 * 30 Aug 2026 incident, where a `netlify deploy` from a laptop checkout on an
 * old branch silently rolled production back weeks and nobody noticed for a day.
 *
 * Netlify used to write that file at build time. Cloudflare does not, so after
 * the migration the live stamp froze at commit a23f4ad / 4 Sep and the drift
 * check has been comparing a fossil against a moving branch -- an alarm that
 * fires constantly means the same thing as an alarm that never fires.
 *
 * The file is gitignored on purpose. A stamp committed to the repo can never
 * name its own commit, so a tracked copy is stale the instant it is written; and
 * if the stamp is missing entirely the drift check already says so out loud
 * ("no build stamp"), which is the correct, loud failure for a deploy that
 * skipped this script.
 *
 * Run it via `npm run deploy`, which stamps and then hands off to wrangler.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT  = path.join(ROOT, 'public', 'build-info.json');

// Written by the deploy itself, so a difference here is not somebody's
// uncommitted source change and must not be reported as one.
const NOT_REALLY_DIRTY = new Set(['worker/routes.generated.js', 'public/build-info.json']);

function git(...args) {
  try {
    // Trailing newlines only. A porcelain status line for a modified-but-
    // unstaged file starts with a SPACE (" M path"), and .trim() ate it --
    // which shifted every path parsed below by one character.
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .replace(/\s+$/, '');
  } catch {
    return '';
  }
}

/**
 * The deploy worktree runs on a detached HEAD, and so does actions/checkout, so
 * `--abbrev-ref HEAD` says "HEAD" in both places. Answering "detached" there
 * would make the drift check complain about the branch on every single deploy.
 */
function branchName() {
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  const sym = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (sym && sym !== 'HEAD') return sym;
  const atHead = git('for-each-ref', '--points-at', 'HEAD', '--format=%(refname:short)', 'refs/remotes/origin')
    .split('\n').map(s => s.trim()).filter(Boolean)
    // git shortens refs/remotes/origin/HEAD to the bare remote name "origin".
    // That alias is not a branch and naming it would tell the drift check the
    // site was built from a branch called "origin".
    .filter(ref => ref !== 'origin' && !ref.endsWith('/HEAD'))
    .map(ref => ref.replace(/^origin\//, ''));
  if (atHead.includes('main')) return 'main';
  if (atHead.length) return atHead[0];
  return 'detached';
}

/** `XY path` / `XY old -> new` -> the path git means. */
function pathsFrom(porcelain) {
  if (!porcelain) return [];
  return porcelain.split('\n')
    .map(line => line.slice(3).trim())
    .map(p => (p.includes(' -> ') ? p.split(' -> ').pop() : p))
    .map(p => p.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/**
 * What is on disk but not in the repository, restricted to what a deploy would
 * actually ship:
 *   - any MODIFIED OR STAGED tracked file, anywhere. This is the 30 Aug case.
 *   - any UNTRACKED file under public/, because public/ is uploaded wholesale
 *     and an untracked file in there goes live like any other.
 * Untracked files elsewhere (scratch scripts, a local .github/) change nothing
 * about what is served and are deliberately not counted.
 */
function dirtyFiles() {
  const tracked   = pathsFrom(git('status', '--porcelain', '--untracked-files=no'));
  const inPublic  = pathsFrom(git('status', '--porcelain', '--untracked-files=all', '--', 'public'));
  return [...new Set([...tracked, ...inPublic])].filter(p => !NOT_REALLY_DIRTY.has(p)).sort();
}

const commit = git('rev-parse', 'HEAD');
if (!commit) {
  console.error('[stamp-build-info] not a git checkout — refusing to write a stamp that would lie about what is deployed');
  process.exit(1);
}

const dirty = dirtyFiles();
const info = {
  commit,
  branch: branchName(),
  context: 'production',
  deploy_id: process.env.GITHUB_RUN_ID || '',
  built_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  // The drift check alerts on this. A deploy carrying uncommitted changes is
  // exactly what went wrong on 30 Aug: green deploy, code nobody can find.
  dirty: dirty.length > 0,
  dirty_files: dirty.slice(0, 20),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + '\n');

console.log(`[stamp-build-info] ${commit.slice(0, 10)} on ${info.branch}`
  + (info.dirty ? ` — ⚠️ DIRTY, ${dirty.length} uncommitted: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ' …' : ''}` : ' — clean'));
