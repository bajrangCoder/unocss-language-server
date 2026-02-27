import { createGenerator } from "@unocss/core";
import presetAttributify from "@unocss/preset-attributify";
import presetWind3 from "@unocss/preset-wind3";
import { describe, expect, it } from "bun:test";
import { getAttributifyCandidates, getPrettiedMarkdown } from "../src/utils";

describe("hover preview formatting", () => {
  it("formats generated css blocks (not inline)", async () => {
    const uno = await createGenerator({}, { presets: [presetWind3()] });
    const markdown = await getPrettiedMarkdown(uno, "flex", 16);

    expect(markdown).toContain("```css");
    expect(markdown).toContain(".flex {");
    expect(markdown).toContain("display: flex;");
  });

  it("returns empty markdown for non-unocss tokens", async () => {
    const uno = await createGenerator({}, { presets: [presetWind3()] });
    const markdown = await getPrettiedMarkdown(uno, "___not_a_uno_token___", 16);

    expect(markdown).toBe("");
  });

  it("generates non-empty markdown for custom shortcuts", async () => {
    const uno = await createGenerator(
      {
        shortcuts: {
          "my-shortcut": "bg-blue-500 text-white p-2 rounded",
        },
      },
      { presets: [presetWind3()] },
    );
    const markdown = await getPrettiedMarkdown(uno, "my-shortcut", 16);

    expect(markdown).toContain("```css");
    expect(markdown.length).toBeGreaterThan(12);
    expect(markdown).toContain("background-color");
  });

  it("generates hover markdown for attributify selector tokens", async () => {
    const uno = await createGenerator(
      {},
      { presets: [presetWind3(), presetAttributify()] },
    );
    const token = getAttributifyCandidates(`[bg="dark:hover:blue-600"]`)!;
    const markdown = await getPrettiedMarkdown(uno, token, 16);

    expect(markdown).toContain("```css");
    expect(markdown).toContain("background-color");
    expect(markdown).toContain("dark");
  });
});
