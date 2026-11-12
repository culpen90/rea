import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { projectForTest } from "./test-projects.mjs";

const execute = promisify(execFile);

/** List owned test files present in the working tree, including unstaged additions. */
export const workingTreeTestPaths = async (root) => {
  const { stdout } = await execute(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "src",
      "tests",
    ],
    { cwd: root, maxBuffer: 8 * 1024 * 1024 },
  );
  const paths = [];
  for (const path of stdout.split("\0")) {
    if (!path.endsWith(".test.ts")) continue;
    try {
      if ((await stat(join(root, path))).isFile()) paths.push(path);
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }
  return paths;
};

/** Compare actual Vitest discovery with repository-owned test paths. */
export const compareTestDiscovery = (expectedPaths, discovery, root) => {
  if (!Array.isArray(discovery))
    throw new TypeError("Vitest file discovery must be an array");
  const projectsByFile = new Map();
  for (const entry of discovery) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.file !== "string" ||
      entry.file.length === 0 ||
      typeof entry.projectName !== "string" ||
      entry.projectName.length === 0
    )
      throw new TypeError(
        "Vitest discovery requires file and projectName strings",
      );
    const path = relative(root, resolve(root, entry.file)).replaceAll(
      "\\",
      "/",
    );
    const projects = projectsByFile.get(path) ?? [];
    projects.push(entry.projectName);
    projectsByFile.set(path, projects);
  }
  const expected = new Set(expectedPaths);
  const sorted = (values) => [...values].sort();
  return {
    missing: sorted(expected).filter((path) => !projectsByFile.has(path)),
    unexpected: sorted(projectsByFile.keys()).filter(
      (path) => !expected.has(path),
    ),
    duplicates: sorted(projectsByFile.keys()).flatMap((file) => {
      const projects = projectsByFile.get(file);
      return projects.length > 1 ? [{ file, projects: sorted(projects) }] : [];
    }),
    wrongProjects: sorted(expected).flatMap((file) => {
      const projects = projectsByFile.get(file);
      if (!projects || projects.length !== 1) return [];
      const expectedProject = projectForTest(file).name;
      return projects[0] === expectedProject
        ? []
        : [{ file, expected: expectedProject, actual: projects[0] }];
    }),
    discovered: projectsByFile.size,
  };
};
