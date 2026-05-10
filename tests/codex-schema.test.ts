import { describe, expect, it } from "vitest";
import { extractFinalJson } from "../server/codex";
import { codexOutputJsonSchema } from "../shared/codexSchema";
import { aiEditResponseSchema, settingsSchema } from "../shared/types";

describe("AI response schema", () => {
  it("accepts GPT-5.3 Spark as a saved model option", () => {
    const parsed = settingsSchema.parse({
      selectedModelMode: "gpt-5.3-codex-spark",
      customEmojis: [{ name: "Raid", emoji: "\u2694\ufe0f" }]
    });
    expect(parsed.selectedModelMode).toBe("gpt-5.3-codex-spark");
    expect(parsed.customEmojis[0].name).toBe("Raid");
  });

  it("accepts the expected shape", () => {
    const parsed = aiEditResponseSchema.parse({
      summary: "Updated wording.",
      updatedLog: {
        title: "DUELS & HEIAN BIRD UPDATE :EVIL_BIRD:",
        sections: [
          {
            title: "GENERAL",
            items: [
              {
                text: "Added **Domain Clashing**",
                children: ["Using Domain within the same radius as someone causes a clash"]
              }
            ]
          }
        ],
        footer: "-# ||@everyone||"
      }
    });
    expect(parsed.updatedLog.title).toContain(":EVIL_BIRD:");
  });

  it("rejects malformed responses", () => {
    expect(() => aiEditResponseSchema.parse({ summary: "No draft" })).toThrow();
  });

  it("keeps strict object properties listed as required for Codex output", () => {
    const visit = (schema: unknown) => {
      if (!schema || typeof schema !== "object") return;
      const node = schema as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
        items?: unknown;
      };
      if (node.type === "object" && node.properties) {
        expect(new Set(node.required)).toEqual(new Set(Object.keys(node.properties)));
      }
      if (node.items) visit(node.items);
      for (const property of Object.values(node.properties ?? {})) {
        visit(property);
      }
    };

    visit(codexOutputJsonSchema);
  });

  it("extracts Codex item.completed agent messages without being confused by cleanup output", () => {
    const parsed = extractFinalJson([
      JSON.stringify({ type: "thread.started", thread_id: "test" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            summary: "Added responsiveness note.",
            updatedLog: {
              title: "TEST UPDATE",
              sections: [
                {
                  title: "GENERAL",
                  items: [
                    {
                      text: "Moved all skills to client authority for more responsive high-ping play",
                      children: [],
                      footers: []
                    }
                  ]
                }
              ],
              footer: "-# ||@everyone||"
            }
          })
        }
      }),
      JSON.stringify({ type: "turn.completed" }),
      "SUCCESS: The process with PID 123 has been terminated."
    ].join("\n"));

    expect(aiEditResponseSchema.parse(parsed).summary).toBe("Added responsiveness note.");
  });
});
