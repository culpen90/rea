import { describe, expect, it } from "vitest";

import { SUPPORTED_NODE_VERSION_PROSE } from "../domain/runtimeVersion.js";
import { parseLinuxDistribution } from "./LinuxDistribution.js";
import type { ClientRegistrationStatus } from "./ClientRegistrationStatus.js";
import { createDoctorHostFixture as host } from "./Doctor.fixture.js";
import { runDoctor, systemDoctorHost, type DoctorHost } from "./Doctor.js";

const configurationHost = (
  environment: Readonly<NodeJS.ProcessEnv>,
): DoctorHost => ({
  ...systemDoctorHost({ environment: { ...environment } }),
  ...host({
    providerInspections: async () => [
      {
        id: "ghidra",
        configured: true,
        available: true,
        providerVersion: "12.1.4",
        registrationEnvironment: {},
        checks: [],
      },
    ],
    installationPaths: () => Promise.resolve([]),
    clientRegistrations: () => Promise.resolve([]),
  }),
});

describe("doctor native analysis configuration", () => {
  it.each([
    ["REA_ANALYSIS_PROVIDER", "Hopper"],
    ["REA_MCP_INITIALIZE_BUDGET_MS", "0"],
    ["REA_MCP_TOOLS_LIST_BUDGET_MS", "0"],
    ["REA_MCP_FIRST_CATALOG_BUDGET_MS", "0"],
    ["REA_MCP_DOCTOR_DEADLINE_MS", "0"],
    ["REA_SWIFTC_COMPILE_TIMEOUT_MS", "0"],
    ["REA_LOG_LEVEL", "verbose"],
    ["REA_GHIDRA_COMPILER_SPEC_ID", "gcc"],
  ] as const)(
    "rejects %s before scoped Ghidra readiness reports success",
    async (setting, value) => {
      const result = await runDoctor(
        undefined,
        configurationHost({ [setting]: value }),
        { providers: ["ghidra"] },
      );

      expect(result.healthy).toBe(false);
      expect(result.environment_healthy).toBe(false);
      expect(result.scope_checks).toContainEqual(
        expect.objectContaining({
          name: `runtime-configuration:${setting}`,
          ok: false,
          classification: "config_drift",
          detail: expect.stringContaining(setting),
          remediation: expect.stringContaining(setting),
          details: { setting },
        }),
      );
    },
  );

  it("keeps a lowercase provider preference ready for the selected engine", async () => {
    const result = await runDoctor(
      undefined,
      configurationHost({ REA_ANALYSIS_PROVIDER: "ghidra" }),
      { providers: ["ghidra"] },
    );

    expect(result.healthy).toBe(true);
    expect(
      result.checks.some(({ name }) =>
        name.startsWith("runtime-configuration:"),
      ),
    ).toBe(false);
  });

  it("keeps an invalid native setting informational when nothing starts MCP", async () => {
    const result = await runDoctor(
      undefined,
      configurationHost({ REA_GHIDRA_LANGUAGE_ID: "" }),
      { providers: [] },
    );

    expect(result.healthy).toBe(true);
    expect(result.environment_healthy).toBe(false);
    expect(result.scope_checks.map(({ name }) => name)).not.toContain(
      "runtime-configuration:REA_GHIDRA_LANGUAGE_ID",
    );
    expect(result.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "runtime-configuration:REA_GHIDRA_LANGUAGE_ID",
        ok: false,
      }),
    );
  });

  it("does not treat a JEB-only timeout as native analysis configuration", async () => {
    const result = await runDoctor(
      undefined,
      configurationHost({ REA_JEB_MCP_TIMEOUT_MS: "abc" }),
      { providers: ["ghidra"] },
    );

    expect(result.healthy).toBe(true);
    expect(
      result.checks.some(({ name }) =>
        name.startsWith("runtime-configuration:"),
      ),
    ).toBe(false);
  });
});

describe("doctor MCP startup readiness", () => {
  const alignedCodex: ClientRegistrationStatus = {
    client: "codex",
    config_path: "/home/user/.codex/config.toml",
    command_identity: "owned",
    command: ["/current/rea", "mcp"],
    state: "aligned",
    remediation: null,
  };
  const selectedHost = (
    environment: Readonly<NodeJS.ProcessEnv>,
  ): DoctorHost => ({
    ...configurationHost(environment),
    clientRegistrations: () => Promise.resolve([alignedCodex]),
  });

  it("requires an invalid log level for a client and for the skill", async () => {
    const client = await runDoctor(
      undefined,
      selectedHost({
        REA_LOG_LEVEL: "verbose",
        REA_GHIDRA_LANGUAGE_ID: "",
      }),
      { clients: ["codex"] },
    );
    expect(client.healthy).toBe(false);
    expect(client.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "runtime-configuration:REA_LOG_LEVEL",
        ok: false,
        details: { setting: "REA_LOG_LEVEL" },
      }),
    );
    expect(client.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "runtime-configuration:REA_GHIDRA_LANGUAGE_ID",
        ok: false,
      }),
    );
    expect(client.scope_checks).toContainEqual(
      expect.objectContaining({ name: "registration:codex", ok: true }),
    );

    const skill = await runDoctor(
      undefined,
      selectedHost({
        REA_LOG_LEVEL: "verbose",
        REA_GHIDRA_LANGUAGE_ID: "",
      }),
      { skill: true },
    );
    expect(skill.healthy).toBe(false);
    expect(skill.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "runtime-configuration:REA_LOG_LEVEL",
        ok: false,
      }),
    );
    expect(skill.scope_checks.map(({ name }) => name)).not.toContain(
      "runtime-configuration:REA_GHIDRA_LANGUAGE_ID",
    );
  });

  it("requires every MCP startup failure for an aligned client", async () => {
    const ghidraLanguage = await runDoctor(
      undefined,
      selectedHost({ REA_GHIDRA_LANGUAGE_ID: "" }),
      { clients: ["codex"] },
    );
    expect(ghidraLanguage.healthy).toBe(false);
    expect(ghidraLanguage.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "runtime-configuration:REA_GHIDRA_LANGUAGE_ID",
        ok: false,
      }),
    );
    expect(ghidraLanguage.scope_checks).toContainEqual(
      expect.objectContaining({ name: "registration:codex", ok: true }),
    );

    const skill = await runDoctor(
      undefined,
      selectedHost({ REA_GHIDRA_LANGUAGE_ID: "" }),
      { skill: true },
    );
    expect(skill.healthy).toBe(true);
    expect(skill.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "runtime-configuration:REA_GHIDRA_LANGUAGE_ID",
        ok: false,
      }),
    );
  });
});

describe("doctor runtime check", () => {
  it("reports Node 25 as unsupported", async () => {
    const result = await runDoctor(
      undefined,
      host({ runtime: { id: "node", version: "25.1.0" } }),
    );

    expect(result.healthy).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "node",
        ok: false,
        detail: "25.1.0",
        details: { runtime: "node", version: "25.1.0" },
        classification: "missing_dependency",
      }),
    );
  });

  it.each([
    { compatibility: "26.12.1", ok: true },
    { compatibility: "26.12.0", ok: false },
    { compatibility: "25.1.0", ok: false },
  ])(
    "identifies Bun and admits it by Node.js compatibility $compatibility",
    async ({ compatibility, ok }) => {
      const result = await runDoctor(
        undefined,
        host({
          runtime: {
            id: "bun",
            version: "1.4.2",
            nodeCompatibilityVersion: compatibility,
          },
        }),
      );

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          name: "node",
          ok,
          classification: ok ? "healthy" : "missing_dependency",
          details: {
            runtime: "bun",
            version: "1.4.2",
            node_compatibility_version: compatibility,
          },
        }),
      );
    },
  );
});

it.each([
  undefined,
  "",
  "not-a-version",
  "14garbage",
  "14.garbage",
  "14.",
  "14.0\n",
  "99999999999999999",
])("retains unknown host support for macOS probe value %s", async (version) => {
  const result = await runDoctor(
    undefined,
    host({ macosVersion: () => Promise.resolve(version) }),
  );
  expect(result.checks).toContainEqual(
    expect.objectContaining({
      name: "host",
      ok: false,
      classification: "unknown",
    }),
  );
});

it.skipIf(process.platform !== "darwin")(
  "reads the macOS version without PATH utilities",
  async () => {
    const system = systemDoctorHost({
      environment: { PATH: "/nonexistent" },
    });
    try {
      expect(await system.macosVersion()).toMatch(/^\d+(?:\.\d+)*$/u);
    } finally {
      await system.close?.();
    }
  },
);

describe("doctor", () => {
  it("returns exact recovery for every failed diagnostic", async () => {
    const result = await runDoctor(
      "/missing/app",
      host({
        runtime: { id: "node", version: "20.0.0" },
        macosVersion: () => Promise.resolve("11.7"),
        validTarget: () => Promise.resolve(false),
      }),
    );
    expect(
      Object.fromEntries(
        result.checks.map(({ name, remediation }) => [name, remediation]),
      ),
    ).toEqual({
      node: `Install ${SUPPORTED_NODE_VERSION_PROSE}.`,
      host: "REA supports macOS 12+, Linux distributions with a recognized apt, dnf, or pacman package family, and the experimental Windows x64 Ghidra P0 boundary.",
      target: "Supply a readable local app or program path.",
    });
  });

  it.each(["11.7"])("rejects unsupported macOS version %s", async (version) => {
    const result = await runDoctor(
      undefined,
      host({ macosVersion: () => Promise.resolve(version) }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "host",
        ok: false,
        classification: "unsupported_host",
      }),
    );
  });

  it("admits only the experimental Windows x64 host boundary", async () => {
    const windows = await runDoctor(
      undefined,
      host({
        platform: "win32",
        architecture: "x64",
        macosVersion: () => Promise.resolve(undefined),
      }),
    );
    const arm = await runDoctor(
      undefined,
      host({
        platform: "win32",
        architecture: "arm64",
        macosVersion: () => Promise.resolve(undefined),
      }),
    );

    expect(windows.checks.find(({ name }) => name === "host")).toMatchObject({
      ok: true,
      detail: "win32 x64",
    });
    expect(arm.checks.find(({ name }) => name === "host")).toMatchObject({
      ok: false,
      detail: "win32 arm64",
    });
  });

  it("reports optional BYO ilspycmd diagnostics only when configured", async () => {
    const result = await runDoctor(
      undefined,
      host({
        configuredIlspyCmdPath: "/tools/ilspycmd",
        ilspyCmdVersion: (path) =>
          Promise.resolve(
            path === "/tools/ilspycmd" ? "ilspycmd: 9.1.0.7988" : undefined,
          ),
      }),
    );
    expect(result.healthy).toBe(true);
    expect(result.checks).toContainEqual({
      name: "ilspycmd",
      ok: true,
      classification: "healthy",
      detail: "/tools/ilspycmd (ilspycmd: 9.1.0.7988)",
    });
  });

  it("reports configured ilspycmd drift without installing it", async () => {
    const result = await runDoctor(
      undefined,
      host({
        configuredIlspyCmdPath: "/missing/ilspycmd",
        ilspyCmdVersion: () => Promise.resolve(undefined),
      }),
    );
    expect(result.healthy).toBe(false);
    expect(result.checks).toContainEqual({
      name: "ilspycmd",
      ok: false,
      classification: "config_drift",
      detail: "/missing/ilspycmd",
      remediation: expect.stringMatching(
        /REA_ILSPY_CMD_PATH.*runnable ilspycmd/i,
      ),
    });
  });
});

describe("doctor installation identity", () => {
  it("names each stale or missing skill destination and its exact repair selection", async () => {
    const result = await runDoctor(
      undefined,
      host({
        installedSkillIdentity: () =>
          Promise.resolve({
            version: "current-first-copy",
            toolCount: 0,
            canonical: false,
            issues: [
              {
                client: "claude_code",
                path: "/home/.claude/skills/rea",
                kind: "stale",
                detail: "Selected skill copy is stale",
              },
              {
                client: "shared",
                path: "/home/.agents/skills/rea",
                kind: "missing",
                detail: "Selected skill copy is missing",
              },
            ],
          }),
      }),
    );
    expect(result.identity?.skill).toMatchObject({ state: "stale" });
    expect(result.identity?.skill.remediation).toContain(
      "rea setup --skill-client claude_code --skill",
    );
    expect(result.identity?.skill.remediation).toContain(
      "rea setup --skill-client shared --skill",
    );
    expect(result.identity?.skill.remediation).toContain(
      "/home/.claude/skills/rea",
    );
    expect(result.identity?.skill.remediation).toContain(
      "/home/.agents/skills/rea",
    );
  });

  it("distinguishes stale skills, path shadowing, and unobservable live state", async () => {
    const result = await runDoctor(
      undefined,
      host({
        installationPaths: () =>
          Promise.resolve(["/usr/local/bin/rea", "/home/user/bin/rea"]),
        installedSkillIdentity: () =>
          Promise.resolve({
            version: "10",
            toolCount: null,
            canonical: false,
          }),
      }),
    );

    expect(result.identity).toMatchObject({
      live_server: { state: "unknown" },
      installations: { state: "multiple" },
      skill: {
        installed_version: "10",
        state: "stale",
        remediation: expect.stringMatching(/rea setup.*update.*skill/i),
      },
    });
  });
  it("reports a missing installed skill as unhealthy", async () => {
    const result = await runDoctor(
      undefined,
      host({ installedSkillIdentity: () => Promise.resolve(undefined) }),
    );

    expect(result.healthy).toBe(false);
    expect(result.identity?.skill).toMatchObject({
      state: "missing",
      remediation: expect.stringMatching(/rea setup.*update.*skill/i),
    });
    expect(result.checks).toContainEqual({
      name: "skill:identity",
      ok: false,
      classification: "config_drift",
      detail: expect.stringMatching(/skill identity.*missing/i),
      remediation: result.identity?.skill.remediation,
    });
  });
  it("classifies an unreadable installed skill as unknown, not drift", async () => {
    const result = await runDoctor(
      undefined,
      host({
        installedSkillIdentity: () =>
          Promise.resolve({
            version: null,
            toolCount: null,
            canonical: false,
            issues: [
              {
                client: "shared",
                path: "/home/.agents/skills/rea",
                kind: "unreadable",
                detail: "Selected skill copy could not be read",
              },
            ],
          }),
      }),
    );

    expect(result.identity?.skill).toMatchObject({ state: "unknown" });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "skill:identity",
        ok: false,
        classification: "unknown",
      }),
    );
  });
  it("reports stale client registration paths without claiming live state", async () => {
    const result = await runDoctor(
      undefined,
      host({
        clientRegistrations: () =>
          Promise.resolve([
            {
              client: "codex",
              config_path: "/home/user/.codex/config.toml",
              command_identity: "owned",
              command: ["/old/rea", "mcp"],
              state: "stale",
              remediation:
                "Run rea setup to refresh this registration, then restart the client.",
            },
          ]),
      }),
    );

    expect(result.healthy).toBe(false);
    expect(result.identity).toMatchObject({
      live_server: { state: "unknown" },
      registrations: [{ client: "codex", state: "stale" }],
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "registration:codex",
        classification: "config_drift",
      }),
    );
  });
});

describe("doctor scoped readiness", () => {
  it("checks explicitly selected skill destinations independently of registrations", async () => {
    const selected: (readonly string[] | undefined)[] = [];
    const result = await runDoctor(
      undefined,
      host({
        clientRegistrations: () => Promise.resolve([]),
        installedSkillIdentity: (clients) => {
          selected.push(clients);
          return Promise.resolve({
            version: "stale",
            toolCount: 0,
            canonical: false,
          });
        },
      }),
      {
        clients: [],
        skillClients: ["claude_code", "claude_code"],
        skill: true,
      },
    );

    expect(selected).toEqual([["claude_code"]]);
    expect(result.scope).toMatchObject({
      mode: "explicit",
      clients: [],
      skill_clients: ["claude_code"],
      skill: true,
    });
    expect(result.healthy).toBe(false);
    expect(result.scope_checks.map(({ name }) => name)).toEqual([
      "node",
      "skill:identity",
    ]);
  });

  it("scopes effective readiness to selected clients without hiding drift", async () => {
    const registrations: readonly ClientRegistrationStatus[] = [
      {
        client: "codex",
        config_path: "/home/user/.codex/config.toml",
        command_identity: "owned",
        command: ["/current/rea", "mcp"],
        state: "aligned",
        remediation: null,
      },
      {
        client: "cursor",
        config_path: "/home/user/.cursor/mcp.json",
        command_identity: "unknown",
        command: ["/old/rea", "mcp"],
        state: "unknown",
        remediation: "Run rea setup to refresh this registration.",
      },
    ];
    const scoped = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve(registrations) }),
      { clients: ["codex"] },
    );

    expect(scoped).toMatchObject({
      healthy: true,
      environment_healthy: false,
      scope: { mode: "explicit", clients: ["codex"] },
    });
    expect(scoped.scope_checks).toContainEqual(
      expect.objectContaining({ name: "registration:codex", ok: true }),
    );
    expect(scoped.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "registration:cursor",
        ok: false,
        classification: "unknown",
      }),
    );

    const staleSelected = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve(registrations) }),
      { clients: ["cursor"] },
    );
    expect(staleSelected.healthy).toBe(false);
  });

  it("keeps a caller-selected short timeout healthy and reports its advisory as informational", async () => {
    const result = await runDoctor(
      undefined,
      host({
        clientRegistrations: () =>
          Promise.resolve([
            {
              client: "kimi",
              config_path: "/home/user/.kimi-code/mcp.json",
              command_identity: "owned",
              command: ["/current/rea", "mcp"],
              state: "aligned",
              remediation: null,
              advisory: "The configured toolTimeoutMs is shorter than startup.",
            },
          ]),
      }),
      { clients: ["kimi"] },
    );

    expect(result.healthy).toBe(true);
    expect(result.scope_checks).toContainEqual(
      expect.objectContaining({ name: "registration:kimi", ok: true }),
    );
    expect(result.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "registration_timeout:kimi",
        ok: true,
        detail: "The configured toolTimeoutMs is shorter than startup.",
      }),
    );
  });
});

describe("Grok Bot readiness", () => {
  it("does not treat a Grok Bot data directory as an aligned registration", async () => {
    const registrations: readonly ClientRegistrationStatus[] = [
      {
        client: "grok_bot",
        config_path: "/home/user/.grokbot",
        command_identity: "unknown",
        command: [],
        state: "manual",
        remediation: "Add the connector from the Grok Bot chat.",
      },
    ];
    const audit = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve(registrations) }),
    );
    expect(audit.checks.map(({ name }) => name)).not.toContain(
      "registration:grok_bot",
    );
    expect(audit.identity?.registrations).toEqual(registrations);

    const scoped = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve(registrations) }),
      { clients: ["grok_bot"] },
    );
    expect(scoped.healthy).toBe(false);
    expect(scoped.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "registration:grok_bot",
        ok: false,
        remediation: "Add the connector from the Grok Bot chat.",
      }),
    );

    const absent = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve([]) }),
      { clients: ["grok_bot"] },
    );
    expect(absent.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "registration:grok_bot",
        ok: false,
        remediation: expect.stringContaining("hosted computer"),
      }),
    );
  });
});

describe("doctor scoped readiness", () => {
  it("keeps agent readiness independent of host requirements", async () => {
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        linuxDistribution: () =>
          Promise.resolve(parseLinuxDistribution("ID=nixos\n")),
        clientRegistrations: () =>
          Promise.resolve([
            {
              client: "codex",
              config_path: "/home/user/.codex/config.toml",
              command_identity: "owned",
              command: ["rea", "mcp"],
              state: "aligned",
              remediation: null,
            },
          ]),
      }),
      { clients: ["codex"] },
    );

    expect(result).toMatchObject({
      healthy: true,
      environment_healthy: false,
      scope: { mode: "explicit", clients: ["codex"], providers: [] },
    });
    expect(result.scope_checks.map(({ name }) => name)).toEqual([
      "node",
      "registration:codex",
    ]);
    expect(result.informational_checks).toContainEqual(
      expect.objectContaining({ name: "host", ok: false }),
    );
  });

  it.each([
    ['ID=kali\nVERSION_ID="2026.3"\nID_LIKE=debian\n', "kali 2026.3"],
    ["ID=derivative\nID_LIKE='debian'\n", "derivative unknown"],
    ['ID=nobara\nVERSION_ID="44"\nID_LIKE="rhel centos fedora"\n', "nobara 44"],
    ["ID=manjaro\nID_LIKE=arch\n", "manjaro unknown"],
  ])(
    "accepts a Linux host from its distribution facts (%s)",
    async (osRelease, detail) => {
      const result = await runDoctor(
        undefined,
        host({
          platform: "linux",
          macosVersion: () => Promise.resolve(undefined),
          linuxDistribution: () =>
            Promise.resolve(parseLinuxDistribution(osRelease)),
        }),
      );

      expect(result.checks).toContainEqual(
        expect.objectContaining({ name: "host", ok: true, detail }),
      );
    },
  );

  it("requires explicitly selected providers instead of any available provider", async () => {
    const ghidra = {
      id: "ghidra",
      configured: true,
      available: true,
      providerVersion: "12.1.4",
      registrationEnvironment: { GHIDRA_INSTALL_DIR: "/tools/ghidra" },
      checks: [
        {
          name: "configuration",
          ok: true,
          code: null,
          detail: "/tools/ghidra",
          remediation: null,
          classification: "config_drift" as const,
        },
      ],
    };
    const onlyGhidra = host({
      providerInspections: () => Promise.resolve([ghidra]),
    });

    const jadx = await runDoctor(undefined, onlyGhidra, {
      providers: ["jadx"],
    });
    expect(jadx).toMatchObject({
      healthy: false,
      environment_healthy: true,
    });

    const selectedGhidra = await runDoctor(undefined, onlyGhidra, {
      providers: ["ghidra"],
    });
    expect(selectedGhidra.healthy).toBe(true);
  });
});

describe("doctor target admission on Linux", () => {
  it("uses shared app target validation when a target is supplied", async () => {
    const result = await runDoctor(
      "/Applications/Notes.app",
      host({
        validTarget: (path) =>
          Promise.resolve(path === "/Applications/Notes.app"),
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "target",
        ok: true,
        classification: "healthy",
        detail: "/Applications/Notes.app",
      }),
    );
  });
});

describe("doctor target admission diagnostics", () => {
  it("preserves route-specific target diagnostics from the host", async () => {
    const targetCheck = {
      name: "target",
      ok: false,
      classification: "unsupported_target" as const,
      detail: "/fixture/javascript-app",
      remediation: "Use analyze_javascript_application with input_path.",
    };
    const result = await runDoctor(
      targetCheck.detail,
      host({
        inspectTarget: () => Promise.resolve(targetCheck),
        validTarget: () => {
          throw new Error("the detailed target check should be used");
        },
      }),
    );
    expect(result.checks).toContainEqual(targetCheck);
  });
});
