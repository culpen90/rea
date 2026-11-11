import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  compareTestDiscovery,
  workingTreeTestPaths,
} from "./lib/test-discovery.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

const temporary = await mkdtemp(join(tmpdir(), "rea-test-discovery-"));
let discovered;
try {
  const output = join(temporary, "discovery.json");
  await execute(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "list",
      "--filesOnly",
      `--json=${output}`,
    ],
    { cwd: root, maxBuffer: 8 * 1024 * 1024 },
  );
  const report = compareTestDiscovery(
    await workingTreeTestPaths(root),
    JSON.parse(await readFile(output, "utf8")),
    root,
  );
  if (
    report.missing.length ||
    report.unexpected.length ||
    report.duplicates.length ||
    report.wrongProjects.length
  ) {
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } else discovered = report.discovered;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
if (discovered !== undefined)
  console.log(`Discovered all ${discovered} test files exactly once.`);
