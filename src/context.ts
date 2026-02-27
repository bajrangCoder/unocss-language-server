import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  createAutocomplete,
  type AutoCompleteMatchType,
  type UnocssAutocomplete,
} from "@unocss/autocomplete";
import { loadConfig } from "@unocss/config";
import {
  createGenerator,
  type UnoGenerator,
  type UserConfigDefaults,
} from "@unocss/core";
import presetWind3 from "@unocss/preset-wind3";
import { sourceObjectFields, sourcePluginFactory } from "unconfig/presets";
import type { Connection } from "vscode-languageserver";
import { isSubdir } from "./utils.js";

const frameworkConfigRE = /^(?:vite|svelte|astro|iles|nuxt|unocss|uno)\.config/;
const unoConfigRE = /\buno(?:css)?\.config\./;
const excludeFileRE = /[\\/](?:node_modules|dist|\.temp|\.cache)[\\/]/;

export interface UnoContext {
  configDir: string;
  generator: UnoGenerator;
  autocomplete: UnocssAutocomplete;
  configSources: string[];
}

export class ContextManager {
  public ready: Promise<void>;
  public configSources: string[] = [];

  private contextsMap = new Map<string, UnoContext | null>();
  private fileContextCache = new Map<string, UnoContext | undefined>();
  private configExistsCache = new Map<string, string | false>();
  private loadingContexts = new Map<string, Promise<UnoContext | null>>();
  private autocompleteMatchType: AutoCompleteMatchType;

  private readonly defaultConfig: UserConfigDefaults = {
    presets: [presetWind3()],
    separators: [],
  };

  constructor(
    private cwd: string,
    private connection: Connection,
    matchType: AutoCompleteMatchType = "prefix",
  ) {
    this.autocompleteMatchType = matchType;
    this.ready = this.reload();
  }

  private log(message: string) {
    this.connection.console.log(message);
  }

  isTarget(id: string) {
    const contextDirs = Array.from(this.contextsMap.keys());
    if (!contextDirs.length)
      return true;

    return contextDirs.some((contextDir) => id === contextDir || isSubdir(contextDir, id));
  }

  async reload() {
    this.fileContextCache.clear();
    this.configExistsCache.clear();
    this.loadingContexts.clear();
    this.contextsMap.clear();
    this.configSources = [];

    await this.loadContextInDirectory(this.cwd, true);
  }

  setAutocompleteMatchType(matchType: AutoCompleteMatchType) {
    if (this.autocompleteMatchType === matchType)
      return;

    this.autocompleteMatchType = matchType;
    for (const context of this.contextsMap.values()) {
      if (!context)
        continue;
      context.autocomplete = createAutocomplete(context.generator, {
        matchType: this.autocompleteMatchType,
        throwErrors: false,
      });
    }
  }

  async loadContextInDirectory(dir: string, allowDefault = false) {
    const cached = this.contextsMap.get(dir);
    if (cached !== undefined)
      return cached;

    const loading = this.loadingContexts.get(dir);
    if (loading)
      return loading;

    const loadPromise = this.loadContext(dir, allowDefault);
    this.loadingContexts.set(dir, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.loadingContexts.delete(dir);
    }
  }

  private async loadContext(dir: string, allowDefault: boolean) {
    const result = await loadConfig(dir, dir, [
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

    if (!result?.config && !allowDefault) {
      this.contextsMap.set(dir, null);
      return null;
    }

    const generator = await createGenerator({}, this.defaultConfig);
    await generator.setConfig(result?.config || {}, this.defaultConfig);
    const autocomplete = createAutocomplete(generator, {
      matchType: this.autocompleteMatchType,
      throwErrors: false,
    });

    const context: UnoContext = {
      configDir: dir,
      generator,
      autocomplete,
      configSources: result?.sources || [],
    };
    this.contextsMap.set(dir, context);

    if (result?.sources?.length) {
      this.configSources = Array.from(
        new Set([...this.configSources, ...result.sources]),
      );
      this.log(
        `unocss: loaded config from ${result.sources.join(", ")}`,
      );
    } else if (allowDefault) {
      this.log(`unocss: using default config in ${dir}`);
    }

    return context;
  }

  async resolveClosestContext(code: string, file: string): Promise<UnoContext | undefined> {
    if (excludeFileRE.test(file))
      return undefined;

    if (this.fileContextCache.has(file))
      return this.fileContextCache.get(file);

    let resolvedContext: UnoContext | undefined;
    const entries = Array.from(this.contextsMap.entries()).sort(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [configDir, context] of entries) {
      if (!context)
        continue;

      if (file === configDir || isSubdir(configDir, file)) {
        resolvedContext = context;
        break;
      }
    }

    const discoveredConfigDir = await this.findConfigDirectory(path.dirname(file));
    if (
      discoveredConfigDir &&
      (!resolvedContext || discoveredConfigDir.length > resolvedContext.configDir.length)
    ) {
      const discovered = await this.loadContextInDirectory(discoveredConfigDir, false);
      const discoveredContext = discovered || undefined;
      this.fileContextCache.set(file, discoveredContext);
      return discoveredContext;
    }

    if (resolvedContext) {
      this.fileContextCache.set(file, resolvedContext);
      return resolvedContext;
    }

    const rootContext = await this.loadContextInDirectory(this.cwd, true);
    const resolved = rootContext || undefined;
    this.fileContextCache.set(file, resolved);
    return resolved;
  }

  private async findConfigDirectory(startDir: string): Promise<string | undefined> {
    const cached = this.configExistsCache.get(startDir);
    if (cached !== undefined)
      return cached || undefined;

    const root = path.parse(startDir).root;
    const searchedDirs: string[] = [];
    let dir = startDir;

    while (dir !== root && (dir === this.cwd || isSubdir(this.cwd, dir))) {
      searchedDirs.push(dir);

      const found = this.configExistsCache.get(dir);
      if (found !== undefined) {
        this.cacheSearchPath(searchedDirs, found || false);
        return found || undefined;
      }

      if (await this.hasConfigFiles(dir)) {
        this.cacheSearchPath(searchedDirs, dir);
        return dir;
      }

      dir = path.dirname(dir);
    }

    this.cacheSearchPath(searchedDirs, false);
    return undefined;
  }

  private async hasConfigFiles(dir: string) {
    try {
      const files = await readdir(dir, "utf8");
      return files.some((file) => unoConfigRE.test(file) || frameworkConfigRE.test(file));
    } catch {
      return false;
    }
  }

  private cacheSearchPath(dirs: string[], result: string | false) {
    for (const dir of dirs)
      this.configExistsCache.set(dir, result);
  }
}
