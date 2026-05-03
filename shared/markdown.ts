import type { LogItem, LogSection, UpdateLog } from "./types";

export type ParseResult = {
  log: UpdateLog;
  diagnostics: string[];
};

export function normalizeNewlines(value: string): string {
  return repairMojibake(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

export function repairMojibake(value: string): string {
  return value
    .replace(/\u00e2\u20ac\u2122/g, "'")
    .replace(/\u00e2\u2122/g, "'")
    .replace(/\u00e2\u20ac\u0153/g, '"')
    .replace(/\u00e2\u20ac[\u009d\ufffd]/g, '"')
    .replace(/\u00e2\u20ac\u201c/g, "-")
    .replace(/\u00e2\u20ac\u201d/g, "-")
    .replace(/\u00e2\u20ac\u00a6/g, "...")
    .replace(/\u00e2\u20ac\u00a2/g, "*")
    .replace(/\u00e2\u2014\u00a6/g, "o");
}

export function parseUpdateLog(raw: string): ParseResult {
  const lines = normalizeNewlines(raw).split("\n");
  const diagnostics: string[] = [];
  let title = "";
  let footer = "";
  const sections: LogSection[] = [];
  let currentSection: LogSection | undefined;
  let currentItem: LogItem | undefined;
  const footerLines: string[] = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      diagnostics.push(`Line ${index + 1}: code blocks are preserved in raw Markdown but not editable structurally.`);
      continue;
    }

    if (inCodeBlock || trimmed === "") {
      continue;
    }

    if (line.startsWith("-#")) {
      footerLines.push(line);
      footer = footerLines.join("\n");
      continue;
    }

    if (line.startsWith("  -# ")) {
      if (!currentItem) {
        diagnostics.push(`Line ${index + 1}: subtext line has no parent and was skipped structurally.`);
        continue;
      }
      currentItem.footers ??= [];
      currentItem.footers.push(line.slice(5).trim());
      continue;
    }

    if (line.startsWith("## ") && !line.startsWith("### ")) {
      title = line.slice(3).trim();
      continue;
    }

    if (line.startsWith("### ")) {
      currentSection = { title: line.slice(4).trim(), items: [] };
      sections.push(currentSection);
      currentItem = undefined;
      continue;
    }

    if (line.startsWith("- ")) {
      if (!currentSection) {
        currentSection = { title: "GENERAL", items: [] };
        sections.push(currentSection);
        diagnostics.push(`Line ${index + 1}: created GENERAL section for bullet before first section.`);
      }
      currentItem = { text: line.slice(2).trim(), children: [], footers: [] };
      currentSection.items.push(currentItem);
      continue;
    }

    if (line.startsWith("  - ")) {
      if (!currentItem) {
        diagnostics.push(`Line ${index + 1}: nested bullet has no parent and was skipped structurally.`);
        continue;
      }
      currentItem.children.push(line.slice(4).trim());
      continue;
    }

    diagnostics.push(`Line ${index + 1}: unsupported structure is preserved in raw Markdown only.`);
  }

  if (!title) {
    title = "UNTITLED UPDATE";
    diagnostics.push("Missing ## title; using UNTITLED UPDATE structurally.");
  }

  return { log: { title, sections, footer }, diagnostics };
}

export function serializeUpdateLog(log: UpdateLog): string {
  const clean = (value: string) => repairMojibake(value).trim();
  const lines: string[] = [`## ${clean(log.title)}`];

  for (const section of log.sections) {
    lines.push("", `### ${clean(section.title)}`);
    for (const item of section.items) {
      const text = clean(item.text);
      if (!text) {
        continue;
      }
      lines.push(`- ${text}`);
      for (const child of item.children) {
        const childText = clean(child);
        if (childText) {
          lines.push(`  - ${childText}`);
        }
      }
      for (const footer of item.footers ?? []) {
        const footerText = clean(footer);
        if (footerText) {
          lines.push(`  -# ${footerText.replace(/^-#\s*/, "")}`);
        }
      }
    }
  }

  const footer = repairMojibake(log.footer).trim();
  if (footer) {
    lines.push("", footer);
  }

  return lines.join("\n");
}

export function cloneLog(log: UpdateLog): UpdateLog {
  return {
    title: log.title,
    sections: log.sections.map((section) => ({
      title: section.title,
      items: section.items.map((item) => ({
        text: item.text,
        children: [...item.children],
        footers: [...(item.footers ?? [])]
      }))
    })),
    footer: log.footer
  };
}
