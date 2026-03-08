import { createGenerator } from "@unocss/core";
import presetWind3 from "@unocss/preset-wind3";
import { describe, expect, it } from "bun:test";
import { getDynamicRuleCompletionCandidates } from "../src/dynamic-rule-completion";

describe("dynamic rule completion fallback", () => {
  it("suggests a capture placeholder for regex-based custom rules", async () => {
    const uno = await createGenerator(
      {
        rules: [
          [/^hello-(.+)$/, ([, value]) => ({ color: value })],
        ],
      },
      { presets: [presetWind3()] },
    );

    const suggestions = getDynamicRuleCompletionCandidates(uno, "hello-");

    expect(suggestions).toContainEqual({
      label: "hello-(capture)",
      insertText: "hello-${1:value}",
      isSnippet: true,
    });
  });

  it("renders numeric captures with a number placeholder", async () => {
    const uno = await createGenerator(
      {
        rules: [
          [/^acme-size-(\d+)$/, ([, value]) => ({ width: `${value}px` })],
        ],
      },
      { presets: [presetWind3()] },
    );

    const suggestions = getDynamicRuleCompletionCandidates(uno, "acme-size-");

    expect(suggestions).toContainEqual({
      label: "acme-size-(number)",
      insertText: "acme-size-${1:0}",
      isSnippet: true,
    });
  });

  it("skips rules that already provide autocomplete metadata", async () => {
    const uno = await createGenerator(
      {
        rules: [
          [/^foo-(.+)$/, ([, value]) => ({ color: value }), { autocomplete: "foo-$colors" }],
        ],
      },
      { presets: [presetWind3()] },
    );

    const suggestions = getDynamicRuleCompletionCandidates(uno, "foo-");

    expect(suggestions).toEqual([]);
  });
});
