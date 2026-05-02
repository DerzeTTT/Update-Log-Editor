import { describe, expect, it } from "vitest";
import { splitDiscordMessages } from "../shared/splitter";

describe("Discord splitter", () => {
  it("uses normal, nitro, and custom limits", () => {
    expect(splitDiscordMessages("hello", { mode: "normal" }).limit).toBe(2000);
    expect(splitDiscordMessages("hello", { mode: "nitro" }).limit).toBe(4000);
    expect(splitDiscordMessages("hello", { mode: "custom", customLimit: 1234 }).limit).toBe(1234);
  });

  it("places footer only in the final part", () => {
    const raw = `## Title\n\n### A\n- ${"a".repeat(80)}\n- ${"b".repeat(80)}\n\n-# ||@everyone||`;
    const result = splitDiscordMessages(raw, { mode: "custom", customLimit: 120, footer: "-# ||@everyone||" });
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.slice(0, -1).some((chunk) => chunk.includes("-# ||@everyone||"))).toBe(false);
    expect(result.chunks.at(-1)).toContain("-# ||@everyone||");
  });

  it("adds continuation headers when requested", () => {
    const raw = `## Title\n\n### A\n- ${"a".repeat(80)}\n- ${"b".repeat(80)}`;
    const result = splitDiscordMessages(raw, { mode: "custom", customLimit: 120, title: "Title", continuationHeaders: true });
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks[0]).toContain("## Title, PART 1/");
    expect(result.chunks[1]).toContain("## Title, PART 2/");
  });

  it("does not add continuation headers when the log is not split", () => {
    const result = splitDiscordMessages("## Title\n\n### A\n- Small", { mode: "normal", title: "Title", continuationHeaders: true });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).not.toContain("PART 1/1");
  });

  it("warns when a part exceeds the limit", () => {
    const result = splitDiscordMessages(`## Title\n\n- ${"x".repeat(250)}`, { mode: "custom", customLimit: 100 });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
