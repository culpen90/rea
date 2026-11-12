import { describe, expect, it } from "vitest";

import {
  GhidraHeadlessLauncher,
  ghidraHeadlessCommand,
  ghidraHeadlessJavaOptions,
} from "./GhidraLauncher.js";
import { ghidraJavaEnvironment } from "./GhidraInstallation.js";

describe("Ghidra headless JVM environment", () => {
  it.each([
    { LC_CTYPE: "C.UTF-8" },
    { LC_ALL: "C" },
    { LC_CTYPE: "en_US.UTF-8" },
    { LANG: "ja_JP.UTF-8" },
  ])("preserves a Linux locale selected by the caller: %j", (selected) => {
    const environment = ghidraJavaEnvironment(undefined, selected, "linux");
    expect(environment.LC_CTYPE).toBe(selected.LC_CTYPE);
    expect(environment).toMatchObject(selected);
  });

  it("defaults to UTF-8 path decoding when the Linux JVM has no selected locale", () => {
    const unset = { LC_ALL: "", LC_CTYPE: "", LANG: "" };
    expect(ghidraJavaEnvironment(undefined, unset, "linux")).toMatchObject({
      ...unset,
      LC_CTYPE: "C.UTF-8",
    });
    expect(ghidraJavaEnvironment(undefined, {}, "linux").LC_CTYPE).toBe(
      "C.UTF-8",
    );
    expect(
      ghidraJavaEnvironment(undefined, {}, "darwin").LC_CTYPE,
    ).toBeUndefined();
  });

  it("passes Windows paths with spaces to Java's environment parser", () => {
    expect(
      ghidraHeadlessJavaOptions(
        "C:\\REA Runtime\\home",
        "C:\\REA Runtime\\tmp",
        "win32",
      ),
    ).toEqual({
      JDK_JAVA_OPTIONS:
        '"-Duser.home=C:\\REA Runtime\\home" "-Djava.io.tmpdir=C:\\REA Runtime\\tmp" "-XX:-UsePerfData"',
      GHIDRA_HEADLESS_JAVA_OPTIONS: "",
    });
  });

  it.each(["%TEMP%", 'quote"', "amp&", "line\n", "nul\0"])(
    "rejects interpreter metacharacters in either Windows JVM path: %s",
    (suffix) => {
      for (const [home, temp] of [
        [`C:\\runtime\\${suffix}`, "C:\\runtime\\tmp"],
        ["C:\\runtime\\home", `C:\\runtime\\${suffix}`],
      ] as const)
        expect(() => ghidraHeadlessJavaOptions(home, temp, "win32")).toThrow(
          /metacharacters/u,
        );
    },
  );
});

it("uses selected mixed-case Windows PATH and ComSpec through direct launch boundaries", () => {
  const environment = {
    Path: "C:\\selected\\tools",
    ComSpec: "C:\\selected\\cmd.exe",
    SystemRoot: "C:\\selected-windows",
  };
  const launcher = new GhidraHeadlessLauncher({
    environment,
    platform: "win32",
    analyzeHeadlessPath: "C:\\ghidra\\support\\analyzeHeadless.bat",
    configurationDirectoryName: "ghidra_12.1.4_PUBLIC",
    bridgeScriptPath: "C:\\rea\\bridge.py",
  });
  environment.ComSpec = "C:\\changed\\cmd.exe";
  expect(
    ghidraHeadlessCommand({
      environment: launcher.options.environment,
      platform: "win32",
      analyzeHeadlessPath: launcher.options.analyzeHeadlessPath,
      arguments: [],
    }).command,
  ).toBe("C:\\selected\\cmd.exe");
  expect(ghidraJavaEnvironment("C:\\jdk", environment, "win32")).toMatchObject({
    PATH: "C:\\jdk\\bin;C:\\selected\\tools",
    COMSPEC: "C:\\changed\\cmd.exe",
    SYSTEMROOT: "C:\\selected-windows",
  });
  expect(
    ghidraHeadlessCommand({
      environment: { SYSTEMROOT: "C:\\selected-windows" },
      platform: "win32",
      analyzeHeadlessPath: launcher.options.analyzeHeadlessPath,
      arguments: [],
    }).command,
  ).toBe("C:\\selected-windows\\System32\\cmd.exe");
});
