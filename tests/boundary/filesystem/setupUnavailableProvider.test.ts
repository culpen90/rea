import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { createDoctorHostFixture } from "../../../src/application/Doctor.fixture.js";
import { systemSetupHost } from "../../../src/application/SetupHost.js";
import { runSetup } from "../../../src/application/Setup.js";
import { options } from "../../../src/application/Setup.fixture.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("setup with configured but unavailable providers", () => {
  it("preserves Ghidra settings and makes the second setup perform no writes", async () => {
    const root = await createTestTempDirectory("rea-setup-unavailable-");
    const client = supportedClients(root, "darwin", {}).find(
      (candidate) => candidate.name === "cursor",
    );
    if (client === undefined) throw new Error("Cursor registration is missing");
    const original = '{"theme":"dark"}\n';
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFile(client.configPath, original);
    const environment = { GHIDRA_INSTALL_DIR: "/custom/Ghidra" };
    const doctor = createDoctorHostFixture({
      validTarget: () => Promise.resolve(false),
      clientRegistrations: () =>
        readClientRegistrationStatuses(root, undefined, {
          platform: "darwin",
          environment: {},
        }),
      providerInspections: () =>
        Promise.resolve([
          {
            id: "ghidra",
            configured: true,
            available: false,
            providerVersion: null,
            registrationEnvironment: environment,
            checks: [
              {
                name: "configuration",
                ok: false,
                code: "unavailable",
                detail: "Selected installation is unavailable",
                classification: "missing_analysis_engine",
                remediation: null,
              },
            ],
          },
        ]),
    });
    const createHost = () => ({
      ...systemSetupHost(doctor),
      detectedClients: () => Promise.resolve([client]),
      supportedClients: () => Promise.resolve([client]),
    });
    const selected = {
      ...options(true),
      clientIds: ["cursor"],
      installSkill: false,
      // This lane checks registration effects; no deep provider is required.
      readinessScope: { clients: [], providers: [], skill: false },
    };
    const first = await runSetup(selected, createHost());
    expect(first.status).toBe("ready");
    expect(first.clients.cursor).toMatchObject({ status: "configured" });
    const configured = await readFile(client.configPath, "utf8");
    expect(JSON.parse(configured)).toMatchObject({
      theme: "dark",
      mcpServers: { rea: { env: environment } },
    });
    await expect(
      readFile(`${client.configPath}.rea.backup`, "utf8"),
    ).resolves.toBe(original);

    const second = await runSetup(selected, createHost());
    expect(second.status).toBe("ready");
    expect(second.plannedActions).toEqual([]);
    expect(second.appliedActions).toEqual([]);
    await expect(readFile(client.configPath, "utf8")).resolves.toBe(configured);
    await expect(
      readFile(`${client.configPath}.rea.backup`, "utf8"),
    ).resolves.toBe(original);
  });
});
