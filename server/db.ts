import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUpdateLog, serializeUpdateLog } from "../shared/markdown";
import { sampleMarkdown } from "../shared/sample";
import { settingsSchema, type AppSettings, type CodexIntakeEntry, type DraftBackupSummary, type DraftRecord, type DraftRetrievalMatch, type DraftSummary, type UpdateLog, type VersionRecord, type VersionSummary } from "../shared/types";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(rootDir, "data");
const dbPath = join(dataDir, "update-log-editor.sqlite");
const draftsDir = join(rootDir, "Drafts");
const legacyDraftsDir = join(dataDir, "drafts");
const draftBackupsDir = join(dataDir, "draft-backups");
const deletedDraftsDir = join(dataDir, "deleted-drafts");
const autosaveVersionLabel = "Autosave";
const maxBackupSnapshotsPerDraft = 160;
const defaultRetrievalLimit = 10;

mkdirSync(dataDir, { recursive: true });
mkdirSync(draftsDir, { recursive: true });
mkdirSync(draftBackupsDir, { recursive: true });
mkdirSync(deletedDraftsDir, { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function nowIso(): string {
  return new Date().toISOString();
}

export function getDraftMarkdownPath(id: string): string {
  return join(draftsDir, `${id}.md`);
}

export function getDraftBackupDir(id: string): string {
  return join(draftBackupsDir, id);
}

export function getDraftLatestBackupPath(id: string): string {
  return join(getDraftBackupDir(id), "latest.md");
}

function getLegacyDraftMarkdownPath(id: string): string {
  return join(legacyDraftsDir, `${id}.md`);
}

function timestampSegment(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeFileSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "snapshot";
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function writeTextFileAtomic(filePath: string, contents: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${nanoid()}.tmp`);
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, filePath);
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function pruneBackupSnapshots(id: string) {
  const backupDir = getDraftBackupDir(id);
  if (!existsSync(backupDir)) return;
  const snapshots = readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "latest.md")
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const fileName of snapshots.slice(maxBackupSnapshotsPerDraft)) {
    unlinkSync(join(backupDir, fileName));
  }
}

function createDraftBackup(id: string, rawMarkdown: string, reason: string) {
  const backupDir = getDraftBackupDir(id);
  mkdirSync(backupDir, { recursive: true });
  const timestamp = nowIso();
  const contentHash = hashString(rawMarkdown);
  const latestPath = getDraftLatestBackupPath(id);
  const latestMetaPath = join(backupDir, "latest.json");
  const previousMeta = existsSync(latestMetaPath)
    ? readJsonFile<{ hash?: string }>(latestMetaPath)
    : undefined;

  writeTextFileAtomic(latestPath, rawMarkdown);
  writeTextFileAtomic(latestMetaPath, JSON.stringify({
    draftId: id,
    reason,
    hash: contentHash,
    rawLength: rawMarkdown.length,
    updatedAt: timestamp,
    latestBackupPath: latestPath
  }, null, 2));

  if (previousMeta?.hash !== contentHash) {
    const snapshotPath = join(backupDir, `${timestampSegment(new Date(timestamp))}-${safeFileSegment(reason)}-${contentHash}.md`);
    writeTextFileAtomic(snapshotPath, rawMarkdown);
    pruneBackupSnapshots(id);
  }
}

function writeDraftMarkdownFile(id: string, rawMarkdown: string, reason = "Draft update") {
  const filePath = getDraftMarkdownPath(id);
  mkdirSync(dirname(filePath), { recursive: true });
  if (existsSync(filePath) && readFileSync(filePath, "utf8") === rawMarkdown) {
    if (!existsSync(getDraftLatestBackupPath(id))) createDraftBackup(id, rawMarkdown, reason);
    return;
  }
  writeTextFileAtomic(filePath, rawMarkdown);
  createDraftBackup(id, rawMarkdown, reason);
}

function updateDraftRecord(id: string, rawMarkdown: string, structured: UpdateLog, name: string, writeFile: boolean): DraftRecord | undefined {
  const existing = db.prepare("SELECT name, raw_markdown, structured_json FROM drafts WHERE id = ?").get(id) as
    | { name: string; raw_markdown: string; structured_json: string }
    | undefined;
  const structuredJson = JSON.stringify(structured);
  if (existing && rawMarkdown.trim().length === 0 && existing.raw_markdown.trim().length > 0) {
    throw new Error("Refusing to replace a non-empty draft with empty Markdown. The existing draft was left untouched.");
  }
  if (existing && existing.name === name && existing.raw_markdown === rawMarkdown && existing.structured_json === structuredJson) {
    return getDraft(id, { skipFileSync: true });
  }
  if (writeFile) writeDraftMarkdownFile(id, rawMarkdown);
  db.prepare(`
    UPDATE drafts
    SET name = ?, raw_markdown = ?, structured_json = ?, updated_at = ?
    WHERE id = ?
  `).run(name, rawMarkdown, structuredJson, nowIso(), id);
  return getDraft(id, { skipFileSync: true });
}

function syncDraftFromMarkdownFile(id: string): DraftRecord | undefined {
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as any | undefined;
  if (!row) return undefined;
  const filePath = getDraftMarkdownPath(id);
  const legacyFilePath = getLegacyDraftMarkdownPath(id);
  if (!existsSync(filePath) && existsSync(legacyFilePath)) {
    writeTextFileAtomic(filePath, readFileSync(legacyFilePath, "utf8"));
  }
  if (!existsSync(filePath)) {
    writeDraftMarkdownFile(id, row.raw_markdown, "Recreated mirror");
    return mapDraft(row);
  }

  const fileStat = statSync(filePath);
  const dbUpdatedMs = Date.parse(row.updated_at);
  if (Number.isFinite(dbUpdatedMs) && fileStat.mtimeMs <= dbUpdatedMs + 500) {
    if (!existsSync(getDraftLatestBackupPath(id))) createDraftBackup(id, row.raw_markdown, "Startup backup");
    return mapDraft(row);
  }

  const rawMarkdown = readFileSync(filePath, "utf8");
  if (rawMarkdown === row.raw_markdown) {
    if (!existsSync(getDraftLatestBackupPath(id))) createDraftBackup(id, rawMarkdown, "Startup backup");
    return mapDraft(row);
  }
  const structured = parseUpdateLog(rawMarkdown).log;
  const draft = updateDraftRecord(id, rawMarkdown, structured, row.name, false);
  if (draft) createVersion(id, rawMarkdown, structured, "File sync");
  return draft;
}

function syncAllDraftFiles() {
  const rows = db.prepare("SELECT id FROM drafts").all() as Array<{ id: string }>;
  for (const row of rows) syncDraftFromMarkdownFile(row.id);
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      raw_markdown TEXT NOT NULL,
      structured_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      raw_markdown TEXT NOT NULL,
      structured_json TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_history (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      instruction TEXT NOT NULL,
      model TEXT NOT NULL,
      summary TEXT NOT NULL,
      before_markdown TEXT NOT NULL,
      after_markdown TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS codex_intake (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      draft_name TEXT NOT NULL,
      section_title TEXT NOT NULL,
      bullet_text TEXT NOT NULL,
      children_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
    );
  `);

  const count = db.prepare("SELECT COUNT(*) as count FROM drafts").get() as { count: number };
  if (count.count === 0) {
    const parsed = parseUpdateLog(sampleMarkdown).log;
    const timestamp = nowIso();
    const id = nanoid();
    db.prepare(`
      INSERT INTO drafts (id, name, raw_markdown, structured_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, "DUELS & HEIAN BIRD UPDATE", sampleMarkdown, JSON.stringify(parsed), timestamp, timestamp);
    db.prepare(`
      INSERT INTO versions (id, draft_id, raw_markdown, structured_json, label, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(nanoid(), id, sampleMarkdown, JSON.stringify(parsed), "Seed version", timestamp);
  }

  syncAllDraftFiles();

  const settings = getSettings();
  saveSettings(settings);
}

function mapDraft(row: any): DraftRecord {
  return {
    id: row.id,
    name: row.name,
    rawMarkdown: row.raw_markdown,
    structured: JSON.parse(row.structured_json),
    filePath: getDraftMarkdownPath(row.id),
    backupPath: getDraftLatestBackupPath(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapVersion(row: any): VersionRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    rawMarkdown: row.raw_markdown,
    structured: JSON.parse(row.structured_json),
    label: row.label,
    createdAt: row.created_at
  };
}

function mapRetrievalCurrent(row: any): DraftRetrievalMatch {
  return {
    source: "current",
    id: row.id,
    draftId: row.id,
    draftName: row.name,
    matchedAt: row.updated_at,
    rawMarkdown: row.raw_markdown,
    structured: JSON.parse(row.structured_json),
    rawLength: row.raw_length ?? row.raw_markdown?.length ?? 0,
    filePath: getDraftMarkdownPath(row.id)
  };
}

function mapRetrievalVersion(row: any): DraftRetrievalMatch {
  return {
    source: "version",
    id: row.id,
    draftId: row.draft_id,
    draftName: row.draft_name,
    label: row.label,
    matchedAt: row.created_at,
    rawMarkdown: row.raw_markdown,
    structured: JSON.parse(row.structured_json),
    rawLength: row.raw_length ?? row.raw_markdown?.length ?? 0,
    filePath: getDraftMarkdownPath(row.draft_id)
  };
}

function mapDraftSummary(row: any): DraftSummary {
  return {
    id: row.id,
    name: row.name,
    filePath: getDraftMarkdownPath(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rawLength: row.raw_length ?? row.raw_markdown?.length ?? 0
  };
}

function mapVersionSummary(row: any): VersionSummary {
  return {
    id: row.id,
    draftId: row.draft_id,
    label: row.label,
    createdAt: row.created_at,
    rawLength: row.raw_length ?? row.raw_markdown?.length ?? 0
  };
}

function mapCodexIntake(row: any): CodexIntakeEntry {
  return {
    id: row.id,
    draftId: row.draft_id,
    draftName: row.draft_name,
    sectionTitle: row.section_title,
    bulletText: row.bullet_text,
    children: JSON.parse(row.children_json),
    source: row.source,
    createdAt: row.created_at
  };
}

export function listDrafts(): DraftRecord[] {
  syncAllDraftFiles();
  return (db.prepare("SELECT * FROM drafts ORDER BY updated_at DESC").all() as any[]).map(mapDraft);
}

export function listDraftSummaries(): DraftSummary[] {
  return (db.prepare(`
    SELECT id, name, created_at, updated_at, length(raw_markdown) AS raw_length
    FROM drafts
    ORDER BY updated_at DESC
  `).all() as any[]).map(mapDraftSummary);
}

export function getDraft(id: string, options: { skipFileSync?: boolean } = {}): DraftRecord | undefined {
  if (!options.skipFileSync) return syncDraftFromMarkdownFile(id);
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
  return row ? mapDraft(row) : undefined;
}

export function createDraft(name: string, rawMarkdown: string, structured?: UpdateLog): DraftRecord {
  const parsed = structured ?? parseUpdateLog(rawMarkdown).log;
  const timestamp = nowIso();
  const id = nanoid();
  db.prepare(`
    INSERT INTO drafts (id, name, raw_markdown, structured_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, rawMarkdown, JSON.stringify(parsed), timestamp, timestamp);
  writeDraftMarkdownFile(id, rawMarkdown, "Created");
  createVersion(id, rawMarkdown, parsed, "Created");
  return getDraft(id, { skipFileSync: true })!;
}

export function updateDraft(id: string, rawMarkdown: string, structured: UpdateLog, name?: string): DraftRecord | undefined {
  const existing = getDraft(id);
  if (!existing) return undefined;
  return updateDraftRecord(id, rawMarkdown, structured, name ?? existing.name, true);
}

export function duplicateDraft(id: string): DraftRecord | undefined {
  const draft = getDraft(id);
  if (!draft) return undefined;
  return createDraft(`${draft.name} Copy`, draft.rawMarkdown, draft.structured);
}

export function deleteDraft(id: string): boolean {
  const draft = getDraft(id);
  if (draft) createDraftBackup(id, draft.rawMarkdown, "Before delete");
  const result = db.prepare("DELETE FROM drafts WHERE id = ?").run(id);
  const filePath = getDraftMarkdownPath(id);
  if (result.changes > 0 && existsSync(filePath)) {
    const deletedPath = join(deletedDraftsDir, `${timestampSegment()}-${id}.md`);
    mkdirSync(dirname(deletedPath), { recursive: true });
    renameSync(filePath, deletedPath);
  }
  return result.changes > 0;
}

export function createVersion(draftId: string, rawMarkdown: string, structured: UpdateLog, label = "Manual save"): VersionRecord {
  const id = nanoid();
  db.prepare(`
    INSERT INTO versions (id, draft_id, raw_markdown, structured_json, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, draftId, rawMarkdown, JSON.stringify(structured), label, nowIso());
  createDraftBackup(draftId, rawMarkdown, label);
  return getVersion(id)!;
}

function pruneAutosaveVersions(draftId: string, settings: Pick<AppSettings, "autosaveHistoryLimit" | "autosaveHistoryMaxBytes">) {
  const rows = db.prepare(`
    SELECT id, length(raw_markdown) + length(structured_json) AS stored_length
    FROM versions
    WHERE draft_id = ? AND label = ?
    ORDER BY created_at DESC
  `).all(draftId, autosaveVersionLabel) as Array<{ id: string; stored_length: number }>;

  const deleteIds: string[] = [];
  let keptCount = 0;
  let keptBytes = 0;
  for (const row of rows) {
    if (keptCount === 0) {
      keptCount = 1;
      keptBytes = row.stored_length;
      continue;
    }
    if (keptCount + 1 > settings.autosaveHistoryLimit || keptBytes + row.stored_length > settings.autosaveHistoryMaxBytes) {
      deleteIds.push(row.id);
      continue;
    }
    keptCount += 1;
    keptBytes += row.stored_length;
  }

  if (!deleteIds.length) return;
  const deleteVersion = db.prepare("DELETE FROM versions WHERE id = ?");
  const deleteMany = db.transaction((ids: string[]) => {
    for (const id of ids) deleteVersion.run(id);
  });
  deleteMany(deleteIds);
}

export function createAutosaveVersion(draft: DraftRecord, settings: AppSettings): VersionRecord | undefined {
  const structuredJson = JSON.stringify(draft.structured);
  const latestVersion = db.prepare(`
    SELECT raw_markdown, structured_json
    FROM versions
    WHERE draft_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(draft.id) as { raw_markdown: string; structured_json: string } | undefined;
  if (latestVersion?.raw_markdown === draft.rawMarkdown && latestVersion.structured_json === structuredJson) {
    pruneAutosaveVersions(draft.id, settings);
    return undefined;
  }

  const latestAutosave = db.prepare(`
    SELECT created_at
    FROM versions
    WHERE draft_id = ? AND label = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(draft.id, autosaveVersionLabel) as { created_at: string } | undefined;
  const latestAutosaveMs = latestAutosave ? Date.parse(latestAutosave.created_at) : NaN;
  if (Number.isFinite(latestAutosaveMs) && Date.now() - latestAutosaveMs < settings.autosaveHistoryIntervalMs) {
    pruneAutosaveVersions(draft.id, settings);
    return undefined;
  }

  const version = createVersion(draft.id, draft.rawMarkdown, draft.structured, autosaveVersionLabel);
  pruneAutosaveVersions(draft.id, settings);
  return version;
}

export function listVersions(draftId: string): VersionRecord[] {
  return (db.prepare("SELECT * FROM versions WHERE draft_id = ? ORDER BY created_at DESC").all(draftId) as any[]).map(mapVersion);
}

export function listVersionSummaries(draftId: string): VersionSummary[] {
  return (db.prepare(`
    SELECT id, draft_id, label, created_at, length(raw_markdown) AS raw_length
    FROM versions
    WHERE draft_id = ?
    ORDER BY created_at DESC
  `).all(draftId) as any[]).map(mapVersionSummary);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveRetrievalDate(when?: string): { date?: string; startIso?: string; endIso?: string } {
  if (!when?.trim()) return {};
  const normalized = when.trim().toLowerCase();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (normalized === "today") {
    // Use today's local midnight.
  } else if (normalized === "yesterday") {
    start.setDate(start.getDate() - 1);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const [year, month, day] = normalized.split("-").map(Number);
    start.setFullYear(year, month - 1, day);
  } else {
    throw new Error("Use when=today, when=yesterday, or when=YYYY-MM-DD.");
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    date: localDateKey(start),
    startIso: start.toISOString(),
    endIso: end.toISOString()
  };
}

export function retrieveDrafts(options: {
  when?: string;
  query?: string;
  draftId?: string;
  source?: "all" | "current" | "versions";
  limit?: number;
} = {}): { resolvedDate?: string; matches: DraftRetrievalMatch[] } {
  syncAllDraftFiles();
  const source = options.source ?? "all";
  const limit = Math.max(1, Math.min(options.limit ?? defaultRetrievalLimit, 50));
  const range = resolveRetrievalDate(options.when);
  const query = options.query?.trim().toLowerCase();

  const matches: DraftRetrievalMatch[] = [];
  const includesQuery = (match: DraftRetrievalMatch) => {
    if (!query) return true;
    return match.draftName.toLowerCase().includes(query) ||
      match.label?.toLowerCase().includes(query) ||
      match.rawMarkdown.toLowerCase().includes(query);
  };

  if (source === "all" || source === "current") {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.draftId) {
      clauses.push("id = ?");
      params.push(options.draftId);
    }
    if (range.startIso && range.endIso) {
      clauses.push("updated_at >= ? AND updated_at < ?");
      params.push(range.startIso, range.endIso);
    }
    const rows = db.prepare(`
      SELECT id, name, raw_markdown, structured_json, created_at, updated_at, length(raw_markdown) AS raw_length
      FROM drafts
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
    `).all(...params) as any[];
    matches.push(...rows.map(mapRetrievalCurrent).filter(includesQuery));
  }

  if (source === "all" || source === "versions") {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.draftId) {
      clauses.push("versions.draft_id = ?");
      params.push(options.draftId);
    }
    if (range.startIso && range.endIso) {
      clauses.push("versions.created_at >= ? AND versions.created_at < ?");
      params.push(range.startIso, range.endIso);
    }
    const rows = db.prepare(`
      SELECT versions.id, versions.draft_id, drafts.name AS draft_name, versions.raw_markdown, versions.structured_json, versions.label, versions.created_at, length(versions.raw_markdown) AS raw_length
      FROM versions
      JOIN drafts ON drafts.id = versions.draft_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY versions.created_at DESC
    `).all(...params) as any[];
    matches.push(...rows.map(mapRetrievalVersion).filter(includesQuery));
  }

  matches.sort((a, b) => Date.parse(b.matchedAt) - Date.parse(a.matchedAt));
  return {
    resolvedDate: range.date,
    matches: matches.slice(0, limit)
  };
}

export function getVersion(id: string): VersionRecord | undefined {
  const row = db.prepare("SELECT * FROM versions WHERE id = ?").get(id);
  return row ? mapVersion(row) : undefined;
}

export function restoreVersion(versionId: string): DraftRecord | undefined {
  const version = getVersion(versionId);
  if (!version) return undefined;
  const current = getDraft(version.draftId);
  if (current && current.rawMarkdown !== version.rawMarkdown) {
    createVersion(current.id, current.rawMarkdown, current.structured, `Before restore: ${version.label}`);
  }
  return updateDraft(version.draftId, version.rawMarkdown, version.structured);
}

export function listDraftBackups(id: string): DraftBackupSummary[] {
  const backupDir = getDraftBackupDir(id);
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "latest.md")
    .map((entry) => {
      const filePath = join(backupDir, entry.name);
      const stat = statSync(filePath);
      const parts = entry.name.replace(/\.md$/, "").split("-");
      const reasonParts = parts.slice(6, -1);
      return {
        fileName: entry.name,
        filePath,
        createdAt: stat.mtime.toISOString(),
        rawLength: stat.size,
        reason: reasonParts.join(" ") || "snapshot"
      };
    })
    .sort((a, b) => b.fileName.localeCompare(a.fileName));
}

export function restoreLatestDraftBackup(id: string): DraftRecord | undefined {
  const draft = getDraft(id);
  if (!draft) return undefined;
  const latestPath = getDraftLatestBackupPath(id);
  if (!existsSync(latestPath)) return undefined;
  const rawMarkdown = readFileSync(latestPath, "utf8");
  const structured = parseUpdateLog(rawMarkdown).log;
  if (draft.rawMarkdown !== rawMarkdown) {
    createVersion(draft.id, draft.rawMarkdown, draft.structured, "Before restore: file backup");
  }
  const restored = updateDraft(id, rawMarkdown, structured, draft.name);
  if (restored) createVersion(restored.id, restored.rawMarkdown, restored.structured, "Recovered from file backup");
  return restored;
}

export function importDraftMarkdownFile(id: string): DraftRecord | undefined {
  return syncDraftFromMarkdownFile(id);
}

export function getSettings(): AppSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined;
  if (!row) return settingsSchema.parse({});
  return settingsSchema.parse(JSON.parse(row.value));
}

export function saveSettings(settings: AppSettings): AppSettings {
  const parsed = settingsSchema.parse(settings);
  db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(parsed));
  return parsed;
}

export function recordAiHistory(input: {
  draftId: string;
  instruction: string;
  model: string;
  summary: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  status: "proposed" | "accepted" | "rejected";
}) {
  db.prepare(`
    INSERT INTO ai_history (id, draft_id, instruction, model, summary, before_markdown, after_markdown, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nanoid(), input.draftId, input.instruction, input.model, input.summary, input.beforeMarkdown, input.afterMarkdown, input.status, nowIso());
}

export function listAiHistory(draftId: string) {
  return db.prepare("SELECT * FROM ai_history WHERE draft_id = ? ORDER BY created_at DESC").all(draftId);
}

export function appendCodexIntake(input: {
  draftId?: string;
  sectionTitle?: string;
  bulletText: string;
  children?: string[];
  source?: string;
}): { draft: DraftRecord; entry: CodexIntakeEntry } | undefined {
  const target = input.draftId ? getDraft(input.draftId) : listDrafts()[0];
  if (!target) return undefined;

  const sectionTitle = (input.sectionTitle?.trim() || "EXTRA").replace(/^#+\s*/, "");
  const bulletText = input.bulletText.trim().replace(/^-\s*/, "");
  const children = (input.children ?? []).map((child) => child.trim().replace(/^-\s*/, "")).filter(Boolean);
  const next = parseUpdateLog(serializeUpdateLog(target.structured)).log;
  let section = next.sections.find((candidate) => candidate.title.toLowerCase() === sectionTitle.toLowerCase());
  if (!section) {
    section = { title: sectionTitle, items: [] };
    next.sections.push(section);
  }
  section.items.push({ text: bulletText, children, footers: [] });

  const rawMarkdown = serializeUpdateLog(next);
  const draft = updateDraft(target.id, rawMarkdown, next, target.name)!;
  createVersion(draft.id, rawMarkdown, next, `Codex intake: ${bulletText.slice(0, 48)}`);

  const id = nanoid();
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO codex_intake (id, draft_id, draft_name, section_title, bullet_text, children_json, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, draft.id, draft.name, sectionTitle, bulletText, JSON.stringify(children), input.source?.trim() || "codex", timestamp);

  return { draft, entry: getCodexIntake(id)! };
}

export function getCodexIntake(id: string): CodexIntakeEntry | undefined {
  const row = db.prepare("SELECT * FROM codex_intake WHERE id = ?").get(id);
  return row ? mapCodexIntake(row) : undefined;
}

export function listCodexIntakeForDay(date: string): CodexIntakeEntry[] {
  return (db.prepare(`
    SELECT * FROM codex_intake
    WHERE substr(created_at, 1, 10) = ?
    ORDER BY created_at DESC
  `).all(date) as any[]).map(mapCodexIntake);
}

export { dbPath, serializeUpdateLog };
