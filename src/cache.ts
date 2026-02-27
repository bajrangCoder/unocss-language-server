import type { UnoGenerator } from "@unocss/core";
import { defaultIdeMatchExclude, defaultIdeMatchInclude } from "./defaults-ide.js";
import {
  type GetMatchedPositionsOptions,
  getMatchedPositionsFromCode,
} from "./share-common.js";

type MatchedPositionsResult = ReturnType<typeof getMatchedPositionsFromCode>;

const cache = new Map<string, MatchedPositionsResult>();

function getCacheKey(id: string, strictAnnotationMatch: boolean) {
  return `${strictAnnotationMatch ? "strict" : "default"}:${id}`;
}

export function clearDocumentCache(id: string) {
  cache.delete(getCacheKey(id, false));
  cache.delete(getCacheKey(id, true));
}

export function clearAllCache() {
  cache.clear();
}

export function getMatchedPositionsFromDoc(
  uno: UnoGenerator,
  code: string,
  id: string,
  strictAnnotationMatch = false,
  force = false,
) {
  const cacheKey = getCacheKey(id, strictAnnotationMatch);
  if (force)
    cache.delete(cacheKey);

  if (cache.has(cacheKey))
    return cache.get(cacheKey)!;

  const options: GetMatchedPositionsOptions | undefined = strictAnnotationMatch
    ? {
        includeRegex: defaultIdeMatchInclude,
        excludeRegex: defaultIdeMatchExclude,
      }
    : undefined;

  const result = getMatchedPositionsFromCode(uno, code, id, options);
  cache.set(cacheKey, result);
  return result;
}
