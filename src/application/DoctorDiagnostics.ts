import {
  SUPPORTED_NODE_VERSION_PROSE,
  supportsJavaScriptRuntime,
} from "../domain/runtimeVersion.js";
import { macosMajorVersion } from "../domain/macosVersion.js";
import { supportsReaHost } from "./LinuxDistribution.js";
import { isDesktopBuildCheck } from "./DoctorProviderIds.js";
import type {
  DoctorCheck,
  DoctorHost,
  DoctorProviderInspection,
} from "./Doctor.js";

/** Ordered environment diagnostics consumed by the Doctor report assembler. */
export interface DoctorDiagnostics {
  readonly checks: readonly DoctorCheck[];
  readonly providerInspections?: readonly DoctorProviderInspection[];
}

/** Collect host, provider, and optional-target diagnostics without mutation. */
export const collectDoctorDiagnostics = async (
  target: string | undefined,
  host: DoctorHost,
  clients: readonly string[] = [],
): Promise<DoctorDiagnostics> => {
  const checks: DoctorCheck[] = [nodeCheck(host)];
  checks.push(await hostCheck(host));

  checks.push(...runtimeConfigurationChecks(host));
  const providerInspections = await host.providerInspections?.(clients);
  if (providerInspections !== undefined)
    checks.push(...providerInspections.flatMap(providerDoctorChecks));

  const ilspyCheck = await optionalIlspyCheck(host);
  if (ilspyCheck !== undefined) checks.push(ilspyCheck);
  const targetCheck = await optionalTargetCheck(target, host);
  if (targetCheck !== undefined) checks.push(targetCheck);

  return {
    checks,
    ...(providerInspections === undefined ? {} : { providerInspections }),
  };
};

/** Evaluate core health while treating unconfigured providers as optional. */
export const doctorHealthy = (
  checks: readonly DoctorCheck[],
  providerInspections: readonly DoctorProviderInspection[] | undefined,
): boolean => {
  const audited = checks.filter(({ name }) => !isDesktopBuildCheck(name));
  if (providerInspections === undefined) return audited.every(({ ok }) => ok);
  return (
    audited.every(
      ({ ok, name }) =>
        ok ||
        providerInspections.some(
          ({ id, configured }) =>
            configured !== true && providerCheckName(id, name),
        ),
    ) && providerInspections.some(({ available }) => available)
  );
};

/** Runtime support follows the shared rule, which judges Bun by its Node.js compatibility. */
export const nodeCheck = ({
  runtime,
}: Pick<DoctorHost, "runtime">): DoctorCheck => {
  const failure = {
    remediation: `Install ${SUPPORTED_NODE_VERSION_PROSE}.`,
    classification: "missing_dependency",
  } as const;
  if (runtime.id === "node")
    return {
      ...check(
        "node",
        supportsJavaScriptRuntime(runtime),
        runtime.version,
        failure,
      ),
      details: { runtime: "node", version: runtime.version },
    };
  return {
    ...check(
      "node",
      supportsJavaScriptRuntime(runtime),
      `Bun ${runtime.version} (Node.js ${runtime.nodeCompatibilityVersion} compatibility)`,
      failure,
    ),
    details: {
      runtime: "bun",
      version: runtime.version,
      node_compatibility_version: runtime.nodeCompatibilityVersion,
    },
  };
};

const hostCheck = async (host: DoctorHost): Promise<DoctorCheck> => {
  const macosVersion =
    host.platform === "darwin" ? await host.macosVersion() : undefined;
  const linuxDistribution =
    host.platform === "linux" ? await host.linuxDistribution() : undefined;
  const macosMajor = macosMajorVersion(macosVersion);
  if (host.platform === "darwin" && macosMajor === undefined)
    return {
      name: "host",
      ok: false,
      classification: "unknown",
      detail:
        macosVersion === undefined
          ? "The macOS version could not be determined."
          : `The macOS version probe returned an unrecognized value: ${JSON.stringify(macosVersion)}.`,
      remediation: "Check /usr/bin/sw_vers -productVersion and rerun doctor.",
    };
  const supported =
    (host.platform === "darwin" &&
      macosMajor !== undefined &&
      macosMajor >= 12) ||
    (host.platform === "linux" && supportsReaHost(linuxDistribution)) ||
    (host.platform === "win32" && host.architecture === "x64");
  const detail =
    macosVersion ??
    (linuxDistribution === undefined
      ? `${host.platform} ${host.architecture}`
      : `${linuxDistribution.id} ${linuxDistribution.versionId ?? "unknown"}`);
  return check("host", supported, detail, {
    remediation: `REA supports macOS 12+, Linux distributions with a recognized apt, dnf, or pacman package family, and the experimental Windows x64 Ghidra P0 boundary.`,
    classification: "unsupported_host",
  });
};

const runtimeConfigurationChecks = (
  host: DoctorHost,
): readonly DoctorCheck[] => {
  const issues = host.nativeConfiguration?.issues;
  if (issues === undefined || issues.length === 0) return [];
  const grouped: { setting: string; constraints: string[] }[] = [];
  for (const issue of issues) {
    const existing = grouped.find((item) => item.setting === issue.setting);
    if (existing === undefined)
      grouped.push({ setting: issue.setting, constraints: [issue.constraint] });
    else existing.constraints.push(issue.constraint);
  }
  return grouped.map(({ setting, constraints }) => ({
    ...check(
      `runtime-configuration:${setting}`,
      false,
      constraints
        .map((constraint) =>
          constraint.includes(setting)
            ? constraint.replace(/\.$/u, "")
            : `${setting}: ${constraint}`,
        )
        .join("; "),
      {
        classification: "config_drift",
        remediation: `Correct ${setting} in the environment that starts REA (your shell or the MCP client's registration), then rerun.`,
      },
    ),
    details: { setting },
  }));
};

const optionalIlspyCheck = async (
  host: DoctorHost,
): Promise<DoctorCheck | undefined> => {
  if (host.configuredIlspyCmdPath === undefined) return undefined;
  const version = await host.ilspyCmdVersion?.(host.configuredIlspyCmdPath);
  return check(
    "ilspycmd",
    version !== undefined,
    version === undefined
      ? host.configuredIlspyCmdPath
      : `${host.configuredIlspyCmdPath} (${version})`,
    {
      remediation:
        "Unset REA_ILSPY_CMD_PATH or point it at a runnable ilspycmd executable.",
      classification: "config_drift",
    },
  );
};

const optionalTargetCheck = async (
  target: string | undefined,
  host: DoctorHost,
): Promise<DoctorCheck | undefined> =>
  target === undefined
    ? undefined
    : host.inspectTarget !== undefined
      ? host.inspectTarget(target)
      : check("target", await host.validTarget(target), target, {
          remediation: "Supply a readable local app or program path.",
          classification: "config_drift",
        });

const check = (
  name: string,
  ok: boolean,
  detail: string | undefined,
  failure: {
    readonly remediation: string;
    readonly classification: Exclude<DoctorCheck["classification"], "healthy">;
  },
): DoctorCheck => ({
  name,
  ok,
  classification: ok ? "healthy" : failure.classification,
  ...(detail === undefined ? {} : { detail }),
  ...(ok ? {} : { remediation: failure.remediation }),
});

const providerDoctorChecks = (
  inspection: DoctorProviderInspection,
): readonly DoctorCheck[] =>
  inspection.checks.map((candidate) => ({
    name:
      candidate.name === "configuration"
        ? inspection.id
        : `${inspection.id}-${candidate.name}`,
    ok: candidate.ok,
    classification: candidate.ok ? "healthy" : candidate.classification,
    detail: candidate.detail,
    ...(candidate.remediation === null
      ? {}
      : { remediation: candidate.remediation }),
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
  }));

const providerCheckName = (providerId: string, name: string): boolean =>
  name === providerId || name.startsWith(`${providerId}-`);
