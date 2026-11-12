import {
  expandCapabilitiesOutput,
  expandProviderOutput,
} from "./lib/mcp-verifier-results.mjs";

/** Verify packaged capabilities and target-free provider discovery. */
export async function verifyPackageCapabilities({
  commands,
  cli,
  environment,
}) {
  const capabilities = expandCapabilitiesOutput(
    JSON.parse(
      await commands.run(cli, ["capabilities", "--json"], environment),
    ),
  );
  if (!Array.isArray(capabilities.capabilities))
    throw new Error("packaged capabilities CLI failed");
  const providers = expandProviderOutput(
    JSON.parse(await commands.run(cli, ["providers", "--json"], environment)),
  );
  const candidates = providers.analysis_provider_candidates;
  if (
    !Array.isArray(candidates) ||
    candidates.length !== 1 ||
    candidates[0].provider?.id !== "ghidra" ||
    candidates[0].selected !== false ||
    providers.analysis_provider_binding !== null ||
    candidates[0].target_support?.status !== "unknown"
  )
    throw new Error("packaged providers CLI failed");
}
