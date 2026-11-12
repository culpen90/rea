import type { PackageVerifierCommands } from "./lib/package-command-owner.mjs";

/** Check the public diagnostic for the default provider on an unconfigured host. */
export function assertUnconfiguredGhidra(
  failure: unknown,
  selector: "auto" | "ghidra",
): void;

/** Exercise packaged default provider selection without a local Ghidra install. */
export function verifyPackagePlatform(input: {
  readonly commands: Pick<PackageVerifierCommands, "runWithStatus">;
  readonly cli: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<void>;
