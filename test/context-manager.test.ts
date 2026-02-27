import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ContextManager } from "../src/context";
import { getPrettiedMarkdown } from "../src/utils";

describe("context manager", () => {
  let rootDir = "";
  let appDir = "";

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "uno-ls-context-"));
    appDir = path.join(rootDir, "packages", "app");
    await mkdir(appDir, { recursive: true });

    await writeFile(
      path.join(rootDir, "uno.config.mjs"),
      `
export default {
  shortcuts: {
    "site-shortcut": "bg-black text-white px-4 py-2 rounded-md",
  },
};
`.trimStart(),
      "utf8",
    );

    await writeFile(
      path.join(appDir, "uno.config.mjs"),
      `
export default {
  shortcuts: {
    "app-shortcut": "bg-blue-500 text-white px-4 py-2 rounded-md",
  },
};
`.trimStart(),
      "utf8",
    );
  });

  afterAll(async () => {
    if (rootDir)
      await rm(rootDir, { recursive: true, force: true });
  });

  it("resolves the nearest config context for nested projects", async () => {
    const manager = new ContextManager(
      rootDir,
      { console: { log() {}, error() {} } } as any,
    );
    await manager.ready;

    const rootFile = path.join(rootDir, "index.html");
    const appFile = path.join(appDir, "src", "index.html");

    const rootContext = await manager.resolveClosestContext("", rootFile);
    const appContext = await manager.resolveClosestContext("", appFile);

    expect(rootContext).toBeTruthy();
    expect(appContext).toBeTruthy();
    expect(appContext?.configDir).toBe(appDir);

    const rootMarkdown = await getPrettiedMarkdown(
      rootContext!.generator,
      "site-shortcut",
      16,
    );
    const appMarkdown = await getPrettiedMarkdown(
      appContext!.generator,
      "app-shortcut",
      16,
    );
    const appOnRootMarkdown = await getPrettiedMarkdown(
      rootContext!.generator,
      "app-shortcut",
      16,
    );

    expect(rootMarkdown).toContain("```css");
    expect(rootMarkdown).toContain("background-color");
    expect(appMarkdown).toContain("```css");
    expect(appMarkdown).toContain("background-color");
    expect(appOnRootMarkdown).toBe("");
  });
});
