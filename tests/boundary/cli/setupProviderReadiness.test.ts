import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32")(
  "setup and doctor do not execute host Java while Ghidra is unconfigured",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-setup-unconfigured-java-");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const marker = join(root, "java-executed");
    await mkdir(home);
    await mkdir(bin);
    // A host JVM is unrelated to an unconfigured Ghidra provider; running it
    // exposes setup to that process's cleanup outcome.
    await writeFile(
      join(bin, "java"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\nexit 1\n`,
      { mode: 0o755 },
    );
    const environment = {
      HOME: home,
      USERPROFILE: home,
      // The recording java shadows any host JVM in the system directories.
      PATH: `${bin}:/usr/bin:/bin`,
    };
    const setup = await cli.run({
      arguments: ["setup", "--client", "claude_code", "--dry-run", "--json"],
      environment,
      timeoutMs: 20_000,
    });
    expect(setup.exitCode, setup.stdout).toBe(0);
    expect(setup.json).toMatchObject({
      status: "planned",
      doctor: {
        providerInspections: expect.arrayContaining([
          expect.objectContaining({
            id: "ghidra",
            configured: false,
            checks: [
              expect.objectContaining({
                name: "configuration",
                code: "not_configured",
              }),
            ],
          }),
        ]),
      },
    });
    const doctor = await cli.run({
      arguments: ["doctor", "--json"],
      environment,
      timeoutMs: 20_000,
    });
    expect(doctor.json).toMatchObject({
      providerInspections: expect.arrayContaining([
        expect.objectContaining({ id: "ghidra", configured: false }),
      ]),
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
