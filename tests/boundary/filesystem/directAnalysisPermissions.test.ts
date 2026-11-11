import { projectCliAnalysisResult } from "../../../src/cli/projectCliAnalysisResult.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createDirectAnalysis } from "../../../src/composition/directAnalysis.js";
import { elf } from "../../../src/domain/binaryTarget.fixture.js";

describe("direct analysis provider selection", () => {
  it("forwards the CLI provider selector ahead of the environment preference", async () => {
    const directory = await createTestTempDirectory("rea-direct-provider-");
    const targetPath = join(directory, "fixture.elf");
    await writeFile(targetPath, elf(2, 1, 62));

    await expect(
      createDirectAnalysis({
        REA_ANALYSIS_PROVIDER: "ghidra",
        GHIDRA_INSTALL_DIR: join(directory, "missing-ghidra"),
      })
        .runDirectAnalysis(
          targetPath,
          "binary_overview",
          {},
          {
            providerId: "request-provider",
          },
        )
        .then(projectCliAnalysisResult),
    ).resolves.toMatchObject({
      error: "Analysis failed",
      code: "capability_unavailable",
      details: {
        selection_reason: "unknown_provider",
        requested_provider_id: "request-provider",
        candidate_ids: ["ghidra"],
      },
    });
  });
});
