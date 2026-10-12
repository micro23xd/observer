// gitinfo.mjs — resolve a checkout's real repo name + current branch from `.git` on
// disk (zero deps, pure fs reads). Two entry points over the same `.git` reader:
//
//   resolveRepoInfo(cwd)        memoized; the collector's label fallback for plain
//                               checkouts only — Superset worktree paths already carry
//                               repo+branch and are handled string-side by
//                               core.parseWorktreePath without any disk I/O.
//   readCheckedOutBranch(root)  NOT memoized, no walk-up; the branch checked out in exactly
//                               that directory right now. features.mjs uses it to decide
//                               which feature record is active (and owns the TTL cache).
//
//   cwd ──► walk up to `.git`
//            ├─ FILE  "gitdir: <wt>"  → branch = <wt>/HEAD ; repo = commondir→main repo
//            └─ DIR                    → branch = <.git>/HEAD ; repo = origin url | dirname
//
// The collector runs on the same machine as the sessions, so these paths are local and
// cheap. resolveRepoInfo caches per cwd (the label's branch is assumed stable for a
// session's lifetime).

import fs from "node:fs";
import path from "node:path";

const cache = new Map(); // cwd -> { repoName, branch } | null

function readTrim(p) {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; }
}

// "ref: refs/heads/feat/x" -> "feat/x"; undefined when HEAD isn't on a branch.
function headBranch(headText) {
  const m = headText && headText.match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1].trim() : undefined;
}

// As headBranch, plus a bare 40-hex sha -> short sha (detached HEAD) for display labels.
function parseHead(headText) {
  if (!headText) return undefined;
  const branch = headBranch(headText);
  if (branch) return branch;
  if (/^[0-9a-f]{7,40}$/i.test(headText)) return headText.slice(0, 7);
  return undefined;
}

// Pull the origin remote's url basename out of a git config (best-effort INI scan).
function repoNameFromConfig(configPath) {
  const txt = (() => { try { return fs.readFileSync(configPath, "utf8"); } catch { return null; } })();
  if (!txt) return undefined;
  const m = txt.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s);
  if (!m) return undefined;
  return basenameRepo(m[1]);
}

// git@github.com:org/web-app.git -> web-app ; https://…/web-app.git -> web-app
function basenameRepo(url) {
  if (!url) return undefined;
  const seg = url.replace(/\/+$/, "").split(/[/:]/).filter(Boolean).pop();
  return seg ? seg.replace(/\.git$/, "") : undefined;
}

// Find the nearest ancestor (incl. cwd) that contains a `.git` entry. Returns its path.
function findGit(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const gp = path.join(dir, ".git");
    if (fs.existsSync(gp)) return { dir, gitPath: gp };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The gitdir that owns HEAD for the `.git` entry at `gitPath` (which lives in `dir`): the
// entry itself for a plain checkout (a directory), or the per-worktree gitdir a worktree's
// `.git` FILE points at. Returns null for anything else (missing, malformed, unreadable).
function locateGitDir(dir, gitPath) {
  let stat;
  try { stat = fs.statSync(gitPath); } catch { return null; }
  if (stat.isFile()) {
    const content = readTrim(gitPath);
    const gm = content && content.match(/^gitdir:\s*(.+)$/m);
    if (!gm) return null;
    return { gitDir: path.resolve(dir, gm[1].trim()), worktree: true };
  }
  if (stat.isDirectory()) return { gitDir: gitPath, worktree: false };
  return null;
}

export function resolveRepoInfo(cwd) {
  if (!cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd);
  const out = (() => {
    let found;
    try { found = findGit(cwd); } catch { return null; }
    if (!found) return null;
    const { dir, gitPath } = found;
    const loc = locateGitDir(dir, gitPath);
    if (!loc) return null;
    const branch = parseHead(readTrim(path.join(loc.gitDir, "HEAD")));

    if (loc.worktree) {
      // Worktree: `.git` points at the per-worktree gitdir under the main repo.
      const commondir = readTrim(path.join(loc.gitDir, "commondir")) || "../..";
      const mainGitDir = path.resolve(loc.gitDir, commondir); // …/<repo>/.git
      const repoRoot = path.dirname(mainGitDir);
      const repoName = repoNameFromConfig(path.join(mainGitDir, "config")) || path.basename(repoRoot);
      return { repoName, branch };
    }
    const repoName = repoNameFromConfig(path.join(gitPath, "config")) || path.basename(dir);
    return { repoName, branch };
  })();
  cache.set(cwd, out);
  return out;
}

// The branch checked out in EXACTLY `root` right now, or undefined (not a checkout root,
// detached HEAD, unreadable). Unlike resolveRepoInfo this never walks up — the caller is
// asking about one specific directory — and never memoizes, because a workspace switches
// branches during its life; the caller bounds the read rate (features.mjs caches per root
// with a short TTL). A worktree directory's name is NOT its branch, so this always reads
// HEAD: `.git` DIR → <root>/.git/HEAD ; `.git` FILE "gitdir: <p>" → <p>/HEAD.
export function readCheckedOutBranch(root) {
  if (!root) return undefined;
  try {
    const loc = locateGitDir(root, path.join(root, ".git"));
    return loc ? headBranch(readTrim(path.join(loc.gitDir, "HEAD"))) : undefined;
  } catch { return undefined; }
}

// Test seam: drop the memo (fixtures reuse cwds across cases).
export function _clearCache() { cache.clear(); }
