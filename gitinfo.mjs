// gitinfo.mjs — resolve a checkout's real repo name + current branch from `.git` on
// disk (zero deps, pure fs reads, memoized). Used by the collector ONLY as a fallback
// for plain checkouts — Superset worktree paths already carry repo+branch and are
// handled string-side by core.parseWorktreePath without any disk I/O.
//
//   cwd ──► walk up to `.git`
//            ├─ FILE  "gitdir: <wt>"  → branch = <wt>/HEAD ; repo = commondir→main repo
//            └─ DIR                    → branch = <.git>/HEAD ; repo = origin url | dirname
//
// The collector runs on the same machine as the sessions, so these paths are local and
// cheap. Results are cached per cwd (branch is assumed stable for a session's lifetime).

import fs from "node:fs";
import path from "node:path";

const cache = new Map(); // cwd -> { repoName, branch } | null

function readTrim(p) {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; }
}

// "ref: refs/heads/feat/x" -> "feat/x"; a bare 40-hex sha -> short sha (detached HEAD).
function parseHead(headText) {
  if (!headText) return undefined;
  const m = headText.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (m) return m[1].trim();
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

export function resolveRepoInfo(cwd) {
  if (!cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd);
  const out = (() => {
    let found;
    try { found = findGit(cwd); } catch { return null; }
    if (!found) return null;
    const { dir, gitPath } = found;

    let stat;
    try { stat = fs.statSync(gitPath); } catch { return null; }

    if (stat.isFile()) {
      // Worktree: `.git` points at the per-worktree gitdir under the main repo.
      const content = readTrim(gitPath);
      const gm = content && content.match(/^gitdir:\s*(.+)$/m);
      if (!gm) return null;
      const wtGitDir = path.resolve(dir, gm[1].trim());
      const branch = parseHead(readTrim(path.join(wtGitDir, "HEAD")));
      const commondir = readTrim(path.join(wtGitDir, "commondir")) || "../..";
      const mainGitDir = path.resolve(wtGitDir, commondir); // …/<repo>/.git
      const repoRoot = path.dirname(mainGitDir);
      const repoName = repoNameFromConfig(path.join(mainGitDir, "config")) || path.basename(repoRoot);
      return { repoName, branch };
    }
    if (stat.isDirectory()) {
      const branch = parseHead(readTrim(path.join(gitPath, "HEAD")));
      const repoName = repoNameFromConfig(path.join(gitPath, "config")) || path.basename(dir);
      return { repoName, branch };
    }
    return null;
  })();
  cache.set(cwd, out);
  return out;
}

// Test seam: drop the memo (fixtures reuse cwds across cases).
export function _clearCache() { cache.clear(); }
