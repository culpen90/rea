export const LARGE_FIXTURE_COUNT: number;
export function parseConformanceFixtureManifest(value: unknown): {
  readonly schemaVersion: 2;
  readonly platform: "darwin" | "linux";
  readonly fixtures: readonly Record<string, unknown>[];
};
export function sha256(value: string | Uint8Array): string;
/** `nm -j` ends each name with LF. A carriage return before that LF belongs to the name. */
export function splitNmSymbolRecords(output: string): string[];
export function generateLargeFixture(): string;
export function sourceDigest(
  sources: readonly { readonly path: string; readonly content: string }[],
): string;

export function resolveConformanceFixturePath(
  root: string,
  declaredPath: unknown,
): Promise<string>;
export function bindConformanceFixtureArtifact(
  path: string,
  fixture: unknown,
): Promise<{ readonly path: string; readonly sha256: string }>;
