import { describe, expect, it } from "vitest";
import { parseUpdateLog, serializeUpdateLog } from "../shared/markdown";
import { sampleMarkdown } from "../shared/sample";

describe("update log markdown", () => {
  it("parses the sample draft title, sections, bullets, nested bullets, and footer", () => {
    const { log } = parseUpdateLog(sampleMarkdown);
    expect(log.title).toBe("DUELS & HEIAN BIRD UPDATE :EVIL_BIRD:");
    expect(log.sections.length).toBeGreaterThan(5);
    expect(log.sections[0].title).toBe("GENERAL");
    expect(log.sections[0].items[0].text).toBe("Added **Domain Clashing**");
    expect(log.sections[0].items[0].children[0]).toContain("causes everyone’s Domains to clash");
    expect(log.footer).toBe("-# ||@everyone||");
  });

  it("serializes to stable Discord markdown", () => {
    const { log } = parseUpdateLog(sampleMarkdown);
    const serialized = serializeUpdateLog(log);
    expect(serialized).toContain("## DUELS & HEIAN BIRD UPDATE :EVIL_BIRD:");
    expect(serialized).toContain("### HONORED BIRD :HONORED_BIRD:");
    expect(serialized).toContain("  - Hollow Purple has special compatibility too");
    expect(serialized.endsWith("-# ||@everyone||")).toBe(true);
  });

  it("preserves emoji aliases without replacement", () => {
    const markdown = "## Test :star:\n\n### GENERAL\n- Added :EVIL_BIRD:\n- Fixed :HONORED_BIRD:\n\n-# ||@everyone||";
    const { log } = parseUpdateLog(markdown);
    expect(serializeUpdateLog(log)).toContain(":star:");
    expect(serializeUpdateLog(log)).toContain(":EVIL_BIRD:");
    expect(serializeUpdateLog(log)).toContain(":HONORED_BIRD:");
  });
});
