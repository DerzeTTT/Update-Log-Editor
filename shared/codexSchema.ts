export const codexOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "updatedLog"],
  properties: {
    summary: { type: "string" },
    updatedLog: {
      type: "object",
      additionalProperties: false,
      required: ["title", "sections", "footer"],
      properties: {
        title: { type: "string" },
        footer: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "items"],
            properties: {
              title: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["text", "children"],
                  properties: {
                    text: { type: "string" },
                    children: {
                      type: "array",
                      items: { type: "string" }
                    },
                    footers: {
                      type: "array",
                      items: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;
