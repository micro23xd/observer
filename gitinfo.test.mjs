// gitinfo.test.mjs — offline tests for the .git-on-disk resolver. Fixtures are
// fabricated .git layouts (no real `git` needed); the resolver only reads files.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveRepoInfo, _clearCache } from "./gitinfo.mjs";

const tmp = (tag) => fsp.mkdtemp(path.join(os.tmpdir(), `gitinfo-${tag}-`));

test("plain checkout: .git dir → branch from HEAD + repo from origin url", async () => {
  _clearCache();
  const root = await tmp("dir");
  const repo = path.join(root, "web-app");
  await fsp.mkdir(path.join(repo, ".git"), { recursive: true });
  await fsp.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await fsp.writeFile(path.join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:acme/web-app.git\n');
  assert.deepEqual(resolveRepoInfo(repo), { repoName: "web-app", branch: "main" });
  await fsp.rm(root, { recursive: true, force: true });
});

test("no origin remote → repo name falls back to the directory basename", async () => {
  _clearCache();
  const root = await tmp("noremote");
  const repo = path.join(root, "claude-collector");
  await fsp.mkdir(path.join(repo, ".git"), { recursive: true });
  await fsp.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/steer-sessions\n");
  assert.deepEqual(resolveRepoInfo(repo), { repoName: "claude-collector", branch: "steer-sessions" });
  await fsp.rm(root, { recursive: true, force: true });
});

test("worktree: .git FILE → follow gitdir/commondir to the main repo name + branch", async () => {
  _clearCache();
  const root = await tmp("wt");
  const repo = path.join(root, "web-app");
  const mainGit = path.join(repo, ".git");
  const wtGit = path.join(mainGit, "worktrees", "search-v2");
  await fsp.mkdir(wtGit, { recursive: true });
  await fsp.writeFile(path.join(mainGit, "config"),
    '[remote "origin"]\n\turl = https://github.com/acme/web-app.git\n');
  await fsp.writeFile(path.join(wtGit, "HEAD"), "ref: refs/heads/feat/search-v2\n");
  await fsp.writeFile(path.join(wtGit, "commondir"), "../..\n");
  // the worktree's working dir, with a `.git` FILE pointing at the gitdir
  const wtWork = path.join(root, "work", "search-v2");
  await fsp.mkdir(wtWork, { recursive: true });
  await fsp.writeFile(path.join(wtWork, ".git"), `gitdir: ${wtGit}\n`);
  assert.deepEqual(resolveRepoInfo(wtWork), { repoName: "web-app", branch: "feat/search-v2" });
  await fsp.rm(root, { recursive: true, force: true });
});

test("detached HEAD → short sha as branch", async () => {
  _clearCache();
  const root = await tmp("detached");
  const repo = path.join(root, "r");
  await fsp.mkdir(path.join(repo, ".git"), { recursive: true });
  await fsp.writeFile(path.join(repo, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal(resolveRepoInfo(repo).branch, "0123456");
  await fsp.rm(root, { recursive: true, force: true });
});

test("walks up from a subdirectory to find .git", async () => {
  _clearCache();
  const root = await tmp("subdir");
  const repo = path.join(root, "myrepo");
  await fsp.mkdir(path.join(repo, ".git"), { recursive: true });
  await fsp.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/dev\n");
  const sub = path.join(repo, "src", "deep");
  await fsp.mkdir(sub, { recursive: true });
  assert.deepEqual(resolveRepoInfo(sub), { repoName: "myrepo", branch: "dev" });
  await fsp.rm(root, { recursive: true, force: true });
});

test("non-git directory → null", async () => {
  _clearCache();
  const root = await tmp("nogit");
  assert.equal(resolveRepoInfo(root), null);
  await fsp.rm(root, { recursive: true, force: true });
});

test("cache: second lookup returns the same cached object (no re-read)", async () => {
  _clearCache();
  const root = await tmp("cache");
  const repo = path.join(root, "c");
  await fsp.mkdir(path.join(repo, ".git"), { recursive: true });
  await fsp.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const a = resolveRepoInfo(repo);
  // delete the fixture; a cached call must still succeed (proves no re-read)
  await fsp.rm(root, { recursive: true, force: true });
  const b = resolveRepoInfo(repo);
  assert.equal(a, b);
  assert.equal(b.branch, "main");
});
