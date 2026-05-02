import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUpdateLog, serializeUpdateLog } from "../shared/markdown";
import { sampleMarkdown } from "../shared/sample";
import { settingsSchema, type AppSettings, type CodexIntakeEntry, type DraftRecord, type UpdateLog, type VersionRecord } from "../shared/types";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(rootDir, "data");
const dbPath = join(dataDir, "update-log-editor.sqlite");

mkdirSync(dataDir, { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function nowIso(): string {
  return new Date().toISOString();
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

  const settings = getSettings();
  saveSettings(settings);
}

function mapDraft(row: any): DraftRecord {
  return {
    id: row.id,
    name: row.name,
    rawMarkdown: row.raw_markdown,
    structured: JSON.parse(row.structured_json),
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
  return (db.prepare("SELECT * FROM drafts ORDER BY updated_at DESC").all() as any[]).map(mapDraft);
}

export function getDraft(id: string): DraftRecord | undefined {
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
  createVersion(id, rawMarkdown, parsed, "Created");
  return getDraft(id)!;
}

export function updateDraft(id: string, rawMarkdown: string, structured: UpdateLog, name?: string): DraftRecord | undefined {
  const existing = getDraft(id);
  if (!existing) return undefined;
  db.prepare(`
    UPDATE drafts
    SET name = ?, raw_markdown = ?, structured_json = ?, updated_at = ?
    WHERE id = ?
  `).run(name ?? existing.name, rawMarkdown, JSON.stringify(structured), nowIso(), id);
  return getDraft(id);
}

export function duplicateDraft(id: string): DraftRecord | undefined {
  const draft = getDraft(id);
  if (!draft) return undefined;
  return createDraft(`${draft.name} Copy`, draft.rawMarkdown, draft.structured);
}

export function deleteDraft(id: string): boolean {
  const result = db.prepare("DELETE FROM drafts WHERE id = ?").run(id);
  return result.changes > 0;
}

export function createVersion(draftId: string, rawMarkdown: string, structured: UpdateLog, label = "Manual save"): VersionRecord {
  const id = nanoid();
  db.prepare(`
    INSERT INTO versions (id, draft_id, raw_markdown, structured_json, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, draftId, rawMarkdown, JSON.stringify(structured), label, nowIso());
  return getVersion(id)!;
}

export function listVersions(draftId: string): VersionRecord[] {
  return (db.prepare("SELECT * FROM versions WHERE draft_id = ? ORDER BY created_at DESC").all(draftId) as any[]).map(mapVersion);
}

export function getVersion(id: string): VersionRecord | undefined {
  const row = db.prepare("SELECT * FROM versions WHERE id = ?").get(id);
  return row ? mapVersion(row) : undefined;
}

export function restoreVersion(versionId: string): DraftRecord | undefined {
  const version = getVersion(versionId);
  if (!version) return undefined;
  return updateDraft(version.draftId, version.rawMarkdown, version.structured);
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
