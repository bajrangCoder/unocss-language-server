import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SuggestResult } from "@unocss/core";
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
  documentColor,
  getComplete,
  getGeneratorCache,
  getMatchedPositions,
  hasAttributifyPreset,
  resolveConfig,
  resolvePrettiedCSSByToken,
  resolvePrettiedMarkdownByOffset,
  resolvePrettiedMarkdownByToken,
  resolveCSSByToken,
  setAutocompleteMatchType,
} from "./service.js";
import { getColorString, shouldProvideAutocomplete } from "./utils.js";

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

const SKIP_START_COMMENT = "@unocss-skip-start";
const SKIP_END_COMMENT = "@unocss-skip-end";
const SKIP_COMMENT_RE = new RegExp(
  `(//\\s*?${SKIP_START_COMMENT}\\s*?|\\/\\*\\s*?${SKIP_START_COMMENT}\\s*?\\*\\/|<!--\\s*?${SKIP_START_COMMENT}\\s*?-->)[\\s\\S]*?(//\\s*?${SKIP_END_COMMENT}\\s*?|\\/\\*\\s*?${SKIP_END_COMMENT}\\s*?\\*\\/|<!--\\s*?${SKIP_END_COMMENT}\\s*?-->)`,
  "g",
);
const defaultIdeMatchInclude: RegExp[] = [
  /(['"`])[^\x01]*?\1/g,
  /<[^/?<>0-9$_!"'](?:"[^"]*"|'[^']*'|[^>])+>/g,
  /(@apply|--uno|--at-apply)[^;]*;/g,
];
const defaultIdeMatchExclude: RegExp[] = [SKIP_COMMENT_RE];
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

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let settings: ServerSettings = { ...defaultSettings };
let workspaceRoot = "";

function uriToPath(uri: string) {
  try {
    return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

function getMatchedOptions() {
  if (!settings.strictAnnotationMatch) return undefined;
  return {
    includeRegex: defaultIdeMatchInclude,
    excludeRegex: defaultIdeMatchExclude,
  };
}

function getRemToPxRatio() {
  return settings.remToPxPreview ? settings.remToPxRatio : -1;
}

function getTokenForUtility(value: string) {
  return hasAttributifyPreset() ? [value, `[${value}=""]`] : value;
}

function getWorkspaceRootPath(fallbackPath: string) {
  return workspaceRoot ? uriToPath(workspaceRoot) : path.dirname(fallbackPath);
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
  setAutocompleteMatchType(settings.autocompleteMatchType);
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
        triggerCharacters: ["-", ":", " ", '"', "'"],
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
    void resolveConfig(uriToPath(workspaceRoot)).catch((error: unknown) => {
      connection.console.error(`unocss: failed to load config ${String(error)}`);
    });
  }

  return result;
});

connection.onInitialized(() => {
  connection.console.log("unocss: language server initialized");
});

connection.onDidChangeConfiguration((change) => {
  refreshSettings(change.settings?.unocss);
});

connection.onRequest("unocss/reloadConfig", async () => {
  if (!workspaceRoot) return { success: false };
  try {
    await resolveConfig(uriToPath(workspaceRoot));
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

  let result: SuggestResult | undefined;
  try {
    result = await getComplete(content, cursor);
  } catch (error: unknown) {
    connection.console.error(`unocss: completion failed ${String(error)}`);
  }

  if (!result) return [];

  return result.suggestions.slice(0, settings.autocompleteMaxItems).map(([value, label], i) => {
    const resolved = result.resolveReplacement(value);
    return {
      label,
      kind: CompletionItemKind.Constant,
      data: { i, value },
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
    const value =
      item.data && typeof item.data === "object" && "value" in item.data
        ? String(item.data.value)
        : String(item.label);
    const token = getTokenForUtility(value);
    const ratio = getRemToPxRatio();
    const cssResult = await resolveCSSByToken(token);
    const prettied = await resolvePrettiedCSSByToken(token, ratio);

    const color = getColorString(cssResult.css);
    if (color) {
      item.kind = CompletionItemKind.Color;
      item.detail = prettied.prettified;
      item.documentation = `rgba(${Math.round(color.red * 255)}, ${Math.round(
        color.green * 255,
      )}, ${Math.round(color.blue * 255)}, ${color.alpha})`;
    } else {
      item.documentation = {
        value: await resolvePrettiedMarkdownByToken(token, ratio),
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
  const content = doc.getText();
  const cursor = doc.offsetAt(params.position);
  const positions = await getMatchedPositions(content, id, getMatchedOptions());
  const matched = positions.find(([start, end]) => cursor >= start && cursor <= end);
  const ratio = getRemToPxRatio();

  if (matched) {
    const token = getTokenForUtility(matched[2]);
    return {
      contents: await resolvePrettiedMarkdownByToken(token, ratio),
      range: {
        start: doc.positionAt(matched[0]),
        end: doc.positionAt(matched[1]),
      },
    };
  }

  const markdown = await resolvePrettiedMarkdownByOffset(content, cursor, ratio);
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

  const colors = await documentColor(code, id, getMatchedOptions());
  return colors.map((c) => ({
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
  const positions = await getMatchedPositions(code, id, getMatchedOptions());
  const offset = doc.offsetAt(params.position);
  const matched = positions.find(([start, end]) => start <= offset && end >= offset);

  if (!matched || !matched[2]) return null;
  const targetName = matched[2];

  const cacheMap = getGeneratorCache();
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

    const filePositions = await getMatchedPositions(
      fileContent,
      filePath,
      getMatchedOptions(),
    );

    if (!filePositions.length)
      continue;

    const fileUri = pathToFileURL(filePath).toString();
    const fileDoc = documents.get(fileUri);
    const textDoc =
      fileDoc || TextDocument.create(fileUri, "", 0, fileContent);

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

documents.listen(connection);
connection.listen();
