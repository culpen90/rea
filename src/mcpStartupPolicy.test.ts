import { describe, expect, it } from "vitest";

import { parseClientConfiguration } from "./application/ClientConfigurationDocument.js";
import { clientRegistrationEnvironmentDetails } from "./application/ClientRegistrationEnvironment.js";
import { explicitSetupRegistrationEnvironment } from "./application/SetupRegistrationEnvironment.js";
import {
  mcpProviderDeadlineAllowanceMs,
  recommendedMcpToolTimeoutSeconds,
} from "./mcpStartupPolicy.js";

const inputs = {
  ghidraStartupTimeoutMs: 330_000,
} as const;

describe("MCP tool deadline allowance for a Ghidra decompile limit", () => {
  it("adds cold startup and the selected decompile limit", () => {
    expect(
      mcpProviderDeadlineAllowanceMs({
        ...inputs,
        ghidraDecompileTimeoutMs: 600_000,
      }),
    ).toBe(930_000);
  });

  it("keeps the startup-only allowance when no decompile limit is set", () => {
    expect(mcpProviderDeadlineAllowanceMs(inputs)).toBe(330_000);
    expect(recommendedMcpToolTimeoutSeconds(inputs)).toBe(450);
  });

  it("derives the registration allowance from REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS", () => {
    const details = clientRegistrationEnvironmentDetails(
      parseClientConfiguration(
        JSON.stringify({
          mcpServers: {
            rea: {
              command: "rea",
              args: ["mcp"],
              env: {
                REA_ANALYSIS_PROVIDER: "ghidra",
                REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "600",
              },
            },
          },
        }),
        "json",
      ),
      undefined,
    );
    if (!details.ok) throw details.error;
    expect(details.value.timeoutInputs).toMatchObject({
      ghidraDecompileTimeoutMs: 600_000,
    });
    // 330 s default startup + 600 s limit + 120 s operation headroom.
    const timeoutInputs = details.value.timeoutInputs;
    if (timeoutInputs === undefined)
      throw new Error("Expected resolved decompile timeout inputs");
    expect(recommendedMcpToolTimeoutSeconds(timeoutInputs)).toBe(1050);
  });

  it("forwards selected launch and response limits without copying transport credentials or unrelated settings", () => {
    expect(
      explicitSetupRegistrationEnvironment({
        REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "600",
        REA_ASAR_MAX_HEADER_BYTES: "33554432",
        REA_MCP_MAX_RESPONSE_BYTES: "20971520",
        REA_TOKEN: "transport-only",
        UNRELATED: "dropped",
      }),
    ).toEqual({
      REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "600",
      REA_ASAR_MAX_HEADER_BYTES: "33554432",
      REA_MCP_MAX_RESPONSE_BYTES: "20971520",
    });
  });
});
