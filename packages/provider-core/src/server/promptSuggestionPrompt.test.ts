import { describe, expect, it } from "vite-plus/test";
import { buildPromptSuggestionPrompt, sanitizePromptSuggestion } from "./promptSuggestionPrompt.ts";

describe("prompt suggestions", () => {
  it("bounds context while preserving the newest conversation in order", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `${index}:` + "x".repeat(10_000),
    }));
    messages.push({ role: "user", text: "Now add cancellation." });
    const { prompt } = buildPromptSuggestionPrompt(messages);
    const context: typeof messages = JSON.parse(prompt.split("\n").at(-1)!);
    expect(context.at(-1)?.text).toBe("Now add cancellation.");
    expect(context.length).toBeLessThanOrEqual(8);
    expect(context.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(16_000);
    expect(context.slice(-2).map((item) => item.role)).toEqual(["assistant", "user"]);
  });

  it.each([null, "", "   ", "first\nsecond", "run\u0000command", "x".repeat(241)])(
    "rejects unusable suggestion %j",
    (input) => expect(sanitizePromptSuggestion(input)).toBeNull(),
  );

  it("keeps a valid next-user message as editable draft text", () => {
    expect(sanitizePromptSuggestion("  Přidej test pro zrušení.  ")).toBe(
      "Přidej test pro zrušení.",
    );
  });
});
