import {
  chmod,
  copyFile,
  mkdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

processTest.skipIf(
  process.platform === "win32" ||
    (typeof process.getuid === "function" && process.getuid() === 0),
)(
  "fails the numeric limit guard when a required scan directory is unreadable",
  { timeout: 60_000 },
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-limit-permission-");
    for (const directory of [
      "scripts/verify",
      "tests/nested",
      "src/domain",
      "src/artifacts",
      ".agents",
    ])
      await mkdir(join(root, directory), { recursive: true });
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    const sources = {
      "src/domain/analysisSettingDefinitions.ts":
        "export const ANALYSIS_SETTINGS = {} as const;",
      "src/domain/numericLimitRegistry.ts":
        "export const NUMERIC_LIMIT_REGISTRY = [] as const;",
      "src/domain/artifactReaderLimits.ts":
        'export type Limit = { update_mode: "parameter" };',
      "src/artifacts/ArtifactReaderLimits.ts":
        'export type Limit = { update_mode: "parameter" };',
      "src/domain/webNetworkCapture.ts":
        'export type Limit = { update_mode: "parameter" };',
      "tests/nested/example.test.ts": "export {};",
    };
    for (const [file, source] of Object.entries(sources))
      await writeFile(join(root, file), source);
    await copyFile(
      "scripts/verify/rea-numeric-limits.mjs",
      join(root, "scripts/verify/rea-numeric-limits.mjs"),
    );
    const run = () =>
      processes.run(
        process.execPath,
        ["scripts/verify/rea-numeric-limits.mjs"],
        { cwd: root, timeoutMs: 20_000 },
      );
    const healthy = await run();
    expect(healthy.exitCode, healthy.stderr).toBe(0);
    for (const directory of [join(root, "tests"), join(root, "tests/nested")]) {
      try {
        await chmod(directory, 0);
        const refused = await run();
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain("EACCES");
        expect(refused.stderr).toContain(directory);
      } finally {
        await chmod(directory, 0o755);
      }
    }
    await rename(join(root, "tests"), join(root, "tests-saved"));
    try {
      const missing = await run();
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr).toContain("ENOENT");
      expect(missing.stderr).toContain(join(root, "tests"));
    } finally {
      await rename(join(root, "tests-saved"), join(root, "tests"));
    }
  },
);
