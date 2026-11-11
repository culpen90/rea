import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { processTest } from "../../support/process/processFixture.js";

processTest.for(["none", "client", "transport", "both", "early"])(
  "preserves native verifier failure and cleanup ownership (fault: $0)",
  async (fault, { processes }) => {
    const result = await processes.run(process.execPath, [
      fileURLToPath(
        new URL(
          "../../fixtures/nativeValueVerifierCleanup.mjs",
          import.meta.url,
        ),
      ),
      fault,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      fault,
      primaryPreserved: true,
    });
  },
);
