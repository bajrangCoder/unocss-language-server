import { createGenerator } from "@unocss/core";
import presetAttributify from "@unocss/preset-attributify";
import presetWind3 from "@unocss/preset-wind3";
import { describe, expect, it } from "bun:test";
import { getMatchedPositionsFromCode } from "../src/share-common";

const SKIP_COMMENT_RE = new RegExp(
  "(//\\s*?@unocss-skip-start\\s*?|\\/\\*\\s*?@unocss-skip-start\\s*?\\*\\/|<!--\\s*?@unocss-skip-start\\s*?-->)[\\s\\S]*?(//\\s*?@unocss-skip-end\\s*?|\\/\\*\\s*?@unocss-skip-end\\s*?\\*\\/|<!--\\s*?@unocss-skip-end\\s*?-->)",
  "g",
);

describe("parity: directives + attributify", () => {
  it("matches directive utilities and respects skip ranges", async () => {
    const uno = await createGenerator({}, { presets: [presetWind3()] });
    const code = `
.ok {
  @apply text-red-500 font-bold;
}
/* @unocss-skip-start */
.skip {
  @apply text-blue-500;
}
/* @unocss-skip-end */
`;

    const positions = await getMatchedPositionsFromCode(uno, code, "test.css", {
      includeRegex: [/(@apply|--uno|--at-apply)[^;]*;/g],
      excludeRegex: [SKIP_COMMENT_RE],
    });
    const matched = positions.map(([, , text]) => text);

    expect(matched).toContain("text-red-500");
    expect(matched).toContain("font-bold");
    expect(matched).not.toContain("text-blue-500");
  });

  it("ignores transformer-directives when matching source positions", async () => {
    let directivesTransformerRan = false;
    const uno = await createGenerator(
      {
        transformers: [
          {
            name: "@unocss/transformer-directives",
            transform() {
              directivesTransformerRan = true;
              return undefined;
            },
          },
        ],
      },
      { presets: [presetWind3()] },
    );

    const positions = await getMatchedPositionsFromCode(
      uno,
      `<div class="text-green-500"></div>`,
      "index.html",
    );

    expect(directivesTransformerRan).toBeFalse();
    expect(positions.some(([, , text]) => text === "text-green-500")).toBeTrue();
  });

  it("skips non-transformer entries in transformer list without crashing", async () => {
    const uno = await createGenerator(
      {
        transformers: [
          {
            name: "@custom/no-transform",
            // Intentionally no transform() function.
          } as any,
        ],
      },
      { presets: [presetWind3()] },
    );

    const positions = await getMatchedPositionsFromCode(
      uno,
      `<div class="text-green-500"></div>`,
      "index.html",
    );

    expect(positions.some(([, , text]) => text === "text-green-500")).toBeTrue();
  });

  it("matches attributify utilities consistently", async () => {
    const uno = await createGenerator(
      {},
      { presets: [presetWind3(), presetAttributify()] },
    );
    const code = `<div text="red-500" m="t-4" p="x-2"></div>`;
    const positions = await getMatchedPositionsFromCode(uno, code, "index.html");
    const matched = positions.map(([, , text]) => text);

    expect(matched).toContain(`[text="red-500"]`);
    expect(matched).toContain(`[m="t-4"]`);
    expect(matched).toContain(`[p="x-2"]`);
  });
});
