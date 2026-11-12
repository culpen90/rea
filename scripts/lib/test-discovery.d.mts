/** Compare actual Vitest discovery with repository-owned test paths. */
export function compareTestDiscovery(
  expectedPaths: readonly string[],
  discovery: unknown,
  root: string,
): {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicates: readonly {
    readonly file: string;
    readonly projects: readonly string[];
  }[];
  readonly wrongProjects: readonly {
    readonly file: string;
    readonly expected: string;
    readonly actual: string;
  }[];
  readonly discovered: number;
};
/** List owned test files present in the working tree, including unstaged additions. */
export function workingTreeTestPaths(root: string): Promise<readonly string[]>;
