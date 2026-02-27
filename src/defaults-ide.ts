export const SKIP_START_COMMENT = "@unocss-skip-start";
export const SKIP_END_COMMENT = "@unocss-skip-end";

export const SKIP_COMMENT_RE = new RegExp(
  `(//\\s*?${SKIP_START_COMMENT}\\s*?|\\/\\*\\s*?${SKIP_START_COMMENT}\\s*?\\*\\/|<!--\\s*?${SKIP_START_COMMENT}\\s*?-->)[\\s\\S]*?(//\\s*?${SKIP_END_COMMENT}\\s*?|\\/\\*\\s*?${SKIP_END_COMMENT}\\s*?\\*\\/|<!--\\s*?${SKIP_END_COMMENT}\\s*?-->)`,
  "g",
);

export const defaultIdeMatchInclude: RegExp[] = [
  /(['"`])[^\x01]*?\1/g,
  /<[^/?<>0-9$_!"'](?:"[^"]*"|'[^']*'|[^>])+>/g,
  /(@apply|--uno|--at-apply)[^;]*;/g,
];

export const defaultIdeMatchExclude: RegExp[] = [SKIP_COMMENT_RE];
