import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const defaultEditorRoot = dirname(dirname(currentFile));
const defaultStatePath = join(defaultEditorRoot, "data", "update-log-automation-state.json");
const entrySchemaPath = join(defaultEditorRoot, "data", "update-log-automation-schema.json");
const defaultRepoPath = "C:\\Users\\dsddr\\Desktop\\Limitless Project";
const defaultApiBaseUrl = "http://127.0.0.1:4317";
const vagueSubjectPattern = /^(smth|something|stuff|changes?|update|updates|misc|misc changes|wip|work in progress|test|fix|tweak|wow|cool|nice|bird)$/i;
const entrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sectionTitle: { type: "string" },
          bulletText: { type: "string" },
          children: { type: "array", items: { type: "string" } },
          commits: { type: "array", items: { type: "string" } }
        },
        required: ["sectionTitle", "bulletText", "children", "commits"]
      }
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          hash: { type: "string" },
          subject: { type: "string" },
          reason: { type: "string" }
        },
        required: ["hash", "subject", "reason"]
      }
    }
  },
  required: ["entries", "skipped"]
};

const fallbackCharacterSections = new Map([
  ["gojo", "Honored One"],
  ["sukuna", "King Of Curses"],
  ["heian", "King Of Curses"],
  ["toji", "Sorcerer Hunter"]
]);

const fallbackCharacterAliases = new Map([
  ["gojo", "Honored One"],
  ["honored one", "Honored One"],
  ["sukuna", "King Of Curses"],
  ["heian", "King Of Curses"],
  ["king of curses", "King Of Curses"],
  ["toji", "Sorcerer Hunter"],
  ["sorcerer hunter", "Sorcerer Hunter"]
]);

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    args[key] = rest.length > 0 ? rest.join("=") : true;
  }
  return args;
}

function runGit(repoPath, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function resolveCommand(command, args) {
  if (process.platform === "win32" && command === "codex") {
    const candidates = [
      process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : "",
      join(dirname(process.execPath), "node_modules", "@openai", "codex", "bin", "codex.js")
    ].filter(Boolean);
    const script = candidates.find((candidate) => existsSync(candidate));
    if (script) return { command: process.execPath, args: [script, ...args] };
  }
  return { command, args };
}

function runCommand(command, args, input, options = {}) {
  return new Promise((resolveCommandResult, reject) => {
    const resolved = resolveCommand(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd ?? defaultEditorRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out.`));
    }, options.timeoutMs ?? 180000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) resolveCommandResult({ code, stdout, stderr });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function extractFinalJson(stdout) {
  let lastMessage = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (typeof event.message === "string") lastMessage = event.message;
      if (event.type === "agent_message" && typeof event.message === "string") lastMessage = event.message;
      if (event.type === "task_complete" && typeof event.last_message === "string") lastMessage = event.last_message;
    } catch {
      lastMessage = line;
    }
  }
  const trimmed = lastMessage.trim();
  if (!trimmed) throw new Error("Codex returned no final message.");
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}$/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Codex returned malformed JSON: ${trimmed.slice(0, 500)}`);
  }
}

function readState(statePath) {
  if (!existsSync(statePath)) {
    return { version: 1, lastProcessedHead: "", lastAttemptedHead: "", postedSignatures: [], updatedAt: "" };
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8"));
  return {
    version: 1,
    repoPath: parsed.repoPath,
    apiBaseUrl: parsed.apiBaseUrl,
    lastProcessedHead: parsed.lastProcessedHead ?? "",
    lastAttemptedHead: parsed.lastAttemptedHead ?? "",
    postedSignatures: Array.isArray(parsed.postedSignatures) ? parsed.postedSignatures : [],
    updatedAt: parsed.updatedAt ?? ""
  };
}

function writeState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    repoPath: state.repoPath,
    apiBaseUrl: state.apiBaseUrl,
    lastProcessedHead: state.lastProcessedHead,
    lastAttemptedHead: state.lastAttemptedHead,
    postedSignatures: [...new Set(state.postedSignatures)].slice(-1000),
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

async function isApiHealthy(apiBaseUrl) {
  try {
    await fetchJson(`${apiBaseUrl}/api/health`);
    return true;
  } catch {
    return false;
  }
}

async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function ensureApi(apiBaseUrl, editorRoot = defaultEditorRoot) {
  if (await isApiHealthy(apiBaseUrl)) return { started: false, stop: async () => {} };

  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm run api"] : ["run", "api"];
  const child = spawn(command, args, { cwd: editorRoot, stdio: "ignore", windowsHide: true });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(250);
    if (await isApiHealthy(apiBaseUrl)) {
      return {
        started: true,
        stop: async () => {
          if (process.platform === "win32") {
            spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          } else {
            child.kill("SIGTERM");
          }
        }
      };
    }
  }

  throw new Error(`Update Log Editor API did not become healthy at ${apiBaseUrl}`);
}

function getHead(repoPath) {
  return runGit(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
}

function isAncestor(repoPath, ancestor, head) {
  if (!ancestor) return false;
  return runGit(repoPath, ["merge-base", "--is-ancestor", ancestor, head], { allowFailure: true }).status === 0;
}

function parseLog(raw) {
  if (!raw.trim()) return [];
  return raw
    .split("\x1e")
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.trimStart().split(/\r?\n/);
      const [hash, shortHash, date, subject] = lines.shift().split("\x1f");
      const changes = lines
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\t+/);
          return { status: parts[0], paths: parts.slice(1) };
        });
      return { hash, shortHash, date, subject: subject ?? "", changes };
    });
}

function getCommits(repoPath, fromHash, toHash) {
  const range = fromHash ? `${fromHash}..${toHash}` : toHash;
  const result = runGit(repoPath, [
    "log",
    range,
    "--reverse",
    "--date=iso-strict",
    "--pretty=format:%x1e%H%x1f%h%x1f%ad%x1f%s",
    "--name-status"
  ]);
  return parseLog(result.stdout).map((commit) => ({
    ...commit,
    patch: runGit(repoPath, ["show", "--format=", "--patch", "--unified=4", commit.hash]).stdout
  }));
}

function allPaths(commit) {
  return commit.changes.flatMap((change) => change.paths);
}

function hasAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function balanceBraces(line) {
  let balance = 0;
  for (const char of line) {
    if (char === "{") balance += 1;
    if (char === "}") balance -= 1;
  }
  return balance;
}

function createFallbackCharacterData() {
  return {
    sections: new Map(fallbackCharacterSections),
    aliases: new Map(fallbackCharacterAliases)
  };
}

function addCharacterAlias(characterData, alias, section) {
  const normalized = alias.trim().toLowerCase();
  if (normalized.length < 3 || normalized === "wip") return;
  const existing = characterData.aliases.get(normalized);
  if (existing && existing !== section) {
    characterData.aliases.delete(normalized);
    return;
  }
  characterData.aliases.set(normalized, section);
}

export function readCharacterData(repoPath) {
  const filePath = join(repoPath, "sync", "ReplicatedStorage", "Shared", "Components", "Data", "Information", "Characters.luau");
  const characterData = createFallbackCharacterData();
  if (!existsSync(filePath)) return characterData;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  let depth = 0;
  let activeKey = "";
  let activeDepth = 0;

  for (const line of lines) {
    const topLevelMatch = depth === 1 ? line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*\{/) : undefined;
    if (topLevelMatch) {
      activeKey = topLevelMatch[1];
      activeDepth = depth + 1;
      characterData.sections.set(activeKey.toLowerCase(), activeKey);
      addCharacterAlias(characterData, activeKey, activeKey);
    }

    if (activeKey && depth >= activeDepth) {
      const section = characterData.sections.get(activeKey.toLowerCase()) ?? activeKey;
      const fullMatch = line.match(/\bFull\s*=\s*['"]([^'"]+)['"]/);
      if (fullMatch) {
        characterData.sections.set(activeKey.toLowerCase(), fullMatch[1]);
        addCharacterAlias(characterData, activeKey, fullMatch[1]);
        addCharacterAlias(characterData, fullMatch[1], fullMatch[1]);
      }
      const fieldPattern = /\b(?:AwakeningName|Name|Vanity|Rename)\s*=\s*['"]([^'"]+)['"]/g;
      for (const match of line.matchAll(fieldPattern)) addCharacterAlias(characterData, match[1], section);
    }

    depth += balanceBraces(line);
    if (activeKey && depth < activeDepth) {
      activeKey = "";
      activeDepth = 0;
    }
  }

  return characterData;
}

function characterSectionForText(text, characterData) {
  const aliases = [...characterData.aliases.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [alias, section] of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text)) return section;
  }
  return undefined;
}

function isToolingOnly(commit) {
  const subject = commit.subject.toLowerCase();
  const paths = allPaths(commit);
  if (hasAny(subject, [/stylua/, /format/, /config/, /readme/, /agents\.md/, /test artifact/, /smoke test/])) return true;
  if (paths.length === 0) return false;
  return paths.every((path) => hasAny(path.toLowerCase(), [
    /(^|\/)\.?vscode(\/|$)/,
    /(^|\/)screenshots\//,
    /\.md$/,
    /\.toml$/,
    /\.json$/,
    /\.spec\.luau$/,
    /package-lock\.json$/,
    /package\.json$/
  ]));
}

function revertedSubjects(commits) {
  const reverted = new Set();
  for (const commit of commits) {
    const match = commit.subject.match(/^Revert "(.+)"$/i);
    if (match) reverted.add(match[1]);
  }
  return reverted;
}

function isVagueSubject(subject) {
  const normalized = subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return !normalized || vagueSubjectPattern.test(normalized);
}

function characterPromptData(characterData) {
  const sections = [...characterData.sections.entries()].map(([key, full]) => ({ key, full }));
  const aliases = [...characterData.aliases.entries()].map(([alias, full]) => ({ alias, full }));
  return { sections, aliases };
}

function draftStyleSample(markdown) {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  return lines.slice(0, Math.min(lines.length, 140)).join("\n");
}

function normalizeModelEntries(parsed, commits) {
  const commitHashes = new Set(commits.map((commit) => commit.shortHash));
  const entries = [];
  const skipped = [];

  for (const skippedItem of parsed.skipped ?? []) {
    skipped.push({
      hash: String(skippedItem.hash ?? ""),
      subject: String(skippedItem.subject ?? ""),
      reason: String(skippedItem.reason ?? "model skipped")
    });
  }

  for (const entry of parsed.entries ?? []) {
    const bulletText = String(entry.bulletText ?? "").trim().replace(/^-\s*/, "");
    const sectionTitle = String(entry.sectionTitle ?? "").trim().replace(/^#+\s*/, "");
    if (!bulletText || !sectionTitle) continue;
    const children = Array.isArray(entry.children)
      ? entry.children.map((child) => String(child).trim().replace(/^-\s*/, "")).filter(Boolean)
      : [];
    const entryCommits = Array.isArray(entry.commits)
      ? entry.commits.map((hash) => String(hash)).filter((hash) => commitHashes.has(hash))
      : [];
    entries.push({ sectionTitle, bulletText, children, commits: entryCommits });
  }

  return { entries, skipped };
}

async function buildEntriesWithCodex(commits, options = {}) {
  const characterData = options.characterData ?? createFallbackCharacterData();
  const draftMarkdown = options.draftMarkdown ?? "";
  const reverted = revertedSubjects(commits);
  const skipped = [];
  const candidates = [];

  for (const commit of commits) {
    if (/^Revert "/i.test(commit.subject)) {
      skipped.push({ hash: commit.shortHash, subject: commit.subject, reason: "revert commit" });
      continue;
    }
    if (reverted.has(commit.subject)) {
      skipped.push({ hash: commit.shortHash, subject: commit.subject, reason: "reverted in range" });
      continue;
    }
    if (isToolingOnly(commit)) {
      skipped.push({ hash: commit.shortHash, subject: commit.subject, reason: "tooling only" });
      continue;
    }
    candidates.push(commit);
  }

  if (candidates.length === 0) return { entries: [], skipped };

  mkdirSync(dirname(entrySchemaPath), { recursive: true });
  writeFileSync(entrySchemaPath, JSON.stringify(entrySchema, null, 2), "utf8");
  const outputPath = join(defaultEditorRoot, "data", "update-log-automation-codex-output.json");

  const prompt = `You are updating a Roblox game's Discord update log.

Return JSON only. Do not edit files. Use the schema.

Rules:
- Use the commit subject only as a weak hint. If the subject is vague or not descriptive, disregard it and infer from the diff, changed paths, and code context.
- If you cannot confidently infer a player-facing change from a commit, skip it. Never write "Changed <vague subject>".
- Keep the same concise style as the current update log. No explanations, no AI-sounding wording.
- Prefer one top-level bullet per meaningful player-facing change.
- Use nested children only for secondary specifics that belong under the same top-level bullet.
- Section titles for character-specific changes must use the current character Full name from character data, without emoji.
- Do not invent changes beyond the diff.
- Skip pure tooling, tests, formatting, or internal-only changes.

Current draft style sample:
${draftStyleSample(draftMarkdown)}

Character data extracted from the game:
${JSON.stringify(characterPromptData(characterData), null, 2)}

Commits to summarize:
${JSON.stringify(candidates.map((commit) => ({
  hash: commit.shortHash,
  subject: commit.subject,
  subjectIsVague: isVagueSubject(commit.subject),
  changedPaths: allPaths(commit),
  patch: commit.patch
})), null, 2)}

Return:
{"entries":[{"sectionTitle":"King Of Curses","bulletText":"Buffed Spiderweb damage from 5 to 7","children":["Reduced Spiderweb ragdoll duration from 10 to 1.5"],"commits":["abc1234"]}],"skipped":[{"hash":"def5678","subject":"format","reason":"tooling only"}]}`;

  const result = await runCommand(
    "codex",
    ["-a", "never", "exec", "--sandbox", "read-only", "--json", "--output-schema", entrySchemaPath, "--output-last-message", outputPath, "-"],
    prompt,
    { cwd: defaultEditorRoot, timeoutMs: 240000 }
  );
  if (result.code !== 0) {
    throw new Error(`Codex summarization failed: ${(result.stderr || result.stdout).slice(0, 4000)}`);
  }
  const parsed = existsSync(outputPath)
    ? JSON.parse(readFileSync(outputPath, "utf8"))
    : extractFinalJson(result.stdout);
  const normalized = normalizeModelEntries(parsed, candidates);

  return { entries: normalized.entries, skipped: [...skipped, ...normalized.skipped] };
}

function signatureFor(entry) {
  return createHash("sha256").update(JSON.stringify({
    sectionTitle: entry.sectionTitle.toLowerCase(),
    bulletText: entry.bulletText.toLowerCase(),
    children: entry.children.map((child) => child.toLowerCase())
  })).digest("hex");
}

function renderEntry(entry) {
  return [`- ${entry.bulletText}`, ...entry.children.map((child) => `  - ${child}`)].join("\n");
}

function appendEntryToMarkdown(rawMarkdown, entry) {
  const normalized = rawMarkdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  const sectionHeader = `### ${entry.sectionTitle}`;
  const existingIndex = lines.findIndex((line) => line.trim().toLowerCase() === sectionHeader.toLowerCase());
  const entryLines = renderEntry(entry).split("\n");

  if (existingIndex >= 0) {
    let insertAt = lines.length;
    for (let index = existingIndex + 1; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith("### ") || trimmed.startsWith("-#")) {
        insertAt = index;
        break;
      }
    }
    while (insertAt > existingIndex + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
    if (insertAt > 0 && lines[insertAt - 1].trim() !== "") {
      lines.splice(insertAt, 0, ...entryLines);
    } else {
      lines.splice(insertAt, 0, ...entryLines);
    }
    return `${lines.join("\n")}\n`;
  }

  const footerIndex = lines.findIndex((line) => line.trim().startsWith("-#"));
  const insertAt = footerIndex >= 0 ? footerIndex : lines.length;
  const needsBlankBefore = insertAt > 0 && lines[insertAt - 1].trim() !== "";
  const newSection = [...(needsBlankBefore ? [""] : []), sectionHeader, ...entryLines, ""];
  lines.splice(insertAt, 0, ...newSection);
  return `${lines.join("\n")}\n`;
}

function appendEntriesToMarkdown(rawMarkdown, entries, knownSignatures) {
  let nextMarkdown = rawMarkdown;
  const added = [];
  const duplicate = [];

  for (const entry of entries) {
    const signature = signatureFor(entry);
    if (knownSignatures.has(signature)) {
      duplicate.push({ ...entry, reason: "posted signature" });
      continue;
    }
    if (nextMarkdown.toLowerCase().includes(entry.bulletText.toLowerCase())) {
      knownSignatures.add(signature);
      duplicate.push({ ...entry, reason: "already in draft" });
      continue;
    }
    nextMarkdown = appendEntryToMarkdown(nextMarkdown, entry);
    knownSignatures.add(signature);
    added.push(entry);
  }

  return { markdown: nextMarkdown, added, duplicate };
}

async function getLatestDraftFile(apiBaseUrl) {
  const body = await fetchJson(`${apiBaseUrl}/api/drafts`);
  const draft = body.drafts?.[0];
  if (!draft) throw new Error("No draft is available to update.");
  const fileBody = await fetchJson(`${apiBaseUrl}/api/drafts/${encodeURIComponent(draft.id)}/file`);
  return { id: draft.id, name: draft.name, filePath: fileBody.filePath ?? draft.filePath };
}

async function importDraftFile(apiBaseUrl, draftId) {
  await fetchJson(`${apiBaseUrl}/api/drafts/${encodeURIComponent(draftId)}/import-file`, { method: "POST" });
}

export async function runAutomation(options = {}) {
  const repoPath = resolve(options.repoPath ?? defaultRepoPath);
  const apiBaseUrl = options.apiBaseUrl ?? defaultApiBaseUrl;
  const statePath = resolve(options.statePath ?? defaultStatePath);
  const editorRoot = resolve(options.editorRoot ?? defaultEditorRoot);
  const seedCurrent = Boolean(options.seedCurrent);
  const state = readState(statePath);
  const head = getHead(repoPath);

  state.repoPath = repoPath;
  state.apiBaseUrl = apiBaseUrl;
  state.lastAttemptedHead = head;

  if (seedCurrent || !state.lastProcessedHead) {
    state.lastProcessedHead = head;
    writeState(statePath, state);
    return { mode: "seed", head, added: [], skipped: [], duplicate: [] };
  }

  if (!isAncestor(repoPath, state.lastProcessedHead, head)) {
    throw new Error(`Stored cursor ${state.lastProcessedHead} is not an ancestor of ${head}. Refusing to guess a history range.`);
  }

  const api = await ensureApi(apiBaseUrl, editorRoot);

  try {
    const draft = await getLatestDraftFile(apiBaseUrl);
    if (!draft.filePath || !existsSync(draft.filePath)) throw new Error(`Draft Markdown file is missing for ${draft.name}.`);
    const originalMarkdown = readFileSync(draft.filePath, "utf8");
    const commits = getCommits(repoPath, state.lastProcessedHead, head);
    const { entries, skipped } = await buildEntriesWithCodex(commits, {
      characterData: readCharacterData(repoPath),
      draftMarkdown: originalMarkdown
    });
    const knownSignatures = new Set(state.postedSignatures);
    const result = appendEntriesToMarkdown(originalMarkdown, entries, knownSignatures);

    if (result.added.length > 0 && result.markdown !== originalMarkdown) {
      writeFileSync(draft.filePath, result.markdown, "utf8");
      await importDraftFile(apiBaseUrl, draft.id);
    }

    state.lastProcessedHead = head;
    state.postedSignatures = [...knownSignatures];
    writeState(statePath, state);
    return { mode: "run", head, draft, commits: commits.length, added: result.added, skipped, duplicate: result.duplicate };
  } finally {
    await api.stop();
  }
}

function printSummary(result) {
  console.log(`Update-log automation ${result.mode} at ${result.head}`);
  if (result.draft) console.log(`Draft: ${result.draft.name} (${result.draft.filePath})`);
  console.log(`Added: ${result.added.length}`);
  for (const entry of result.added) console.log(`- [${entry.sectionTitle}] ${entry.bulletText}`);
  console.log(`Skipped: ${result.skipped.length}`);
  for (const item of result.skipped) console.log(`- [${item.hash}] ${item.subject} (${item.reason})`);
  console.log(`Duplicates: ${result.duplicate.length}`);
  for (const entry of result.duplicate) console.log(`- [${entry.sectionTitle}] ${entry.bulletText} (${entry.reason})`);
}

if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const args = parseArgs(process.argv.slice(2));
  const result = await runAutomation({
    repoPath: args.repo,
    apiBaseUrl: args.api,
    statePath: args.state,
    seedCurrent: args["seed-current"],
    editorRoot: args["editor-root"]
  });
  printSummary(result);
}
