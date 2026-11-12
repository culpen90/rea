import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test, vi } from "vitest";

import {
  createSystemDoctorHost,
  selectedProviderSettings,
  settingAffectsProbe,
} from "./doctorRuntime.js";
import { DOCTOR_PROVIDER_IDS } from "./application/DoctorProviderIds.js";
import { providerRegistrationEnvironment } from "./application/SetupRegistrationEnvironment.js";
import { createTestTempDirectory } from "../tests/fixtures/temporaryDirectory.js";
import { writeJadxJarInventory } from "../tests/fixtures/android/jadxJar.js";
import { err } from "./domain/result.js";
import { runDoctor } from "./application/Doctor.js";
import { CURRENT_ENTRYPOINT_PATH } from "./process/CurrentEntrypointPath.js";
import * as configurationFiles from "./application/ClientConfigurationFiles.js";
import { RegularFileCleanupFailure } from "./filesystem/OwnedRegularFile.js";

const it = test.skipIf(process.platform === "win32");

it("exposes jadx through the doctor provider selector", () => {
  expect(DOCTOR_PROVIDER_IDS).toContain("jadx");
});

it("carries a validated REA_JADX_MCP_JAR into the provider registration environment", async () => {
  const root = await createTestTempDirectory("rea-jadx-registration-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const javaHome = await createFakeJdk(root);
  await writeJadxJarInventory(jar);

  const host = createSystemDoctorHost({
    REA_JADX_MCP_JAR: jar,
    JAVA_HOME: javaHome,
  });
  const inspections = await host.providerInspections?.([]);
  expect(inspections?.map(({ id }) => id)).toContain("jadx");

  const environment = providerRegistrationEnvironment(inspections ?? []);
  expect(environment).toMatchObject({
    REA_JADX_MCP_JAR: await realpath(jar),
  });
});

it("omits REA_JADX_MCP_JAR from the provider registration environment when it is not configured", async () => {
  const host = createSystemDoctorHost({});
  const inspections = await host.providerInspections?.([]);

  const environment = providerRegistrationEnvironment(inspections ?? []);
  expect(environment).not.toHaveProperty("REA_JADX_MCP_JAR");
});

const createFakeJdk = async (root: string): Promise<string> => {
  const javaHome = join(root, "fake-jdk");
  const bin = join(javaHome, "bin");
  const java = join(bin, "java");
  await mkdir(bin, { recursive: true });
  await writeFile(
    java,
    "#!/bin/sh\nprintf 'java.base@21\\njdk.compiler@21\\n'\n",
  );
  await chmod(java, 0o700);
  return javaHome;
};

const opencodeRegistration = (
  home: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> => {
  const directory = join(home, ".config/opencode");
  return mkdir(directory, { recursive: true }).then(() =>
    writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({
        mcp: {
          rea: {
            type: "local",
            command: [process.execPath, CURRENT_ENTRYPOINT_PATH, "mcp"],
            enabled: true,
            environment,
          },
        },
      }),
    ),
  );
};

test("probes the selected client's registration environment instead of the terminal's", async () => {
  const home = await createTestTempDirectory("rea-opencode-doctor-env-");
  await opencodeRegistration(home, {
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
    REA_JADX_MCP_JAR: "/opt/jadx.jar",
  });
  const host = createSystemDoctorHost({ HOME: home });
  try {
    const inspections = await host.providerInspections?.(["opencode"]);
    expect(inspections?.find(({ id }) => id === "ghidra")?.configured).toBe(
      true,
    );
    expect(inspections?.find(({ id }) => id === "jadx")?.configured).toBe(true);
  } finally {
    await host.close?.();
  }
});

test("keeps reading this terminal when no client is selected", async () => {
  const home = await createTestTempDirectory("rea-opencode-doctor-ambient-");
  await opencodeRegistration(home, { GHIDRA_INSTALL_DIR: "/opt/ghidra" });
  const host = createSystemDoctorHost({ HOME: home });
  try {
    const inspections = await host.providerInspections?.([]);
    expect(inspections?.find(({ id }) => id === "ghidra")?.configured).toBe(
      false,
    );
  } finally {
    await host.close?.();
  }
});

test("keeps a selected client without a registration on the setup's settings", async () => {
  const home = await createTestTempDirectory(
    "rea-opencode-doctor-unregistered-",
  );
  const host = createSystemDoctorHost({
    HOME: home,
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
  });
  try {
    const inspections = await host.providerInspections?.(["opencode"]);
    expect(inspections?.find(({ id }) => id === "ghidra")?.configured).toBe(
      true,
    );
  } finally {
    await host.close?.();
  }
});

test("decides whether an unresolved setting is one the probe actually reads", () => {
  // JADX resolves Java from an explicit JAVA_HOME, so a PATH it never consults
  // must not make the whole provider unknown.
  expect(
    settingAffectsProbe("jadx", "PATH", { JAVA_HOME: "/opt/java" }, "linux"),
  ).toBe(false);
  expect(settingAffectsProbe("jadx", "PATH", {}, "linux")).toBe(true);
  expect(
    settingAffectsProbe(
      "jadx",
      "JAVA_HOME",
      { JAVA_HOME: "/opt/java" },
      "linux",
    ),
  ).toBe(true);
  // Ghidra still looks either the install directory or the JDK up on PATH.
  expect(
    settingAffectsProbe(
      "ghidra",
      "PATH",
      { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
      "linux",
    ),
  ).toBe(true);
  expect(
    settingAffectsProbe(
      "ghidra",
      "PATH",
      { GHIDRA_INSTALL_DIR: "/opt/ghidra", JAVA_HOME: "/opt/java" },
      "linux",
    ),
  ).toBe(false);
});

test("lets a selected client keep the terminal settings its registration omits", async () => {
  const home = await createTestTempDirectory("rea-opencode-doctor-overlay-");
  await opencodeRegistration(home, { REA_JADX_MCP_JAR: "/opt/jadx.jar" });
  const host = createSystemDoctorHost({
    HOME: home,
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
  });
  try {
    const inspections = await host.providerInspections?.(["opencode"]);
    expect(inspections?.find(({ id }) => id === "ghidra")?.configured).toBe(
      true,
    );
    expect(inspections?.find(({ id }) => id === "jadx")?.configured).toBe(true);
  } finally {
    await host.close?.();
  }
});

test("does not fill a registration's unresolvable expression from the terminal", async () => {
  const home = await createTestTempDirectory("rea-dsh-doctor-expression-");
  // Harness keeps a Cordis expression in the patch, so this process cannot
  // know what the client passes on; the terminal is not that value.
  await mkdir(join(home, ".dsh"), { recursive: true });
  await writeFile(
    join(home, ".dsh/cordis.patch.yml"),
    [
      "- insert:",
      "    - id: rea-mcp",
      '      name: "@deepseek-ai/dsh-mcp-client"',
      "      config:",
      "        serverName: rea",
      "        transport: stdio",
      "        command: rea",
      "        args: [mcp]",
      "        env:",
      "          GHIDRA_INSTALL_DIR: !!js caller.ghidra",
      "          REA_JADX_MCP_JAR: /opt/jadx.jar",
      "",
    ].join("\n"),
    { flag: "w" },
  );
  const host = createSystemDoctorHost({
    HOME: home,
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
  });
  try {
    const inspections = await host.providerInspections?.(["dsh"]);
    expect(inspections?.find(({ id }) => id === "ghidra")).toMatchObject({
      configured: null,
      available: null,
      checks: [expect.objectContaining({ classification: "unknown" })],
    });
    expect(inspections?.find(({ id }) => id === "jadx")?.configured).toBe(true);
  } finally {
    await host.close?.();
  }
});

test("keeps a Qwen registration's variable expression out of the probe", async () => {
  const home = await createTestTempDirectory("rea-qwen-doctor-expression-");
  // Qwen expands $VAR and ${VAR} from the environment it runs with, so a
  // recorded ${PATH} is not the terminal PATH this process sees.
  await mkdir(join(home, ".qwen"), { recursive: true });
  await writeFile(
    join(home, ".qwen/settings.json"),
    JSON.stringify({
      mcpServers: {
        rea: {
          command: "rea",
          args: ["mcp"],
          env: { PATH: "${PATH}:/opt/jdk/bin" },
        },
      },
    }),
    { flag: "w" },
  );
  const host = createSystemDoctorHost({
    HOME: home,
    PATH: "/usr/bin:/bin",
  });
  try {
    const inspections = await host.providerInspections?.(["qwen_code"]);
    expect(inspections?.find(({ id }) => id === "jadx")?.checks).toEqual([
      expect.objectContaining({
        code: "registration_environment_unknown",
        classification: "unknown",
        detail: expect.stringContaining("PATH"),
      }),
    ]);
  } finally {
    await host.close?.();
  }
});

test.each([["win32"], ["linux"]] as const)(
  "folds a registration's spelling into the names a provider check reads: platform=%s",
  (platform) => {
    const settings = selectedProviderSettings(
      {
        environment: {
          ghidra_install_dir: "/opt/ghidra",
          rea_jadx_mcp_jar: "/opt/jadx.jar",
        },
        unresolved: new Set(["rea_ghidra_startup_timeout_ms"]),
      },
      {
        GHIDRA_INSTALL_DIR: "/terminal/ghidra",
        REA_JADX_MCP_JAR: "/terminal/jadx.jar",
        REA_GHIDRA_STARTUP_TIMEOUT_MS: "60000",
        OTHER: "kept",
      },
      platform,
    );
    if (platform === "win32") {
      expect(settings).toEqual({
        GHIDRA_INSTALL_DIR: "/opt/ghidra",
        REA_JADX_MCP_JAR: "/opt/jadx.jar",
        OTHER: "kept",
      });
    } else {
      // POSIX names are case-sensitive: the lowercase registration keys are
      // separate settings and the terminal's uppercase ones survive.
      expect(settings).toEqual({
        GHIDRA_INSTALL_DIR: "/terminal/ghidra",
        REA_JADX_MCP_JAR: "/terminal/jadx.jar",
        ghidra_install_dir: "/opt/ghidra",
        rea_ghidra_startup_timeout_ms: undefined,
        rea_jadx_mcp_jar: "/opt/jadx.jar",
        REA_GHIDRA_STARTUP_TIMEOUT_MS: "60000",
        OTHER: "kept",
      });
    }
  },
);

test("retains a failed registration-file close returned as a read error", async () => {
  const home = await createTestTempDirectory("rea-doctor-registration-close-");
  const close = vi.fn().mockResolvedValue(undefined);
  const path = join(home, ".config/opencode/opencode.json");
  const failure = new RegularFileCleanupFailure({
    path,
    owner: { close } as never,
    outcome: { kind: "failed", cause: new Error("read failed") },
    cleanupCause: new Error("close failed"),
  });
  const read = vi
    .spyOn(configurationFiles, "readEffectiveClientRegistrationConfiguration")
    .mockResolvedValue(
      err({
        kind: "unreadable",
        path,
        detail: "unreadable",
        cleanupFailure: failure,
      }),
    );
  const host = createSystemDoctorHost({ HOME: home });
  try {
    await host.providerInspections?.(["opencode"]);
    await host.close?.();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    read.mockRestore();
    await host.close?.();
  }
});

test("retries a retained registration-file close after a failed retry", async () => {
  const home = await createTestTempDirectory(
    "rea-doctor-registration-close-retry-",
  );
  const close = vi
    .fn()
    .mockRejectedValueOnce(new Error("close still failed"))
    .mockResolvedValue(undefined);
  const path = join(home, ".config/opencode/opencode.json");
  const failure = new RegularFileCleanupFailure({
    path,
    owner: { close } as never,
    outcome: { kind: "failed", cause: new Error("read failed") },
    cleanupCause: new Error("close failed"),
  });
  const read = vi
    .spyOn(configurationFiles, "readEffectiveClientRegistrationConfiguration")
    .mockResolvedValue(
      err({
        kind: "unreadable",
        path,
        detail: "unreadable",
        cleanupFailure: failure,
      }),
    );
  const host = createSystemDoctorHost({ HOME: home });
  try {
    await host.providerInspections?.(["opencode"]).catch(() => undefined);
    await host.close?.().catch(() => undefined);
    await host.close?.();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    read.mockRestore();
    await host.close?.();
  }
});

test("does not use terminal readiness when a selected registration is malformed", async () => {
  const home = await createTestTempDirectory(
    "rea-doctor-malformed-registration-",
  );
  await mkdir(join(home, ".config/opencode"), { recursive: true });
  await writeFile(join(home, ".config/opencode/opencode.json"), "not JSON");
  const host = createSystemDoctorHost({
    HOME: home,
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
  });
  try {
    const inspections = await host.providerInspections?.(["opencode"]);
    expect(inspections?.find(({ id }) => id === "ghidra")).toMatchObject({
      configured: null,
      available: null,
      checks: [expect.objectContaining({ classification: "unknown" })],
    });
    const report = await runDoctor(undefined, host, {
      clients: ["opencode"],
      providers: ["ghidra"],
    });
    expect(report.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "ghidra",
        ok: false,
        classification: "unknown",
      }),
    );
    expect(report.scope_checks).not.toContainEqual(
      expect.objectContaining({
        name: "provider:ghidra",
        classification: "missing_analysis_engine",
      }),
    );
  } finally {
    await host.close?.();
  }
});

test("keeps a known provider configuration when only its Java setting is unresolved", async () => {
  const home = await createTestTempDirectory("rea-dsh-doctor-partial-");
  await mkdir(join(home, ".dsh"), { recursive: true });
  await writeFile(
    join(home, ".dsh/cordis.patch.yml"),
    [
      "- insert:",
      "    - id: rea-mcp",
      '      name: "@deepseek-ai/dsh-mcp-client"',
      "      config:",
      "        serverName: rea",
      "        transport: stdio",
      "        command: rea",
      "        args: [mcp]",
      "        env:",
      "          GHIDRA_INSTALL_DIR: /opt/ghidra",
      "          JAVA_HOME: !!js caller.java",
      "",
    ].join("\n"),
  );
  const host = createSystemDoctorHost({
    HOME: home,
    JAVA_HOME: "/terminal/java",
  });
  try {
    const inspections = await host.providerInspections?.(["dsh"]);
    expect(inspections?.find(({ id }) => id === "ghidra")).toMatchObject({
      configured: true,
      available: null,
      checks: [expect.objectContaining({ classification: "unknown" })],
    });
  } finally {
    await host.close?.();
  }
});

test("keeps a Qwen PATH expression unresolved for provider readiness", async () => {
  const home = await createTestTempDirectory("rea-qwen-doctor-path-");
  const javaHome = await createFakeJdk(home);
  const jar = join(home, "jadx.jar");
  await writeJadxJarInventory(jar);
  await mkdir(join(home, ".qwen"), { recursive: true });
  await writeFile(
    join(home, ".qwen/settings.json"),
    JSON.stringify({
      mcpServers: {
        rea: {
          command: "node",
          args: ["rea"],
          env: { PATH: "${PATH}", REA_JADX_MCP_JAR: jar },
        },
      },
    }),
  );
  const host = createSystemDoctorHost({
    HOME: home,
    PATH: join(javaHome, "bin"),
  });
  try {
    const inspections = await host.providerInspections?.(["qwen_code"]);
    expect(inspections?.find(({ id }) => id === "jadx")).toMatchObject({
      configured: true,
      available: null,
      checks: [expect.objectContaining({ classification: "unknown" })],
    });
  } finally {
    await host.close?.();
  }
});
