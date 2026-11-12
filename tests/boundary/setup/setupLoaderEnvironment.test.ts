import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCli } from "../../../src/cli.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("applies an approved Ghidra migration to the selected registration with a backup", async () => {
  const home = await createTestTempDirectory("rea-setup-provider-migration-");
  const path = join(home, ".cursor/mcp.json");
  const initial = {
    theme: "dark",
    mcpServers: {
      rea: {
        command: "rea",
        args: ["mcp"],
        env: {
          REA_ANALYSIS_PROVIDER: "hopper",
          HOPPER_LAUNCHER_PATH: "/legacy/launcher",
          CALLER_SETTING: "preserve",
        },
      },
      other: { command: "other-server" },
    },
  };
  const original = JSON.stringify(initial);
  await mkdir(join(home, ".cursor"));
  await writeFile(path, original);
  const environment = {
    HOME: home,
    USERPROFILE: home,
    REA_ANALYSIS_PROVIDER: "ghidra",
    GHIDRA_INSTALL_DIR: join(home, "ghidra"),
    JAVA_HOME: join(home, "jdk"),
    REA_TARGET_PATH: join(home, "target-specific"),
    HOPPER_LOADER_ARGS_JSON: "legacy ambient value",
    CALLER_UNRELATED_SETTING: "ambient value",
  };
  const setup = async (approval: "--yes" | "--dry-run") => {
    let stdout = "";
    await createCli(environment).serve(
      ["setup", "--client", "cursor", "--skill=false", approval, "--json"],
      {
        env: environment,
        stdout: (chunk) => {
          stdout += chunk;
        },
        exit: () => undefined,
      },
    );
    return JSON.parse(stdout) as unknown;
  };

  expect(await setup("--dry-run")).toMatchObject({
    status: "planned",
    plannedActions: [
      expect.objectContaining({
        kind: "configure_client",
        detail: expect.stringContaining("REA_ANALYSIS_PROVIDER=ghidra"),
      }),
    ],
  });
  await expect(readFile(path, "utf8")).resolves.toBe(original);

  expect(await setup("--yes")).toMatchObject({ status: "ready" });
  const updated = await readFile(path, "utf8");
  const saved = JSON.parse(updated);
  expect(saved).toMatchObject({
    theme: initial.theme,
    mcpServers: {
      other: initial.mcpServers.other,
      rea: {
        env: {
          ...initial.mcpServers.rea.env,
          REA_ANALYSIS_PROVIDER: "ghidra",
          GHIDRA_INSTALL_DIR: environment.GHIDRA_INSTALL_DIR,
          JAVA_HOME: environment.JAVA_HOME,
        },
      },
    },
  });
  expect(saved.mcpServers.rea.env).not.toHaveProperty("REA_TARGET_PATH");
  expect(saved.mcpServers.rea.env).not.toHaveProperty(
    "HOPPER_LOADER_ARGS_JSON",
  );
  expect(saved.mcpServers.rea.env).not.toHaveProperty(
    "CALLER_UNRELATED_SETTING",
  );
  await expect(readFile(`${path}.rea.backup`, "utf8")).resolves.toBe(original);
  expect(await setup("--yes")).toMatchObject({
    status: "ready",
    plannedActions: [],
    appliedActions: [],
  });
  await expect(readFile(path, "utf8")).resolves.toBe(updated);
}, 120_000);
