import { createAutocomplete, searchUsageBoundary } from "@unocss/autocomplete";
import { loadConfig } from "@unocss/config";
import { createGenerator, type UserConfigDefaults } from "@unocss/core";
import presetWind3 from "@unocss/preset-wind3";
import { sourceObjectFields, sourcePluginFactory } from "unconfig/presets";
import type { CompletionItem } from "vscode-languageserver";
import {
  type GetMatchedPositionsOptions,
  getMatchedPositionsFromCode,
} from "./share-common.js";
import { getColorString, getPrettiedCSS, getPrettiedMarkdown } from "./utils.js";

const defaultConfig: UserConfigDefaults = {
  presets: [presetWind3()],
  separators: [],
};

const generator = await createGenerator({}, defaultConfig);
let autocompleteMatchType: "prefix" | "fuzzy" = "prefix";
let autocomplete = createAutocomplete(generator, {
  matchType: autocompleteMatchType,
  throwErrors: false,
});

export async function resolveConfig(rootDir: string) {
  const result = await loadConfig(rootDir, rootDir, [
    sourcePluginFactory({
      files: ["vite.config", "svelte.config", "iles.config"],
      targetModule: "unocss/vite",
      parameters: [{ command: "serve", mode: "development" }],
    }),
    sourcePluginFactory({
      files: ["astro.config"],
      targetModule: "unocss/astro",
    }),
    sourceObjectFields({
      files: "nuxt.config",
      fields: "unocss",
    }),
  ]);

  if (result?.config) {
    await generator.setConfig(result.config, defaultConfig);
  } else {
    // Prevent stale workspace config (e.g. shortcuts) from leaking into new roots.
    await generator.setConfig({}, defaultConfig);
  }

  autocomplete = createAutocomplete(generator, {
    matchType: autocompleteMatchType,
    throwErrors: false,
  });

  return generator.config;
}

export function setAutocompleteMatchType(matchType: "prefix" | "fuzzy") {
  if (autocompleteMatchType === matchType) return;
  autocompleteMatchType = matchType;
  autocomplete = createAutocomplete(generator, {
    matchType: autocompleteMatchType,
    throwErrors: false,
  });
}

function getCompletionValue(item: CompletionItem) {
  if (item.data && typeof item.data === "object" && "value" in item.data)
    return String(item.data.value);

  if (typeof item.insertText === "string") return item.insertText;

  return String(item.label);
}

export const documentColor = async (
  content: string,
  id: string,
  options?: GetMatchedPositionsOptions,
) => {
  const positions = await getMatchedPositionsFromCode(generator, content, id, options);
  const matched = await Promise.all(
    positions.map(async ([start, end, text]) => {
      const css = (
        await generator.generate(text, {
          preflights: false,
          safelist: false,
        })
      ).css;

      const color = getColorString(css);
      if (!color) return;

      return {
        range: { start, end },
        color,
      };
    }),
  );

  return matched.filter((item) => item !== undefined);
};

export function getMatchedPositions(
  content: string,
  id: string,
  options?: GetMatchedPositionsOptions,
) {
  return getMatchedPositionsFromCode(generator, content, id, options);
}

export async function getComplete(content: string, cursor: number) {
  return autocomplete.suggestInFile(content, cursor);
}

export function resolveCSS(item: CompletionItem) {
  return generator.generate(getCompletionValue(item), {
    preflights: false,
    safelist: false,
  });
}

export function resolveCSSByToken(token: string | string[]) {
  return generator.generate(token, {
    preflights: false,
    safelist: false,
  });
}

export async function resolveCSSByOffset(content: string, cursor: number) {
  const boundary = searchUsageBoundary(content, cursor);
  if (!boundary?.content) return "";
  const result = await generator.generate(boundary.content, {
    preflights: false,
    safelist: false,
  });

  return result.css;
}

export function resolvePrettiedCSSByToken(
  token: string | string[],
  remToPxRatio: number,
) {
  return getPrettiedCSS(generator, token, remToPxRatio);
}

export function resolvePrettiedMarkdownByToken(
  token: string | string[],
  remToPxRatio: number,
) {
  return getPrettiedMarkdown(generator, token, remToPxRatio);
}

export async function resolvePrettiedMarkdownByOffset(
  content: string,
  cursor: number,
  remToPxRatio: number,
) {
  const boundary = searchUsageBoundary(content, cursor);
  if (!boundary?.content) return "";
  return getPrettiedMarkdown(generator, boundary.content, remToPxRatio);
}

export function getGeneratorCache() {
  // @ts-expect-error `_cache` was used by older Uno versions.
  return (generator.cache || generator._cache || new Map()) as Map<
    string,
    Array<[unknown, unknown, unknown]> | null
  >;
}

export function hasAttributifyPreset() {
  return generator.config.presets.some(
    (preset) => preset.name === "@unocss/preset-attributify",
  );
}
