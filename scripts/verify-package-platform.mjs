import assert from "node:assert/strict";
import { analysisCliErrorEnvelopeSchema } from "../dist/contracts/errorSchemas.js";

/** Check the public diagnostic for the default provider on an unconfigured host. */
export function assertUnconfiguredGhidra(failure, selector) {
  assert.equal(failure.code, "provider_unavailable", JSON.stringify(failure));
  assert.equal(failure.details?.requested_provider_id, selector);
  assert.equal(failure.details?.selection_reason, "provider_unavailable");
  assert.ok(
    failure.details?.rejections?.some(
      ({ provider_id, origin, code }) =>
        provider_id === "ghidra" &&
        origin === "availability" &&
        code === "not_configured",
    ),
    JSON.stringify(failure),
  );
}

/** Exercise packaged default provider selection without a local Ghidra install. */
export async function verifyPackagePlatform({ commands, cli, environment }) {
  const execution = await commands.runWithStatus(
    cli,
    ["decompile", process.execPath, "0x1000", "--json"],
    {
      ...environment,
      REA_ANALYSIS_PROVIDER: undefined,
      GHIDRA_INSTALL_DIR: undefined,
    },
  );
  assert.equal(execution.status, 1, execution.stdout);
  assertUnconfiguredGhidra(
    analysisCliErrorEnvelopeSchema.parse(JSON.parse(execution.stdout)),
    "auto",
  );
}
