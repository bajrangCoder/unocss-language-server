import type { DynamicRule, UnoGenerator } from "@unocss/core";

export interface DynamicRuleCompletionCandidate {
  insertText: string;
  isSnippet: boolean;
  label: string;
}

const regexMetaChars = new Set(["(", "[", ".", "*", "+", "?", "{", "|"]);

export function getDynamicRuleCompletionCandidates(
  uno: UnoGenerator,
  input: string,
) {
  if (!input)
    return [];

  const suggestions = new Map<string, DynamicRuleCompletionCandidate>();
  for (const rule of uno.config.rulesDynamic)
    collectRuleSuggestion(rule, input, suggestions);

  return Array.from(suggestions.values());
}

function collectRuleSuggestion(
  rule: DynamicRule,
  input: string,
  suggestions: Map<string, DynamicRuleCompletionCandidate>,
) {
  const meta = rule[2];
  if (meta?.autocomplete)
    return;

  const pattern = stripAnchors(rule[0].source);
  const literalPrefix = readLiteralPrefix(pattern);
  if (!literalPrefix || literalPrefix.value.length < 2)
    return;

  const fullyTypedLiteral = literalPrefix.value.startsWith(input);
  const withinDynamicPart = input.startsWith(literalPrefix.value);
  if (!fullyTypedLiteral && !withinDynamicPart)
    return;

  const remainder = pattern.slice(literalPrefix.consumed);
  const rendered = renderPattern(remainder);
  const label = `${literalPrefix.value}${rendered.label}`;
  const insertText = `${literalPrefix.value}${rendered.snippet}`;
  if (!rendered.label || label === input)
    return;

  suggestions.set(label, {
    insertText,
    isSnippet: rendered.isSnippet,
    label,
  });
}

function stripAnchors(pattern: string) {
  let result = pattern;
  if (result.startsWith("^"))
    result = result.slice(1);
  if (result.endsWith("$"))
    result = result.slice(0, -1);
  return result;
}

function readLiteralPrefix(pattern: string) {
  let value = "";
  let consumed = 0;

  while (consumed < pattern.length) {
    const char = pattern[consumed];

    if (char === "\\") {
      const next = pattern[consumed + 1];
      if (!next || isRegexEscape(next))
        break;

      value += next;
      consumed += 2;
      continue;
    }

    if (regexMetaChars.has(char))
      break;

    value += char;
    consumed += 1;
  }

  return value
    ? { value, consumed }
    : null;
}

function renderPattern(pattern: string) {
  let label = "";
  let snippet = "";
  let placeholderIndex = 1;
  let isSnippet = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "\\") {
      const next = pattern[index + 1];
      if (!next)
        break;

      if (isRegexEscape(next)) {
        const placeholder = placeholderFromEscape(next);
        label += placeholder.label;
        snippet += placeholder.snippet(placeholderIndex);
        placeholderIndex += 1;
        isSnippet = true;
      } else {
        label += next;
        snippet += escapeSnippetText(next);
      }

      index += 1;
      continue;
    }

    if (char === "(") {
      const group = consumeGroup(pattern, index);
      if (!group)
        break;

      const placeholder = placeholderFromGroup(group.content);
      label += placeholder.label;
      snippet += placeholder.snippet(placeholderIndex);
      placeholderIndex += 1;
      isSnippet = true;
      index = skipQuantifier(pattern, group.end);
      continue;
    }

    if (char === "[") {
      const characterClass = consumeCharacterClass(pattern, index);
      if (!characterClass)
        break;

      const placeholder = placeholderFromCharacterClass(characterClass.content);
      label += placeholder.label;
      snippet += placeholder.snippet(placeholderIndex);
      placeholderIndex += 1;
      isSnippet = true;
      index = skipQuantifier(pattern, characterClass.end);
      continue;
    }

    if (char === ".") {
      label += "(capture)";
      snippet += makeSnippet(placeholderIndex, "value");
      placeholderIndex += 1;
      isSnippet = true;
      index = skipQuantifier(pattern, index);
      continue;
    }

    if ("+*?{}".includes(char))
      continue;

    label += char;
    snippet += escapeSnippetText(char);
  }

  return {
    label,
    snippet,
    isSnippet,
  };
}

function consumeGroup(pattern: string, start: number) {
  let depth = 0;
  let content = "";

  for (let index = start; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "\\" && index + 1 < pattern.length) {
      if (depth > 0)
        content += char + pattern[index + 1];
      index += 1;
      continue;
    }

    if (char === "(") {
      depth += 1;
      if (depth > 1)
        content += char;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth === 0)
        return { content, end: index };
      content += char;
      continue;
    }

    if (depth > 0)
      content += char;
  }

  return null;
}

function consumeCharacterClass(pattern: string, start: number) {
  let content = "";

  for (let index = start + 1; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      content += char + pattern[index + 1];
      index += 1;
      continue;
    }

    if (char === "]")
      return { content, end: index };

    content += char;
  }

  return null;
}

function skipQuantifier(pattern: string, index: number) {
  let cursor = index;
  const next = pattern[cursor + 1];
  if (!next)
    return cursor;

  if ("+*?".includes(next))
    cursor += 1;
  else if (next === "{") {
    const close = pattern.indexOf("}", cursor + 2);
    if (close !== -1)
      cursor = close;
  }

  return cursor;
}

function placeholderFromEscape(char: string) {
  if (char === "d")
    return placeholder("(number)", "0");

  return placeholder("(capture)", "value");
}

function placeholderFromGroup(content: string) {
  const normalized = stripGroupPrefix(content);
  const alternatives = splitAlternatives(normalized);
  if (
    alternatives.length > 1
    && alternatives.every((alternative) => isLiteralPattern(alternative))
  ) {
    const values = alternatives.map((alternative) => unescapeLiteral(alternative));
    return placeholder(`(${values.join("|")})`, values[0] || "value");
  }

  if (isNumericPattern(normalized))
    return placeholder("(number)", "0");

  return placeholder("(capture)", "value");
}

function placeholderFromCharacterClass(content: string) {
  if (/^(?:0-9|\\d)+$/.test(content))
    return placeholder("(number)", "0");

  return placeholder("(capture)", "value");
}

function placeholder(label: string, defaultValue: string) {
  return {
    label,
    snippet(index: number) {
      return makeSnippet(index, defaultValue);
    },
  };
}

function makeSnippet(index: number, defaultValue: string) {
  return `\${${index}:${escapeSnippetText(defaultValue)}}`;
}

function escapeSnippetText(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("$", "\\$").replaceAll("}", "\\}");
}

function stripGroupPrefix(content: string) {
  return content.replace(/^\?(?::|=|!|<=|<!)/, "");
}

function splitAlternatives(content: string) {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\\" && index + 1 < content.length) {
      current += char + content[index + 1];
      index += 1;
      continue;
    }

    if (char === "(" || char === "[")
      depth += 1;
    else if (char === ")" || char === "]")
      depth = Math.max(0, depth - 1);

    if (char === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts.filter(Boolean);
}

function isLiteralPattern(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      const next = value[index + 1];
      if (!next)
        return false;
      if (isRegexEscape(next))
        return false;
      index += 1;
      continue;
    }

    if (regexMetaChars.has(char) || ")+*?{}".includes(char))
      return false;
  }

  return true;
}

function unescapeLiteral(value: string) {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      const next = value[index + 1];
      if (isRegexEscape(next))
        return "value";
      result += next;
      index += 1;
      continue;
    }
    result += char;
  }

  return result || "value";
}

function isNumericPattern(value: string) {
  return /^(?:\\d|\[0-9\]|\[\\d\])(?:[+*?]|\{\d+(?:,\d*)?\})?$/.test(value);
}

function isRegexEscape(char: string) {
  return /[dDsSwWbB0-9pPnrtvfuxk]/.test(char);
}
