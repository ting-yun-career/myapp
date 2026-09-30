#!/usr/bin/env node
// PreToolUse hook (Edit|Write): block file edits made in the primary checkout
// while it is on main/master, so feature work happens in a git worktree
// (see AGENTS.md > "Start here: worktree first").
//
// Allowed without a worktree: files outside any git repo, edits inside a linked
// worktree, the agent notes under agent/*.md, and AGENTS.md.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const PROTECTED_BRANCHES = new Set(['main', 'master'])
const ALLOWED_PATHS = [/^agent\/[^/]+\.md$/, /^AGENTS\.md$/]

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
}

function nearestExistingDir(path) {
  let dir = dirname(path)
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

let input = ''
for await (const chunk of process.stdin) input += chunk

let filePath
try {
  filePath = JSON.parse(input).tool_input?.file_path
} catch {
  process.exit(0) // unparseable payload: don't block
}
if (!filePath) process.exit(0)

const absolutePath = resolve(filePath)
const dir = nearestExistingDir(absolutePath)

let topLevel, gitDir, commonDir, branch
try {
  topLevel = git(dir, 'rev-parse', '--show-toplevel')
  gitDir = resolve(dir, git(dir, 'rev-parse', '--git-dir'))
  commonDir = resolve(dir, git(dir, 'rev-parse', '--git-common-dir'))
  branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
} catch {
  process.exit(0) // not inside a git repo (scratchpad, memory dir, ...)
}

const inLinkedWorktree = gitDir !== commonDir
if (inLinkedWorktree || !PROTECTED_BRANCHES.has(branch)) process.exit(0)

const repoRelative = relative(topLevel, absolutePath).split('\\').join('/')
if (ALLOWED_PATHS.some(pattern => pattern.test(repoRelative))) process.exit(0)

const name = topLevel.split('/').pop()
deny(
  `Blocked: ${repoRelative} is in the primary checkout on '${branch}'. ` +
    `Feature work must happen in a git worktree. Run: ` +
    `git worktree add ../${name}-<short-feature-name> -b <feature-branch-name> ${branch} ` +
    `then make this edit inside the new worktree. ` +
    `(Only agent/*.md notes and AGENTS.md may be edited here.)`,
)
