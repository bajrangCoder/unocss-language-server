import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolveConfig, resolvePrettiedMarkdownByToken } from "../src/service";

describe("workspace config loading", () => {
  let withConfigDir = "";
  let withoutConfigDir = "";

  beforeAll(async () => {
    withConfigDir = await mkdtemp(path.join(os.tmpdir(), "uno-ls-config-"));
    withoutConfigDir = await mkdtemp(path.join(os.tmpdir(), "uno-ls-empty-"));

    await writeFile(
      path.join(withConfigDir, "uno.config.mjs"),
      `
export default {
  shortcuts: {
    "custom-shortcut": "bg-black text-white px-4 py-2 rounded-md",
  },
};
`.trimStart(),
      "utf8",
    );
  });

  afterAll(async () => {
    if (withConfigDir)
      await rm(withConfigDir, { recursive: true, force: true });
    if (withoutConfigDir)
      await rm(withoutConfigDir, { recursive: true, force: true });
  });

  it("loads custom shortcut from workspace config", async () => {
    await resolveConfig(withConfigDir);

    const markdown = await resolvePrettiedMarkdownByToken("custom-shortcut", 16);
    expect(markdown).toContain("```css");
    expect(markdown).toContain("background-color");
  });

  it("resets to defaults when no workspace config exists", async () => {
    await resolveConfig(withConfigDir);
    await resolveConfig(withoutConfigDir);

    const markdown = await resolvePrettiedMarkdownByToken("custom-shortcut", 16);
    expect(markdown).toBe("");
  });
});
