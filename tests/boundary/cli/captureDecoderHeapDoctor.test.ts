import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { CAPTURE_DECODER_OLD_GENERATION_SETTING } from "../../../src/config/captureDecoderHeap.js";
import { historicalHar } from "../../fixtures/historicalHar.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "starts doctor with an invalid capture decoder heap and reports it when decoding",
  async ({ cli }) => {
    const environment = {
      REA_LOG_LEVEL: "silent",
      [CAPTURE_DECODER_OLD_GENERATION_SETTING]: "7",
    };
    const doctor = await cli.run({
      arguments: ["doctor", "--json"],
      environment,
    });
    expect(doctor.stderr).toBe("");
    expect(doctor.json).toMatchObject({
      scope: { mode: "audit-wide" },
      scope_checks: expect.arrayContaining([
        expect.objectContaining({ name: "node", ok: true }),
      ]),
    });
    const root = await createTestTempDirectory("rea-capture-heap-");
    const capture = join(root, "capture.har");
    await writeFile(capture, JSON.stringify(historicalHar()));
    const inspection = await cli.run({
      arguments: ["inspect-web-network-capture", capture, "har", "--json"],
      environment,
    });
    expect(inspection.exitCode, inspection.stderr).toBe(1);
    expect(inspection.json).toMatchObject({
      code: "configuration_invalid",
      retryable: false,
      details: {
        settings: [{ setting: CAPTURE_DECODER_OLD_GENERATION_SETTING }],
      },
      remediation: {
        action: expect.stringContaining(CAPTURE_DECODER_OLD_GENERATION_SETTING),
      },
    });
  },
);
