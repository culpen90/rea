import { afterAll, afterEach, expect, it } from "vitest";
import {
  closeEnhancedToolResources,
  connect,
  jsonResult,
} from "./enhancedToolsHarness.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { err } from "../../../src/domain/result.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import type { SegmentSummary } from "../../../src/domain/native/nativeSegments.js";

const validation = createMcpSchemaValidation();
afterEach(closeEnhancedToolResources);
afterAll(() => validation.clear());

const segment = {
  name: ".text",
  start: "0x101000",
  end: "0x101100",
  readable: true,
  writable: false,
  executable: true,
  image_base: "0x100000",
  address_space: "ram",
};
const overviewClient = (segments: SegmentSummary[]) =>
  connect(
    {
      execute: (name) => {
        switch (name) {
          case "read_binary_inventory_summary":
            return Promise.resolve(
              err(
                new AnalysisCapabilityUnavailableError(
                  "fixture",
                  name,
                  "No native overview",
                ),
              ),
            );
          case "list_documents":
            return Promise.resolve(ok(["fixture"]));
          case "list_segments":
            return Promise.resolve(ok(segments));
          case "list_procedures":
            return Promise.resolve(
              ok([{ address: "0x101013", value: "entry" }]),
            );
          case "list_strings":
            return Promise.resolve(ok([]));
          default:
            throw new Error(`Unexpected operation: ${name}`);
        }
      },
    },
    { ...process.env, REA_MCP_TOOL_FAMILIES: "enhanced" },
    { jsonSchemaValidator: validation },
  );

it("preserves observed coordinates and main's optional-string output contract after SDK conversion", async () => {
  const client = await overviewClient([segment]);
  const toolDefinition = (await client.listTools()).tools.find(
    ({ name }) => name === "binary_overview",
  );
  if (toolDefinition?.outputSchema === undefined)
    throw new Error("Missing overview output schema");
  const schema = toolDefinition.outputSchema;
  const validate = (result: unknown) =>
    validation.assertions.validate(schema, result);
  const response = await client.callTool(
    { name: "binary_overview", arguments: {} },
    { toolDefinition },
  );
  expect(validate(response.structuredContent)).toBe(true);
  expect(jsonResult(response)).toMatchObject({
    image_base: "0x100000",
    segments: [
      { start: "0x101000", image_base: "0x100000", address_space: "ram" },
    ],
  });
  const absent = JSON.parse(JSON.stringify(response.structuredContent));
  delete absent.normalized_result.image_base;
  expect(validate(absent)).toBe(true);
  absent.normalized_result.image_base = null;
  expect(validate(absent)).toBe(false);
});

it("omits unreported bases without inventing zero and preserves explicit zero", async () => {
  const { image_base: _base, ...unreported } = segment;
  const client = await overviewClient([unreported]);
  expect(
    jsonResult(
      await client.callTool({ name: "binary_overview", arguments: {} }),
    ),
  ).not.toHaveProperty("image_base");
  const zero = await overviewClient([{ ...segment, image_base: "0x0" }]);
  expect(
    jsonResult(await zero.callTool({ name: "binary_overview", arguments: {} })),
  ).toMatchObject({ image_base: "0x0" });
});

it("keeps a partially reported base unknown while retaining the reported segment observation", async () => {
  const { image_base: _base, ...unreported } = segment;
  const client = await overviewClient([
    segment,
    { ...unreported, name: ".data" },
  ]);
  const result = jsonResult(
    await client.callTool({ name: "binary_overview", arguments: {} }),
  );
  expect(result).not.toHaveProperty("image_base");
  expect(result).toMatchObject({
    segments: [{ image_base: "0x100000" }, { name: ".data" }],
  });
});

it("retains all conflicting observations after repeated early bases without selecting one", async () => {
  const { address_space: _space, ...unreported } = segment;
  const client = await overviewClient([
    ...Array.from({ length: 40 }, () => unreported),
    {
      ...segment,
      name: ".data",
      start: "other%20space:0x201000",
      end: "other%20space:0x201100",
      image_base: "0x200000",
      address_space: "other space",
    },
  ]);
  const result = jsonResult(
    await client.callTool({ name: "binary_overview", arguments: {} }),
  );
  expect(result).not.toHaveProperty("image_base");
  expect(result).toHaveProperty("segments.length", 41);
  expect(result).toHaveProperty("segments.40.image_base", "0x200000");
  expect(result).toHaveProperty("segments.40.address_space", "other space");
  expect(result).not.toHaveProperty("segments.0.address_space");
});
