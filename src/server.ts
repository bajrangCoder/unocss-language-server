import type { SuggestResult } from "@unocss/core";
import beautify from "js-beautify";
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
  type TextDocumentPositionParams,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  documentColor,
  getComplete,
  resolveConfig,
  resolveCSS,
  resolveCSSByOffset,
} from "./service.js";
import { getColorString } from "./utils.js";

const connection = createConnection(ProposedFeatures.all);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability =
    !!capabilities.textDocument?.publishDiagnostics?.relatedInformation;

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true,
      },
      hoverProvider: true,
      documentHighlightProvider: false,
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

  let rootDir = "";
  if (hasWorkspaceFolderCapability && params.workspaceFolders[0]) {
    rootDir = params.workspaceFolders[0].uri || params.workspaceFolders[0].name;
  }

  if (!rootDir && params.rootUri) {
    rootDir = params.rootUri;
  }

  if (rootDir) {
    resolveConfig(rootDir);
  }

  return result;
});

connection.console.log("unocss: before add onCompletion listener");
connection.onCompletion(
  async (
    _textDocumentPosition: TextDocumentPositionParams,
  ): Promise<CompletionItem[]> => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    connection.console.log("unocss: onCompletion start");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const doc = documents.get(_textDocumentPosition.textDocument.uri);
    const content = doc?.getText();
    const cursor = doc?.offsetAt(_textDocumentPosition.position);
    connection.console.log("unocss: onCompletion get content and cursor");

    if (!content || cursor === undefined) {
      return [];
    }
    let result: SuggestResult;
    try {
      result = await getComplete(content, cursor);
    } catch (e) {
      connection.console.log(`unocss:${e.message}${e.stack}`);
    }
    connection.console.log("unocss: onCompletion getComplete");

    if (!result) {
      return [];
    }

    const ret = result.suggestions.map((s, i) => {
      const resolved = result.resolveReplacement(s[0]);
      return {
        label: s[0],
        kind: CompletionItemKind.Constant,
        data: i,
        textEdit: {
          newText: resolved.replacement,
          range: Range.create(
            doc.positionAt(resolved.start),
            doc.positionAt(resolved.end),
          ),
        },
      };
    });

    connection.console.log("unocss: onCompletion return");
    return ret;
  },
);
connection.console.log("unocss: after add listener");

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
  async (item: CompletionItem): Promise<CompletionItem> => {
    const result = await resolveCSS(item);
    const css = result.css;
    item.documentation = {
      value: `\`\`\`css\n${beautify.css(css)}\n\`\`\``,
      kind: MarkupKind.Markdown,
    };
    const color = getColorString(css);
    if (color) {
      item.kind = CompletionItemKind.Color;
      item.detail = `rgba(${color.red * 255}, ${color.green * 255}, ${color.blue * 255}, ${color.alpha})`;
    }

    return item;
  },
);

connection.onHover(async (params): Promise<Hover> => {
  const doc = documents.get(params.textDocument.uri);
  const content = doc?.getText();
  const cursor = doc?.offsetAt(params.position);
  const css = (await resolveCSSByOffset(content, cursor)).css;
  return {
    contents: css && `\`\`\`css\n${beautify.css(css)}\n\`\`\``,
  };
});

connection.onDocumentColor(async (args) => {
  connection.console.log(" document color request");
  const uri = args.textDocument.uri;
  const doc = documents.get(uri);
  const colors = await documentColor(doc.getText(), uri);
  return colors.map((c) => {
    return {
      color: c.color,
      range: {
        start: doc.positionAt(c.range.start),
        end: doc.positionAt(c.range.end),
      },
    };
  });
});

documents.listen(connection);
connection.listen();
