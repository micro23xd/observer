// import-claude.mjs — one-shot backfill from ~/.claude/projects transcripts.
//
// Run while the collector is STOPPED, then start the collector. Uses the SAME
// core.mjs normalize + reduce as the live path — identical reduction is the point.
//
//   glob *.jsonl ─► stream lines ─► normalizeTranscriptLine ─► group by sessionId
//                                                                    │
//        per session: sort by ts (bounded memory) ─► reduce ─► merge into state.json
//
// Merge is SAFE: a session already present and still "live" in the existing
// state.json is never clobbered — the running collector owns it.
//
// Usage: node import-claude.mjs [--since 2026-05-01]
//   env CLAUDE_DIR (default ~/.claude/projects), OBSERVER_DATA_DIR (default ~/.observer)

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { normalizeTranscriptLine, reduce, newSession, buildOverviewRow, STALE_MS } from "./core.mjs";

const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), ".claude", "projects");
const DATA_DIR = process.env.OBSERVER_DATA_DIR || path.join(os.homedir(), ".observer");
const STATE_FILE = path.join(DATA_DIR, "state.json");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since") out.since = Date.parse(argv[++i]);
  }
  return out;
}

async function* walk(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && full.endsWith(".jsonl")) yield full;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fsp.mkdir(DATA_DIR, { recursive: true });

  // Group normalized events by sessionId — sort/reduce per session, not globally.
  const bySession = new Map(); // sessionId -> NormalizedEvent[]
  const sessionFile = new Map(); // sessionId -> { file, ts } of the latest line (Tier-3 source)
  let files = 0, lines = 0;

  for await (const file of walk(CLAUDE_DIR)) {
    files++;
    const fileSession = path.basename(file).replace(/\.jsonl$/, "");
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines++;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      const lts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
      if (args.since && obj.timestamp && lts < args.since) continue;
      const sid = obj.sessionId || fileSession;
      const cur = sessionFile.get(sid);
      if (!cur || lts >= cur.ts) sessionFile.set(sid, { file, ts: lts }); // remember the source .jsonl
      for (const ev of normalizeTranscriptLine(obj, fileSession)) {
        if (!ev.sessionId) continue;
        let arr = bySession.get(ev.sessionId);
        if (!arr) { arr = []; bySession.set(ev.sessionId, arr); }
        arr.push(ev);
      }
    }
  }

  const imported = new Map();
  for (const [id, events] of bySession) {
    events.sort((a, b) => a.ts - b.ts);
    const s = newSession(id);
    for (const e of events) reduce(s, e);
    // Tier-3 deep-dive source: the .jsonl this session was read from.
    const sf = sessionFile.get(id);
    if (sf) s.transcriptPath = sf.file;
    // Historical: downgrade active states to idle; the live collector resumes by sessionId.
    if (s.status === "working" || s.status === "starting") s.status = "idle";
    imported.set(id, s);
  }

  // Load existing state and merge safely.
  let existing = {};
  try { existing = JSON.parse(await fsp.readFile(STATE_FILE, "utf8")); } catch {}

  const now = Date.now();
  const merged = { ...existing };
  let added = 0, updated = 0, skippedLive = 0;
  for (const [id, s] of imported) {
    const prev = existing[id];
    const { buffer, ...rest } = s;
    if (!prev) { merged[id] = rest; added++; continue; }
    // Never clobber a session the running collector still owns.
    const prevLive = (prev.status === "working" || prev.status === "starting" || prev.status === "waiting")
      && (now - (prev.lastTs || 0) < STALE_MS);
    if (prevLive) { skippedLive++; continue; }
    // Otherwise keep whichever has the greater lastTs.
    if ((s.lastTs || 0) > (prev.lastTs || 0)) { merged[id] = rest; updated++; }
  }

  const tmp = STATE_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(merged));
  await fsp.rename(tmp, STATE_FILE);

  console.log(`import-claude: ${files} files, ${lines} lines, ${imported.size} sessions parsed`);
  console.log(`  merged -> ${added} added, ${updated} updated, ${skippedLive} skipped (live), ${Object.keys(merged).length} total`);
  // Sample for eyeballing.
  const sample = [...imported.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, 5);
  for (const s of sample) {
    const r = buildOverviewRow(s, now);
    console.log(`  ${r.repo || r.sessionId.slice(0, 8)}  status=${r.status} turns=${r.turns} tools=${r.toolCalls} edits=${r.edits} files=${r.fileCount} tasks=${r.tasksDone}/${r.tasksOpen + r.tasksDone}`);
  }
}

main().catch((e) => { console.error("import failed:", e); process.exit(1); });
