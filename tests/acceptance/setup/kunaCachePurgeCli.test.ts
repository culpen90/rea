import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest
  .runIf(process.platform === "linux" || process.platform === "darwin")
  .for([
    { label: "default directory alias", suffix: "/" },
    { label: "literal POSIX backslash", suffix: "\\" },
  ])(
  "retains legacy Kuna cache during purge for $label",
  async ({ suffix }, { cli }) => {
    const home = await createTestTempDirectory("rea-kuna-purge-cli-");
    const cacheRoot = join(
      home,
      process.platform === "darwin" ? "Library/Caches" : "cache",
    );
    const cache = join(cacheRoot, "rea", "kuna");
    const custom = `${cache}${suffix}`;
    await mkdir(cache, { recursive: true });
    await mkdir(custom, { recursive: true });
    await writeFile(join(cache, "owned"), "owned cache");
    await writeFile(join(custom, "selected"), "caller evidence");
    const sibling = join(cacheRoot, "rea", "caller-evidence");
    await writeFile(sibling, "unrelated evidence");

    const result = await cli.run({
      arguments: ["uninstall", "--purge-data", "--format", "json"],
      cwd: home,
      environment: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: cacheRoot,
        XDG_DATA_HOME: join(home, ".local/share"),
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, "system/gemini.json"),
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(
          home,
          "system/gemini-defaults.json",
        ),
        GEMINI_CLI_TRUSTED_FOLDERS_PATH: join(home, ".gemini/trusted.json"),
        REA_KUNA_CACHE_DIR: custom,
      },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      status: "complete",
      items: expect.arrayContaining([
        expect.objectContaining({
          name: "kuna-custom-cache",
          status: "retained",
          detail: expect.stringContaining(custom),
        }),
      ]),
    });
    expect(await readFile(join(custom, "selected"), "utf8")).toBe(
      "caller evidence",
    );
    expect(await readFile(join(cache, "owned"), "utf8")).toBe("owned cache");
    expect(await readFile(sibling, "utf8")).toBe("unrelated evidence");
  },
);
