import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { inspectAddressContext } from "../../../src/application/AnalysisContextQueries.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { err, ok } from "../../../src/domain/result.js";
import { SESSION_TOOL_CONTRACTS } from "../../../src/contracts/sessionToolContracts.js";
import { createServer } from "../../../src/server/createServer.js";

const createContextRecoverySession = () => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  return createTestBinarySession(() => ({
    execute: async (operation, parameters) => {
      if (operation === "health")
        return ok(createAnalysisExecution(null, identity));
      if (operation === "address_name" && parameters.address === "0x405000")
        return err(
          new AnalysisCapabilityUnavailableError(
            "fixture",
            operation,
            "configuration unavailable",
            {
              remediationAction: "Restart REA.",
              continuingCallerGuidance: {
                remediationAction: "Refresh the current session.",
              },
            },
          ),
        );
      if (
        operation === "resolve_containing_procedure" &&
        parameters.address === "0x404000"
      )
        return err(
          new AnalysisCapabilityUnavailableError(
            "fixture",
            operation,
            "not supported",
          ),
        );
      if (operation === "address_name" && parameters.address === "0x403000")
        return err(
          new AnalysisCapabilityUnavailableError(
            "fixture",
            operation,
            "temporarily unavailable",
            {
              retryable: true,
              remediationAction: "Wait for the fixture to become ready.",
            },
          ),
        );
      if (operation === "address_name" && parameters.address === "0x402000")
        return err(
          new AnalysisCapabilityUnavailableError(
            "fixture",
            operation,
            "not supported",
          ),
        );
      if (
        operation !== "resolve_containing_procedure" &&
        operation !== "address_name"
      )
        throw new Error(`Unexpected provider operation: ${operation}`);
      const result =
        operation === "resolve_containing_procedure"
          ? parameters.address === "0x402000"
            ? {
                query_address: "0x402000",
                found: false,
                procedure: null,
                reason: "not_in_procedure",
              }
            : {
                query_address: parameters.address,
                found: true,
                procedure: {
                  address: "0x401000",
                  name: "entry",
                  classification: null,
                  body: { available: false, reason: "not recorded" },
                },
              }
          : "entry";
      return ok(createAnalysisExecution(result, identity));
    },
    close: async () => ok(null),
  }));
};

it.each(["compact", "full"] as const)(
  "retains address-facet availability and recovery (%s)",
  async (profile) => {
    const directory = await createTestTempDirectory(
      "rea-context-availability-",
    );
    const target = join(directory, "fixture.com");
    await writeFile(target, Buffer.from([0xb8, 0x00, 0x4c, 0xcd, 0x21]));
    const session = createContextRecoverySession();
    const server = createServer(
      { kind: "session", session },
      {
        environment: {
          ...process.env,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
          REA_MCP_TOOL_FAMILIES: "session",
        },
      },
    );
    const client = new Client({
      name: "context-availability-recovery",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(
        (
          await client.callTool({
            name: "open_binary",
            arguments: { path: target, format: "dos-com" },
          })
        ).isError,
      ).not.toBe(true);
      const response = await client.callTool({
        name: "inspect_address_context",
        arguments: { address: "0x401001", document: "fixture" },
      });
      const contract = SESSION_TOOL_CONTRACTS.find(
        (candidate) => candidate.name === "inspect_address_context",
      );
      if (contract === undefined)
        throw new Error("inspect_address_context contract is missing");
      const result = contract.outputSchema.parse(
        response.structuredContent,
      ).result;
      expect(result).toMatchObject({
        name: { state: "available", value: "entry" },
        procedure: {
          state: "available",
          value: { found: true, procedure: { address: "0x401000" } },
        },
      });
      const outside = await client.callTool({
        name: "inspect_address_context",
        arguments: { address: "0x402000", document: "fixture" },
      });
      const outsideResult = contract.outputSchema.parse(
        outside.structuredContent,
      ).result;
      expect(outsideResult.procedure).toMatchObject({
        state: "available",
        value: {
          query_address: "0x402000",
          found: false,
          procedure: null,
          reason: "not_in_procedure",
        },
      });
      expect(outsideResult.name).toMatchObject({
        state: "unavailable",
        remediation: expect.stringContaining("binary_session"),
      });
      if (outsideResult.name.state !== "unavailable")
        throw new Error("expected unavailable facet");
      expect(outsideResult.name.remediation).toContain("detail complete");
      expect(outsideResult.name.remediation).toContain("search_procedures");
      expect(outsideResult.name.remediation).not.toContain("analyze_function");
      const transient = await client.callTool({
        name: "inspect_address_context",
        arguments: { address: "0x403000", document: "fixture" },
      });
      expect(transient.isError, JSON.stringify(transient)).not.toBe(true);
      const transientResult = contract.outputSchema.parse(
        transient.structuredContent,
      ).result;
      expect(transientResult.name).toMatchObject({
        state: "unavailable",
        remediation: "Wait for the fixture to become ready.",
      });
      const continuing = await client.callTool({
        name: "inspect_address_context",
        arguments: { address: "0x405000", document: "fixture" },
      });
      const continuingResult = contract.outputSchema.parse(
        continuing.structuredContent,
      ).result;
      expect(continuingResult.name).toMatchObject({
        state: "unavailable",
        remediation: "Refresh the current session.",
      });
      const unsupportedProcedure = await client.callTool({
        name: "inspect_address_context",
        arguments: { address: "0x404000", document: "fixture" },
      });
      const unsupportedResult = contract.outputSchema.parse(
        unsupportedProcedure.structuredContent,
      ).result;
      expect(unsupportedResult.procedure).toMatchObject({
        state: "unavailable",
        remediation: expect.stringContaining("binary_session"),
      });
      if (unsupportedResult.procedure.state !== "unavailable")
        throw new Error("expected unavailable facet");
      expect(unsupportedResult.procedure.remediation).toContain(
        "detail complete",
      );
      expect(unsupportedResult.procedure.remediation).toContain(
        "search_procedures",
      );
    } finally {
      await client.close();
      await server.close();
    }
  },
);

it.each([
  ["compact", false, "address_name"],
  ["compact", true, "resolve_containing_procedure"],
  ["full", false, "resolve_containing_procedure"],
  ["full", true, "address_name"],
] as const)(
  "preserves a local input refusal alongside successful facets (%s, conforms=%s, operation=%s)",
  async (profile, conforms, rejectedOperation) => {
    const identity = { id: "fixture", name: "Fixture", version: "1" };
    const directory = await createTestTempDirectory("rea-context-input-");
    const target = join(directory, "fixture.com");
    await writeFile(target, Buffer.from([0xb8, 0x00, 0x4c, 0xcd, 0x21]));
    const inputFailure = new AnalysisInputError(
      rejectedOperation,
      {
        userMessage: "Controlled facet refusal",
        conformsToInputContract: conforms,
        diagnostics: { producer_fact: "retained" },
      },
      [
        {
          path: ["address"],
          reason: "invalid_value",
          expected: "controlled-value",
        },
      ],
    );
    const session = createTestBinarySession(() => ({
      execute: async (operation) => {
        if (operation === rejectedOperation) return err(inputFailure);
        const result =
          operation === "address_name"
            ? "entry"
            : operation === "resolve_containing_procedure"
              ? {
                  query_address: "0x401001",
                  found: true,
                  procedure: {
                    address: "0x401000",
                    name: "entry",
                    classification: null,
                    body: { available: false, reason: "not recorded" },
                  },
                }
              : null;
        return ok(createAnalysisExecution(result, identity));
      },
      close: async () => ok(null),
    }));
    const server = createServer(
      { kind: "session", session },
      {
        environment: {
          ...process.env,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
          REA_MCP_TOOL_FAMILIES: "session",
        },
      },
    );
    const client = new Client({ name: "context-input-error", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const definitions = new Map(
        (await client.listTools()).tools.map((tool) => [tool.name, tool]),
      );
      const contextDefinition = definitions.get("inspect_address_context");
      if (contextDefinition === undefined)
        throw new Error("inspect_address_context was not advertised");
      expect(
        (
          await client.callTool({
            name: "open_binary",
            arguments: { path: target, format: "dos-com" },
          })
        ).isError,
      ).not.toBe(true);
      const response = await client.callTool(
        {
          name: "inspect_address_context",
          arguments: { address: "0x401001", document: "fixture" },
        },
        { toolDefinition: contextDefinition },
      );
      expect(response.isError).not.toBe(true);
      const contract = SESSION_TOOL_CONTRACTS.find(
        (
          candidate,
        ): candidate is Extract<
          (typeof SESSION_TOOL_CONTRACTS)[number],
          { readonly name: "inspect_address_context" }
        > => candidate.name === "inspect_address_context",
      );
      if (contract === undefined)
        throw new Error("inspect_address_context contract is missing");
      const parsed = contract.outputSchema.parse(
        response.structuredContent,
      ).result;
      const expected = projectAnalysisError(inputFailure);
      const [rejected, available] =
        rejectedOperation === "address_name"
          ? [parsed.name, parsed.procedure]
          : [parsed.procedure, parsed.name];
      expect(rejected).toEqual({
        state: "unavailable",
        reason: expected.message,
        remediation: expected.remediation.action,
        error: expected,
      });
      expect(available).toMatchObject({
        state: "available",
        value:
          rejectedOperation === "address_name"
            ? { found: true, query_address: "0x401001" }
            : "entry",
      });
      expect(expected.details).toMatchObject({
        issues: [
          {
            path: ["address"],
            expected: "controlled-value",
          },
        ],
        diagnostics: { producer_fact: "retained" },
      });
      expect(Object.hasOwn(expected, "recovery")).toBe(!conforms);
    } finally {
      await client.close();
      await server.close();
    }
  },
);

it("does not demote an input refusal with incomplete cleanup into a local facet", async () => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const failure = new AnalysisInputError(
    "address_name",
    {
      cleanup: { reason: "controlled failure", resources: ["owned-resource"] },
    },
    [{ path: ["address"], reason: "invalid_value" }],
  );
  const result = await inspectAddressContext(
    {
      execute: async (operation) =>
        operation === "address_name"
          ? err(failure)
          : ok(createAnalysisExecution(null, identity)),
    },
    { address: "0x401001", document: "fixture" },
  );
  if (result.ok) throw new Error("expected incomplete cleanup");
  expect(result.error).toBe(failure);
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: { resources: ["owned-resource"] },
  });
});
