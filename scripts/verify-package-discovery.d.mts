import type { PackageVerifierCommands } from "./lib/package-command-owner.mjs";

/** Validate --help, --llms, and doctor output and determine host setup support. */
export function verifyPackageDiscovery(input: {
  readonly commands: Pick<PackageVerifierCommands, "run" | "runWithStatus">;
  readonly cli: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<{
  supportedSetupHost: boolean;
}>;
