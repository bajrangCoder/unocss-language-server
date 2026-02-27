import { createGenerator } from "@unocss/core";
import presetWind3 from "@unocss/preset-wind3";
import { describe, expect, it } from "bun:test";
import {
  clearAllCache,
  clearDocumentCache,
  getMatchedPositionsFromDoc,
} from "../src/cache";

describe("document match cache", () => {
  it("caches by document id and clears correctly", async () => {
    const uno = await createGenerator({}, { presets: [presetWind3()] });
    const id = "/tmp/cachedoc.html";

    clearAllCache();
    const first = await getMatchedPositionsFromDoc(
      uno,
      `<div class="text-red-500"></div>`,
      id,
      false,
    );
    const second = await getMatchedPositionsFromDoc(
      uno,
      `<div class="text-blue-500"></div>`,
      id,
      false,
    );

    const firstTokens = first.map(([, , token]) => token);
    const secondTokens = second.map(([, , token]) => token);
    expect(firstTokens).toContain("text-red-500");
    expect(secondTokens).toContain("text-red-500");
    expect(secondTokens).not.toContain("text-blue-500");

    clearDocumentCache(id);
    const refreshed = await getMatchedPositionsFromDoc(
      uno,
      `<div class="text-blue-500"></div>`,
      id,
      false,
    );
    const refreshedTokens = refreshed.map(([, , token]) => token);
    expect(refreshedTokens).toContain("text-blue-500");
  });
});
