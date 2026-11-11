import { describe, expect, it } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";
import { runSetup } from "./Setup.js";
import { currentClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import type { MsixPackageView } from "./MsixPackageStorage.js";
import {
  supportedClientRegistrationProfile,
  registrationWriteBlocker,
  supportedClients,
  type SetupClient,
} from "./SupportedClients.js";

// Host joins keep containment checks meaningful on POSIX test hosts too.
const PROFILE = String.raw`C:\Users\a`;
const ROAMING = join(PROFILE, "AppData", "Roaming");
const LOCAL = join(PROFILE, "AppData", "Local");
const PRIVATE_CONFIG = join(
  LOCAL,
  "Packages",
  "Claude_pzs8sxrjxfjjc",
  "LocalCache",
  "Roaming",
  "Claude",
  "claude_desktop_config.json",
);
const APPDATA_CONFIG = join(ROAMING, "Claude", "claude_desktop_config.json");

/** Claude Desktop as setup resolves it from its MSIX package storage. */
const msixClaudeDesktop = (
  processView: MsixPackageView["processView"],
): SetupClient => ({
  name: "claude_desktop",
  registrationProfile: supportedClientRegistrationProfile("claude_desktop"),
  displayName: "Claude Desktop",
  configPath: PRIVATE_CONFIG,
  quitBeforeSetup: true,
  msixPackage: {
    packageFamilyName: "Claude_pzs8sxrjxfjjc",
    privateConfigPath: PRIVATE_CONFIG,
    appDataConfigPath: APPDATA_CONFIG,
    virtualizedRoots: [ROAMING, LOCAL],
    processView,
  },
});

describe("setup workflow", () => {
  it("omits an aligned managed skill from an otherwise empty plan", async () => {
    const host = new FakeSetupHost();
    host.ghidra = "/opt/ghidra";
    host.skill = "unchanged";
    const result = await runSetup(options(false), host);
    expect(result.status).toBe("ready");
    expect(result.plannedActions).toEqual([]);
    expect(result.appliedActions).toEqual([]);
    expect(host.skillInstalls).toBe(0);
  });

  it("blocks malformed client configuration before file mutation", async () => {
    const host = new FakeSetupHost();
    host.clients = [
      {
        name: "codex",
        registrationProfile: supportedClientRegistrationProfile("codex"),
        displayName: "Codex",
        configPath: "/codex.toml",
      },
    ];
    host.clientInspections.set("codex", {
      status: "invalid",
      remediation: "Repair the existing TOML.",
    });

    const result = await runSetup(
      { ...options(true), clientIds: ["codex"] },
      host,
    );

    expect(result.status).toBe("needs_human");
    expect(result.remediation).toBe("Codex: Repair the existing TOML.");
    expect(host.configurations).toBe(0);
    expect(host.skillInstalls).toBe(0);
  });

  it("blocks malformed configuration before unrelated writes with an existing provider", async () => {
    const host = new FakeSetupHost();
    host.ghidra = "/opt/ghidra";
    host.skill = "unchanged";
    host.clients = [
      {
        name: "claude_desktop",
        registrationProfile:
          supportedClientRegistrationProfile("claude_desktop"),
        displayName: "Claude Desktop",
        configPath: "/claude.json",
      },
      {
        name: "cursor",
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        displayName: "Cursor",
        configPath: "/cursor.json",
      },
    ];
    host.clientInspections.set("claude_desktop", {
      status: "invalid",
      remediation: "Repair the existing JSON.",
    });

    const result = await runSetup(
      { ...options(true), clientIds: ["claude_desktop"] },
      host,
    );

    expect(result.status).toBe("needs_human");
    expect(result.remediation).toBe(
      "Claude Desktop: Repair the existing JSON.",
    );
    expect(host.configurations).toBe(0);
    expect(host.skillInstalls).toBe(0);
  });
});

it("offers shared skill intent when the detected personal copy is current", async () => {
  const host = new FakeSetupHost();
  host.ghidra = "/opt/ghidra";
  host.clients = [
    {
      name: "claude_code",
      registrationProfile: supportedClientRegistrationProfile("claude_code"),
      configPath: "/claude.json",
    },
  ];
  host.skillNeedsInstall = (clients) => Promise.resolve(clients.length === 0);
  const result = await runSetup(
    { ...options(false), structured: false },
    host,
    async (actions, context) => {
      if (context?.stage !== "select") return true;
      expect(actions).toContainEqual(
        expect.objectContaining({ id: "install_skill" }),
      );
      return { approved: false, selectedActionIds: ["install_skill"] };
    },
  );
  expect(result.status).toBe("ready");
  expect(result.plannedActions).toEqual([
    expect.objectContaining({
      id: "install_skill",
      target: join(
        host.homeDirectory,
        ".agents",
        "skills",
        "reverse-engineer-anything",
      ),
    }),
  ]);
  expect(host.configurations).toBe(0);
  expect(host.skillInstalls).toBe(1);
});

describe("setup workflow action selection", () => {
  it("executes only actions selected by the interactive adapter", async () => {
    const host = new FakeSetupHost();
    host.ghidra = "/opt/ghidra";
    host.skill = "unchanged";
    host.clients = [
      {
        name: "codex",
        registrationProfile: supportedClientRegistrationProfile("codex"),
        displayName: "Codex",
        configPath: "/codex.toml",
      },
      {
        name: "cursor",
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        displayName: "Cursor",
        configPath: "/cursor.json",
      },
    ];

    const result = await runSetup(
      { ...options(false), structured: false },
      host,
      () =>
        Promise.resolve({
          approved: true,
          selectedActionIds: ["configure_client:codex"],
        }),
    );

    expect(result.plannedActions.map(({ id }) => id)).toEqual([
      "configure_client:codex",
    ]);
    expect(result.clients).toEqual({ codex: { status: "configured" } });
    expect(host.configurations).toBe(1);
    expect(host.skillInstalls).toBe(0);
  });

  it("preflights only selected clients and offers supported clients without markers", async () => {
    const host = new FakeSetupHost();
    host.ghidra = "/opt/ghidra";
    host.skill = "unchanged";
    host.clients = [];
    host.availableClients = [
      {
        name: "codex",
        registrationProfile: supportedClientRegistrationProfile("codex"),
        displayName: "Codex",
        configPath: "/codex.toml",
      },
      {
        name: "cursor",
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        displayName: "Cursor",
        configPath: "/cursor.json",
      },
    ];
    host.clientInspections.set("cursor", {
      status: "invalid",
      remediation: "Repair the deselected Cursor configuration.",
    });

    const result = await runSetup(
      { ...options(true), clientIds: ["codex"] },
      host,
    );

    expect(result.status).toBe("ready");
    expect(result.plannedActions.map(({ id }) => id)).toEqual([
      "configure_client:codex",
    ]);
    expect(host.configurations).toBe(1);
    expect(result.clientStates).toMatchObject([
      { client: { name: "codex" }, detected: false, status: "missing" },
      { client: { name: "cursor" }, detected: false, status: "missing" },
    ]);
  });

  it("does not default to a foreign command registered under the rea key", async () => {
    const host = new FakeSetupHost();
    host.ghidra = "/opt/ghidra";
    host.skill = "unchanged";
    host.clients = [
      {
        name: "codex",
        registrationProfile: supportedClientRegistrationProfile("codex"),
        configPath: "/codex.toml",
      },
    ];
    host.productRegistrations = [
      {
        client: "codex",
        config_path: "/codex.toml",
        command_identity: "foreign",
        command: ["unrelated-agent", "serve"],
        state: "stale",
        remediation: "Refresh this registration.",
      },
    ];

    const result = await runSetup(options(true), host);

    expect(result.status).toBe("ready");
    expect(result.plannedActions).toEqual([]);
    expect(host.configurations).toBe(0);
    expect(result.clientStates).toMatchObject([
      { client: { name: "codex" }, configured: false },
    ]);
  });

  it("uses a Windows-safe executable command for an explicit client", async () => {
    const host = new FakeSetupHost("win32");
    host.scopedDoctorHealthy = true;
    host.skill = "unchanged";
    host.clients = [
      {
        name: "codex",
        registrationProfile: supportedClientRegistrationProfile("codex"),
        configPath: "C:\\config\\codex.toml",
      },
    ];

    const result = await runSetup(
      { ...options(true), clientIds: ["codex"], installSkill: false },
      host,
    );

    expect(result.status).toBe("ready");
    expect(host.configuredCommands).toEqual([
      currentClientRegistrationCommand({
        platform: "win32",
        entrypointPath: CURRENT_ENTRYPOINT_PATH,
      }),
    ]);
    expect(
      currentClientRegistrationCommand({
        platform: "win32",
        entrypointPath: CURRENT_ENTRYPOINT_PATH,
      }),
    ).toEqual([process.execPath, CURRENT_ENTRYPOINT_PATH, "mcp"]);
    expect(
      currentClientRegistrationCommand({
        platform: "win32",
        entrypointPath: undefined,
      }),
    ).toEqual([]);
  });
});

describe("setup configuration failure recovery", () => {
  it.each([
    [
      "path",
      "Agent configuration path could not be safely verified. Check its permissions and, if it is a symbolic link, verify that the link resolves to a regular file owned by the current user, then rerun setup.",
    ],
    [
      "backup",
      "Agent configuration could not be backed up, so no change was made. Check file permissions, then rerun setup.",
    ],
    [
      "write",
      "Agent configuration could not be updated. Check file permissions, then rerun setup.",
    ],
    [
      "readback",
      "Agent configuration could not be verified. Repair the configuration file, then rerun setup.",
    ],
  ] as const)("explains %s configuration recovery", async (reason, message) => {
    const host = new FakeSetupHost();
    host.ghidra = "/opt/ghidra";
    host.clients = [
      {
        name: "internal_client_key",
        // Source-only recovery actor models Cursor JSON registration.
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        configPath: "/agent.json",
      },
    ];
    host.clientResults.set("internal_client_key", { status: "failed", reason });
    // Exercise registration recovery without selecting a synthetic skill client.
    const result = await runSetup(
      {
        ...options(true),
        clientIds: ["internal_client_key"],
        installSkill: false,
      },
      host,
    );
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toBe(message);
    expect(result.remediation).not.toContain("internal_client_key");
    expect(result.plannedActions).toEqual([
      expect.objectContaining({
        id: "configure_client:internal_client_key",
        kind: "configure_client",
        target: "/agent.json",
      }),
    ]);
    expect(result.clients).toEqual({
      internal_client_key: { status: "failed", reason },
    });
    expect(result.appliedActions).toEqual([]);
    expect(host.configurations).toBe(1);
    expect(host.skillDirectoryValidations).toEqual([]);
    expect(host.skillInstalls).toBe(0);
  });

  it("names the recovery backup that holds the restored original after a readback failure", async () => {
    const host = new FakeSetupHost();
    host.ghidra = "/opt/ghidra";
    host.clients = [
      {
        name: "cursor",
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        configPath: "/agent.json",
      },
    ];
    const backupPath = `/agent.json.rea.backup.${"a".repeat(64)}.recovery`;
    host.clientResults.set("cursor", {
      status: "failed",
      reason: "readback",
      backupPath,
    });
    const result = await runSetup(
      { ...options(true), clientIds: ["cursor"] },
      host,
    );
    expect(result.remediation).toBe(
      `Agent configuration could not be verified after writing. The original was restored and its backup at ${backupPath} was retained. Repair the configuration file or restore that backup, then rerun setup.`,
    );
  });
});

describe("MSIX Claude Desktop setup", () => {
  it("discloses which file MSIX Claude Desktop reads and that it must be quit", async () => {
    const host = new FakeSetupHost("win32");
    host.ghidra = "/opt/ghidra";
    host.skill = "unchanged";
    host.clients = [msixClaudeDesktop("direct")];

    const result = await runSetup(
      { ...options(false), clientIds: ["claude_desktop"], dryRun: true },
      host,
    );

    expect(result.status).toBe("planned");
    const [action] = result.plannedActions;
    expect(action?.target).toBe(PRIVATE_CONFIG);
    expect(action?.detail).toContain(
      `Claude Desktop is installed as MSIX package Claude_pzs8sxrjxfjjc, which reads this package-private file instead of ${APPDATA_CONFIG}.`,
    );
    expect(action?.detail).toContain(
      "Quit Claude Desktop fully before approving; closing its window is not enough.",
    );
  });

  it("names the files to edit by hand when the process view is unknown", () => {
    // The package reads its private copy, so a manual setup edit belongs there.
    const client = msixClaudeDesktop("unknown");
    expect(registrationWriteBlocker(client, "setup")).toContain(
      `Add REA's entry to ${PRIVATE_CONFIG} by hand`,
    );
    expect(registrationWriteBlocker(client, "uninstall")).toContain(
      `Remove REA's entry by hand from each of ${PRIVATE_CONFIG} and ${APPDATA_CONFIG} that has one`,
    );
  });

  it("refuses AppData writes from a process the MSIX package started", async () => {
    const host = new FakeSetupHost("win32");
    host.ghidra = "/opt/ghidra";
    host.skill = "unchanged";
    const vscode = join(ROAMING, "Code", "User", "mcp.json");
    host.clients = [
      msixClaudeDesktop("redirected"),
      {
        name: "vscode",
        registrationProfile: supportedClientRegistrationProfile("vscode"),
        displayName: "VS Code",
        configPath: vscode,
      },
      {
        name: "codex",
        registrationProfile: supportedClientRegistrationProfile("codex"),
        displayName: "Codex",
        configPath: join(PROFILE, ".codex", "config.toml"),
      },
    ];

    const blocked = await runSetup(
      { ...options(true), clientIds: ["vscode", "codex"] },
      host,
    );
    expect(blocked.status).toBe("needs_human");
    expect(blocked.remediation).toContain(
      `Changes to ${vscode} would not reach the files other apps read.`,
    );
    expect(host.configurations).toBe(0);

    const homeOnly = await runSetup(
      { ...options(true), clientIds: ["codex"] },
      host,
    );
    expect(homeOnly.status).toBe("ready");
    expect(host.configurations).toBe(1);
  });

  it("blocks redirected AppData writes when migrated Claude storage is unresolved", async () => {
    const home = await createTestTempDirectory("setup-claude-migrated-");
    const local = join(home, "Local");
    const roaming = join(home, "Roaming");
    const family = "Claude_pzs8sxrjxfjjc";
    const privateRoaming = join(
      local,
      "Packages",
      family,
      "LocalCache",
      "Roaming",
    );
    const privateClaude = join(privateRoaming, "Claude");
    await mkdir(privateClaude, { recursive: true });
    await writeFile(join(privateClaude, "claude_desktop_config.json"), "{}");
    await mkdir(join(local, "Claude-Data", family.toLowerCase()), {
      recursive: true,
    });
    await symlink(privateRoaming, roaming, "junction");

    const host = new FakeSetupHost("win32");
    host.ghidra = "/opt/ghidra";
    host.skill = "unchanged";
    host.clients = supportedClients(home, "win32", {
      APPDATA: roaming,
      LOCALAPPDATA: local,
    });
    expect(
      host.clients.find(({ name }) => name === "claude_desktop")
        ?.configPathError,
    ).toContain("migrated Claude Desktop storage");

    const blocked = await runSetup(
      { ...options(true), clientIds: ["vscode"] },
      host,
    );
    expect(blocked.status).toBe("needs_human");
    expect(blocked.remediation).toContain(
      `Changes to ${join(roaming, "Code", "User", "mcp.json")} would not reach the files other apps read.`,
    );
    expect(host.configurations).toBe(0);
  });

  it("refuses registrations whose launcher only one MSIX package can see", async () => {
    const host = new FakeSetupHost("win32");
    host.ghidra = "/opt/ghidra";
    host.registrationCommandBlocker = "Install REA outside the package.";
    host.clients = [
      {
        name: "codex",
        registrationProfile: supportedClientRegistrationProfile("codex"),
        displayName: "Codex",
        configPath: "/codex.toml",
      },
    ];

    const blocked = await runSetup(
      { ...options(true), clientIds: ["codex"] },
      host,
    );
    expect(blocked.status).toBe("needs_human");
    expect(blocked.remediation).toBe("Install REA outside the package.");
    expect(host.configurations).toBe(0);
    expect(host.skillInstalls).toBe(0);

    const skillOnly = await runSetup(
      { ...options(true), clientIds: [], installSkill: true },
      host,
    );
    expect(skillOnly.status).toBe("ready");
    expect(host.skillInstalls).toBe(1);
  });
});

describe("setup tool family scope", () => {
  it("writes the requested scope into the registration environment", async () => {
    const host = new FakeSetupHost();
    host.doctorHealthy = true;
    host.skill = "unchanged";
    host.clients = [
      {
        name: "cursor",
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        configPath: "/cursor.json",
      },
    ];

    const plan = await runSetup(
      {
        ...options(false),
        clientIds: ["cursor"],
        toolFamilies: "session,application",
      },
      host,
    );
    expect(plan.plannedActions[0]?.detail).toContain(
      "REA_MCP_TOOL_FAMILIES=session,application",
    );

    const applied = await runSetup(
      {
        ...options(true),
        clientIds: ["cursor"],
        toolFamilies: "session,application",
      },
      host,
    );
    expect(applied.status).toBe("ready");
    expect(host.configuredProviderEnvironments).toContainEqual({
      REA_MCP_TOOL_FAMILIES: "session,application",
    });
  });
});
