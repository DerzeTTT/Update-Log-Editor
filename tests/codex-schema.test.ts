import { describe, expect, it } from "vitest";
import { aiEditResponseSchema } from "../shared/types";

describe("AI response schema", () => {
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
});
