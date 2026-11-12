import {
  chmod,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32").each([
  { name: "cache", relative: false },
  { name: "state", relative: false },
  { name: "cache", relative: true },
  { name: "state", relative: true },
])(
  "finishes purging after $name removes the working directory (relative selection: $relative)",
  async ({ name, relative }) => {
    const home = await createTestTempDirectory("rea-managed-cache-cwd-");
    const cwd = join(home, ".rea", name);
    const cacheRoot = join(home, "cache");
    const cache = join(cacheRoot, "rea", "kuna");
    await mkdir(cwd, { recursive: true });
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "cached"), "owned cache");
    const callerCache = join(home, "caller-cache");
    await mkdir(callerCache);
    await writeFile(join(callerCache, "evidence"), "caller evidence");
    const selected = relative ? "../../caller-cache" : `${cache}/`;
    const moduleUrl = new URL(
      "../../../dist/application/Uninstall.js",
      import.meta.url,
    ).href;
    const result = await execFileOutput(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { systemUninstallHost } from ${JSON.stringify(moduleUrl)};
const [home, cwd, cacheRoot, selected] = process.argv.slice(1);
const host = systemUninstallHost(home, undefined, {
  XDG_CACHE_HOME: cacheRoot, REA_KUNA_CACHE_DIR: selected,
}, "linux");
// Reset Node's cwd cache after module loading, before the real removal.
process.chdir(cwd);
try { console.log(JSON.stringify(await host.purgeData())); }
finally { await host.close?.(); }`,
        home,
        cwd,
        cacheRoot,
        selected,
      ],
      { timeout: 10_000, maxBuffer: 64 * 1024, stopSignal: "SIGTERM" },
    );
    expect(JSON.parse(result.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name, status: "removed" }),
      ]),
    );
    await expect(lstat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(cache, "cached"), "utf8")).toBe("owned cache");
    expect(await readFile(join(callerCache, "evidence"), "utf8")).toBe(
      "caller evidence",
    );
    expect(JSON.parse(result.stdout)).toContainEqual(
      expect.objectContaining({
        name: "kuna-custom-cache",
        status: "retained",
        detail: expect.stringContaining(selected),
      }),
    );
  },
);

it.each(["darwin", "linux"] as const)(
  "purges producer-owned default cache namespaces on %s and preserves their siblings",
  async (platform) => {
    const home = await createTestTempDirectory("rea-managed-cache-purge-");
    const cache = join(
      home,
      platform === "darwin" ? "Library/Caches" : "xdg-cache",
    );
    const directories = [
      join(home, ".rea", "cache"),
      join(home, ".rea", "state"),
    ];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "cached"), "REA cache");
    }
    const legacy = [
      join(cache, "rea", "kuna"),
      join(cache, "rea", "hopper-releases"),
    ];
    for (const directory of legacy) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "cached"), "legacy cache");
    }
    const sibling = join(cache, "rea", "caller-evidence");
    await mkdir(sibling);
    await writeFile(join(sibling, "retained"), "caller evidence");
    const host = systemUninstallHost(
      home,
      undefined,
      { XDG_CACHE_HOME: cache },
      platform,
    );
    try {
      const result = await host.purgeData();
      expect(result.filter(({ status }) => status === "removed")).toHaveLength(
        directories.length,
      );
      for (const directory of directories)
        await expect(readFile(join(directory, "cached"))).rejects.toMatchObject(
          { code: "ENOENT" },
        );
      for (const directory of legacy)
        expect(await readFile(join(directory, "cached"), "utf8")).toBe(
          "legacy cache",
        );
      expect(await readFile(join(sibling, "retained"), "utf8")).toBe(
        "caller evidence",
      );
      expect(
        (await host.purgeData()).every(({ status }) => status === "skipped"),
      ).toBe(true);
    } finally {
      await host.close?.();
    }
  },
);

it("purges the Darwin ownership-helper cache when purging managed data", async () => {
  const home = await createTestTempDirectory("rea-managed-helper-cache-");
  const helper = join(home, "Library/Caches/rea/process-helper");
  await mkdir(join(helper, "a".repeat(64)), { recursive: true });
  await writeFile(join(helper, "a".repeat(64), "reader"), "REA helper");
  const host = systemUninstallHost(home, undefined, {}, "darwin");
  try {
    expect(await host.purgeData()).toContainEqual(
      expect.objectContaining({ name: "process-helper", status: "removed" }),
    );
    await expect(lstat(helper)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await host.close?.();
  }
});

it("reports a retained Kuna cache reached through symlink parent traversal", async () => {
  const home = await createTestTempDirectory("rea-managed-cache-parent-");
  const root = join(home, "cache");
  const cache = join(root, "rea", "kuna");
  const external = join(home, "external");
  await mkdir(cache, { recursive: true });
  await mkdir(join(external, "subdir"), { recursive: true });
  await mkdir(join(external, "kuna"));
  await writeFile(join(cache, "cached"), "owned cache");
  await writeFile(join(external, "kuna", "evidence"), "caller evidence");
  await symlink(join(external, "subdir"), join(root, "rea", "alias"), "dir");
  const custom = `${root}/rea/alias/../kuna`;
  const host = systemUninstallHost(
    home,
    undefined,
    { XDG_CACHE_HOME: root, REA_KUNA_CACHE_DIR: custom },
    "linux",
  );
  try {
    const result = await host.purgeData();
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "kuna-custom-cache",
        status: "retained",
      }),
    );
    expect(await readFile(join(external, "kuna", "evidence"), "utf8")).toBe(
      "caller evidence",
    );
    expect(await readFile(join(cache, "cached"), "utf8")).toBe("owned cache");
  } finally {
    await host.close?.();
  }
});

/** One caller selection that purge must not delete, with the namespace that holds it. */
interface NestedSelection {
  readonly label: string;
  readonly namespace: "cache";
  readonly skip?: boolean;
  /** Create the selection's files and return the spellings purge receives. */
  readonly prepare: (home: string) => Promise<{
    readonly cacheHome: string;
    readonly custom: string;
    readonly evidence: string;
  }>;
}

const withEvidence = async (directory: string): Promise<string> => {
  await mkdir(directory, { recursive: true });
  const evidence = join(directory, "evidence");
  await writeFile(evidence, "caller evidence");
  return evidence;
};

const nestedSelections: readonly NestedSelection[] = [
  {
    label: "inside ~/.rea/cache",
    namespace: "cache",
    prepare: async (home) => {
      const custom = join(home, ".rea", "cache", "selected");
      return {
        cacheHome: join(home, "xdg-cache"),
        custom,
        evidence: await withEvidence(custom),
      };
    },
  },
  {
    label: "equal to ~/.rea/cache",
    namespace: "cache",
    prepare: async (home) => {
      const custom = join(home, ".rea", "cache");
      return {
        cacheHome: join(home, "xdg-cache"),
        custom,
        evidence: await withEvidence(custom),
      };
    },
  },
  {
    label: "reached through a symbolic link and parent traversal",
    namespace: "cache",
    skip: process.platform === "win32",
    prepare: async (home) => {
      const inner = join(home, ".rea", "cache", "inner");
      await mkdir(inner, { recursive: true });
      await mkdir(join(home, "outside"), { recursive: true });
      await symlink(inner, join(home, "outside", "alias"), "dir");
      const evidence = await withEvidence(
        join(home, ".rea", "cache", "selected"),
      );
      return {
        cacheHome: join(home, "xdg-cache"),
        custom: `${home}/outside/alias/../selected`,
        evidence,
      };
    },
  },
];

it.for(nestedSelections.filter(({ skip }) => skip !== true))(
  "keeps the namespace whole when a caller-selected Kuna cache is $label",
  async ({ namespace, prepare }) => {
    const home = await createTestTempDirectory("rea-managed-cache-nested-");
    const { cacheHome, custom, evidence } = await prepare(home);
    const host = systemUninstallHost(
      home,
      undefined,
      { XDG_CACHE_HOME: cacheHome, REA_KUNA_CACHE_DIR: custom },
      "linux",
    );
    try {
      expect(await host.purgeData()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "kuna-custom-cache",
            status: "retained",
          }),
          expect.objectContaining({ name: namespace, status: "retained" }),
        ]),
      );
      expect(await readFile(evidence, "utf8")).toBe("caller evidence");
    } finally {
      await host.close?.();
    }
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "keeps the namespaces whole when the selection's location cannot be established",
  async () => {
    const home = await createTestTempDirectory("rea-managed-cache-unknown-");
    const outside = join(home, "outside");
    await mkdir(join(home, ".rea", "state"), { recursive: true });
    const evidence = await withEvidence(
      join(home, ".rea", "cache", "selected"),
    );
    await mkdir(outside);
    await symlink(join(home, ".rea", "cache"), join(outside, "alias"), "dir");
    const unrelated = await withEvidence(join(home, "unrelated"));
    const host = systemUninstallHost(
      home,
      undefined,
      {
        XDG_CACHE_HOME: join(home, "xdg-cache"),
        REA_KUNA_CACHE_DIR: `${outside}/alias/../cache/selected`,
      },
      "linux",
    );
    await chmod(outside, 0o000);
    try {
      expect(await host.purgeData()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "kuna-custom-cache",
            status: "retained",
          }),
          expect.objectContaining({ name: "cache", status: "retained" }),
        ]),
      );
      expect(await readFile(evidence, "utf8")).toBe("caller evidence");
      expect(await readFile(unrelated, "utf8")).toBe("caller evidence");
    } finally {
      await chmod(outside, 0o755);
      await host.close?.();
    }
  },
);
