import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { searchAttrKey, searchUsageBoundary } from "@unocss/autocomplete";
import type { SuggestResult, UnoGenerator } from "@unocss/core";
import {
  type CompletionItem,
  CompletionItemKind,
  createConnection,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  MarkupKind,
  ProposedFeatures,
  Range,
  type ReferenceParams,
  TextDocumentSyncKind,
  TextDocuments,
  type Location,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  clearAllCache,
  clearDocumentCache,
  getMatchedPositionsFromDoc,
} from "./cache.js";
import { ContextManager, type UnoContext } from "./context.js";
import {
  getAttributifyCandidates,
  getColorString,
  getPrettiedCSS,
  getPrettiedMarkdown,
  shouldProvideAutocomplete,
  throttle,
} from "./utils.js";

interface ServerSettings {
  colorPreview: boolean;
  strictAnnotationMatch: boolean;
  remToPxPreview: boolean;
  remToPxRatio: number;
  autocompleteMatchType: "prefix" | "fuzzy";
  autocompleteStrict: boolean;
  autocompleteMaxItems: number;
}

const defaultSettings: ServerSettings = {
  colorPreview: true,
  strictAnnotationMatch: false,
  remToPxPreview: true,
  remToPxRatio: 16,
  autocompleteMatchType: "prefix",
  autocompleteStrict: false,
  autocompleteMaxItems: 1000,
};

const workspaceFileExtensions = new Set([
  ".vue",
  ".html",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".svelte",
  ".astro",
  ".elm",
  ".php",
  ".phtml",
  ".mdx",
  ".md",
  ".marko",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".stylus",
]);
const excludedDirs = new Set([
  "node_modules",
  ".git",
  "dist",
  ".output",
  ".cache",
  "cache",
  ".turbo",
  ".next",
  ".nuxt",
]);
const maxWorkspaceReferenceFiles = 3000;
const completionTriggerCharacters = [
  "-",
  ":",
  " ",
  '"',
  "'",
  "=",
  ".",
  "/",
  "!",
  "[",
  "]",
  "(",
  ")",
  ...("abcdefghijklmnopqrstuvwxyz0123456789".split("")),
];
const configFileRE = new RegExp(
  String.raw`(?:^|[\\/])(?:uno|unocss|vite|svelte|astro|iles|nuxt)\.config\.(?:[cm]?[jt]s)$`,
);

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let settings: ServerSettings = { ...defaultSettings };
let workspaceRoot = "";
let contextManager: ContextManager | undefined;

const throttledReloadConfig = throttle(async () => {
  if (!contextManager) return;
  try {
    clearAllCache();
    await contextManager.reload();
    connection.console.log("unocss: config reloaded");
  } catch (error: unknown) {
    connection.console.error(`unocss: failed to reload config ${String(error)}`);
  }
}, 300);

function uriToPath(uri: string) {
  try {
    return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

function getRemToPxRatio() {
  return settings.remToPxPreview ? settings.remToPxRatio : -1;
}

function hasAttributifyPreset(context: UnoContext) {
  return context.generator.config.presets.some(
    (preset) => preset.name === "@unocss/preset-attributify",
  );
}

function getTokenForUtility(context: UnoContext, value: string) {
  if (!hasAttributifyPreset(context))
    return value;

  // Expand only true attributify selector tokens (e.g. [bg="blue-400"]).
  // Plain class tokens like "flex" should keep class-only preview.
  const attributifyCandidates = getAttributifyCandidates(value);
  return attributifyCandidates || value;
}

function getWorkspaceRootPath(fallbackPath: string) {
  return workspaceRoot ? uriToPath(workspaceRoot) : path.dirname(fallbackPath);
}

function getTokenAtOffset(code: string, offset: number) {
  if (offset < 0 || offset > code.length) return null;

  const isBoundary = (char: string) => /[\s"'`<>=(){}]/.test(char);

  let start = offset;
  while (start > 0 && !isBoundary(code[start - 1]))
    start--;

  let end = offset;
  while (end < code.length && !isBoundary(code[end]))
    end++;

  const token = code.slice(start, end).trim();
  if (!token) return null;

  return { token, start, end };
}

function buildTokenCompletionItems(
  context: UnoContext,
  doc: TextDocument,
  uri: string,
  content: string,
  cursor: number,
) {
  const tokenAtCursor = getTokenAtOffset(content, cursor);
  if (!tokenAtCursor?.token)
    return null;

  const token = tokenAtCursor.token;
  const attrKey = searchAttrKey(content, cursor) || undefined;

  let query = token;
  let variantsPrefix = "";

  if (attrKey) {
    const parts = token.split(":");
    const base = parts[parts.length - 1];
    variantsPrefix = parts.slice(0, -1).join(":");
    query = variantsPrefix
      ? `${variantsPrefix}:${attrKey}-${base}`
      : `${attrKey}-${base}`;
  }

  return context.autocomplete
    .suggest(query, true)
    .then((suggestions) => {
      if (!suggestions.length)
        return null;

      const withVariantsPrefix = variantsPrefix ? `${variantsPrefix}:` : "";
      const attributifyPrefix = attrKey ? `${withVariantsPrefix}${attrKey}-` : "";

      return suggestions
        .slice(0, settings.autocompleteMaxItems)
        .map((value, i) => {
          const replacement = attrKey && value.startsWith(attributifyPrefix)
            ? `${withVariantsPrefix}${value.slice(attributifyPrefix.length)}`
            : value;

          return {
            label: replacement,
            kind: CompletionItemKind.Constant,
            data: { i, value: replacement, uri },
            filterText: replacement,
            textEdit: {
              newText: replacement,
              range: Range.create(
                doc.positionAt(tokenAtCursor.start),
                doc.positionAt(tokenAtCursor.end),
              ),
            },
          };
        });
    })
    .catch(() => null);
}

function isReferenceCandidateFile(filePath: string) {
  return workspaceFileExtensions.has(path.extname(filePath).toLowerCase());
}

async function collectWorkspaceFiles(rootPath: string, limit: number) {
  const files: string[] = [];
  const queue: string[] = [rootPath];

  while (queue.length && files.length < limit) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!excludedDirs.has(entry.name))
          queue.push(fullPath);
        continue;
      }

      if (!entry.isFile())
        continue;

      if (!isReferenceCandidateFile(fullPath))
        continue;

      files.push(fullPath);
      if (files.length >= limit)
        break;
    }
  }

  return files;
}

async function readWorkspaceDocument(filePath: string) {
  const uri = pathToFileURL(filePath).toString();
  const openDoc = documents.get(uri);
  if (openDoc)
    return openDoc.getText();

  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function refreshSettings(unocssSettings: Record<string, any> | undefined) {
  const remToPxRatioRaw =
    unocssSettings?.remToPxRatio ?? defaultSettings.remToPxRatio;
  const remToPxRatio = Number.isFinite(Number(remToPxRatioRaw))
    ? Number(remToPxRatioRaw)
    : defaultSettings.remToPxRatio;

  settings = {
    ...defaultSettings,
    ...(unocssSettings || {}),
    remToPxPreview:
      unocssSettings?.remToPxPreview ?? defaultSettings.remToPxPreview,
    remToPxRatio,
    autocompleteMatchType:
      unocssSettings?.autocomplete?.matchType ??
      unocssSettings?.autocompleteMatchType ??
      defaultSettings.autocompleteMatchType,
    autocompleteStrict:
      unocssSettings?.autocomplete?.strict ??
      unocssSettings?.autocompleteStrict ??
      defaultSettings.autocompleteStrict,
    autocompleteMaxItems:
      unocssSettings?.autocomplete?.maxItems ??
      unocssSettings?.autocompleteMaxItems ??
      defaultSettings.autocompleteMaxItems,
  };

  contextManager?.setAutocompleteMatchType(settings.autocompleteMatchType);
}

function getGeneratorCache(uno: UnoGenerator) {
  // @ts-expect-error `_cache` was used by older Uno versions.
  return (uno.cache || uno._cache || new Map()) as Map<
    string,
    Array<[unknown, unknown, unknown]> | null
  >;
}

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;
  const hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: completionTriggerCharacters,
      },
      hoverProvider: true,
      documentHighlightProvider: false,
      referencesProvider: true,
      colorProvider: true,
    },
  };

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }

  if (hasWorkspaceFolderCapability && params.workspaceFolders?.[0]) {
    workspaceRoot = params.workspaceFolders[0].uri || params.workspaceFolders[0].name;
  } else if (params.rootUri) {
    workspaceRoot = params.rootUri;
  } else if (params.rootPath) {
    workspaceRoot = params.rootPath;
  }

  if (workspaceRoot) {
    contextManager = new ContextManager(
      uriToPath(workspaceRoot),
      connection,
      settings.autocompleteMatchType,
    );
  }

  return result;
});

connection.onInitialized(async () => {
  if (contextManager)
    await contextManager.ready;
  connection.console.log("unocss: language server initialized");
});

connection.onDidChangeConfiguration((change) => {
  refreshSettings(change.settings?.unocss);
});

connection.onDidChangeWatchedFiles((event) => {
  if (!event.changes.some((change) => configFileRE.test(uriToPath(change.uri))))
    return;
  void throttledReloadConfig();
});

connection.onRequest("unocss/reloadConfig", async () => {
  if (!contextManager) return { success: false };
  try {
    clearAllCache();
    await contextManager.reload();
    return { success: true };
  } catch {
    return { success: false };
  }
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const id = uriToPath(params.textDocument.uri);
  const content = doc.getText();
  const cursor = doc.offsetAt(params.position);

  if (
    settings.autocompleteStrict &&
    !shouldProvideAutocomplete(content, id, cursor)
  ) {
    return [];
  }

  const context = await contextManager?.resolveClosestContext(content, id);
  if (!context) return [];

  const fastItems = await buildTokenCompletionItems(
    context,
    doc,
    params.textDocument.uri,
    content,
    cursor,
  );
  if (fastItems?.length)
    return fastItems;

  let result: SuggestResult | undefined;
  try {
    result = await context.autocomplete.suggestInFile(content, cursor);
  } catch (error: unknown) {
    connection.console.error(`unocss: completion failed ${String(error)}`);
  }

  if (!result || !result.suggestions.length)
    return [];

  return result.suggestions.slice(0, settings.autocompleteMaxItems).map(([value, label], i) => {
    const resolved = result.resolveReplacement(value);
    return {
      label,
      kind: CompletionItemKind.Constant,
      data: { i, value, uri: params.textDocument.uri },
      filterText: value,
      textEdit: {
        newText: resolved.replacement,
        range: Range.create(
          doc.positionAt(resolved.start),
          doc.positionAt(resolved.end),
        ),
      },
    };
  });
});

connection.onCompletionResolve(
  async (item: CompletionItem): Promise<CompletionItem> => {
    if (!(item.data && typeof item.data === "object" && "uri" in item.data && "value" in item.data))
      return item;

    const uri = String(item.data.uri);
    const value = String(item.data.value);
    const doc = documents.get(uri);
    if (!doc) return item;

    const id = uriToPath(uri);
    const content = doc.getText();
    const context = await contextManager?.resolveClosestContext(content, id);
    if (!context) return item;

    const token = getTokenForUtility(context, value);
    const ratio = getRemToPxRatio();
    const cssResult = await context.generator.generate(token, {
      preflights: false,
      safelist: false,
    });
    const prettied = await getPrettiedCSS(context.generator, token, ratio);

    const color = getColorString(cssResult.css);
    if (color) {
      item.kind = CompletionItemKind.Color;
      item.detail = prettied.prettified;
      item.documentation = `rgba(${Math.round(color.red * 255)}, ${Math.round(
        color.green * 255,
      )}, ${Math.round(color.blue * 255)}, ${color.alpha})`;
    } else {
      item.documentation = {
        value: await getPrettiedMarkdown(context.generator, token, ratio),
        kind: MarkupKind.Markdown,
      };
    }

    return item;
  },
);

connection.onHover(async (params): Promise<Hover | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const uri = params.textDocument.uri;
  const id = uriToPath(uri);
  if (!contextManager?.isTarget(id))
    return null;

  const content = doc.getText();
  const cursor = doc.offsetAt(params.position);
  const context = await contextManager.resolveClosestContext(content, id);
  if (!context) return null;

  const positions = await getMatchedPositionsFromDoc(
    context.generator,
    content,
    id,
    settings.strictAnnotationMatch,
  );
  const matched = positions.find(([start, end]) => cursor >= start && cursor <= end);
  const ratio = getRemToPxRatio();

  if (matched) {
    const token = getTokenForUtility(context, matched[2]);
    const markdown = await getPrettiedMarkdown(context.generator, token, ratio);
    if (!markdown) return null;

    return {
      contents: markdown,
      range: {
        start: doc.positionAt(matched[0]),
        end: doc.positionAt(matched[1]),
      },
    };
  }

  const tokenAtCursor = getTokenAtOffset(content, cursor);
  if (tokenAtCursor) {
    const token = getTokenForUtility(context, tokenAtCursor.token);
    const markdown = await getPrettiedMarkdown(context.generator, token, ratio);
    if (markdown) {
      return {
        contents: markdown,
        range: {
          start: doc.positionAt(tokenAtCursor.start),
          end: doc.positionAt(tokenAtCursor.end),
        },
      };
    }
  }

  const boundary = searchUsageBoundary(content, cursor);
  if (!boundary?.content)
    return null;

  const markdown = await getPrettiedMarkdown(context.generator, boundary.content, ratio);
  if (!markdown) return null;

  return {
    contents: markdown,
  };
});

connection.onDocumentColor(async (params) => {
  if (!settings.colorPreview) return [];

  const uri = params.textDocument.uri;
  const id = uriToPath(uri);
  const doc = documents.get(uri);
  if (!doc) return [];

  const code = doc.getText();
  if (!code) return [];

  const context = await contextManager?.resolveClosestContext(code, id);
  if (!context)
    return [];

  const positions = await getMatchedPositionsFromDoc(
    context.generator,
    code,
    id,
    settings.strictAnnotationMatch,
  );
  const matched = await Promise.all(
    positions.map(async ([start, end, text]) => {
      const token = getTokenForUtility(context, text);
      const css = (
        await context.generator.generate(token, {
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

  return matched
    .filter((item) => item !== undefined)
    .map((c) => ({
      color: c.color,
      range: {
        start: doc.positionAt(c.range.start),
        end: doc.positionAt(c.range.end),
      },
    }));
});

connection.onColorPresentation((params) => {
  const { color } = params;
  const r = Math.round(color.red * 255);
  const g = Math.round(color.green * 255);
  const b = Math.round(color.blue * 255);
  return [{ label: `rgb(${r} ${g} ${b})` }];
});

connection.onReferences(async (params: ReferenceParams): Promise<Location[] | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const id = uriToPath(params.textDocument.uri);
  const code = doc.getText();
  const context = await contextManager?.resolveClosestContext(code, id);
  if (!context)
    return null;

  const positions = await getMatchedPositionsFromDoc(
    context.generator,
    code,
    id,
    settings.strictAnnotationMatch,
  );
  const offset = doc.offsetAt(params.position);
  const matched = positions.find(([start, end]) => start <= offset && end >= offset);

  if (!matched || !matched[2]) return null;
  const targetName = matched[2];

  const cacheMap = getGeneratorCache(context.generator);
  const target = cacheMap.get(targetName) || null;
  const names = new Set([targetName]);

  if (target) {
    const targetSignature = target.map((item) => item[2]).join("|");
    for (const [name, utilities] of cacheMap.entries()) {
      if (!utilities) continue;
      const signature = utilities.map((item) => item[2]).join("|");
      if (signature === targetSignature) names.add(name);
    }
  }
  const workspacePath = getWorkspaceRootPath(id);
  const filePaths = await collectWorkspaceFiles(
    workspacePath,
    maxWorkspaceReferenceFiles,
  );

  if (!filePaths.includes(id))
    filePaths.push(id);

  const locations: Location[] = [];

  for (const filePath of filePaths) {
    const fileContent = await readWorkspaceDocument(filePath);
    if (!fileContent)
      continue;

    const fileUri = pathToFileURL(filePath).toString();
    const openDoc = documents.get(fileUri);
    const fileContext = filePath === id
      ? context
      : await contextManager?.resolveClosestContext(fileContent, filePath);
    if (!fileContext)
      continue;

    const filePositions = await getMatchedPositionsFromDoc(
      fileContext.generator,
      fileContent,
      filePath,
      settings.strictAnnotationMatch,
      !openDoc,
    );

    if (!filePositions.length)
      continue;

    const textDoc =
      openDoc || TextDocument.create(fileUri, "", 0, fileContent);

    for (const [start, end, text] of filePositions) {
      if (!names.has(text))
        continue;

      locations.push({
        uri: fileUri,
        range: {
          start: textDoc.positionAt(start),
          end: textDoc.positionAt(end),
        },
      });
    }
  }

  return locations;
});

documents.onDidChangeContent((change) => {
  clearDocumentCache(uriToPath(change.document.uri));
});

documents.onDidClose((event) => {
  clearDocumentCache(uriToPath(event.document.uri));
});

documents.listen(connection);
connection.listen();
