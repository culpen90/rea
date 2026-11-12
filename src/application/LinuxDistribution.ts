import { readFile } from "node:fs/promises";

type LinuxPackageFamily = "deb" | "rpm" | "arch";

/** Distribution facts from os-release. */
export interface LinuxDistribution {
  readonly id: string;
  readonly versionId?: string;
  readonly packageFamily: LinuxPackageFamily | undefined;
}

/** A recognized package family is the supported Linux host boundary. */
export const supportsReaHost = (
  distribution: LinuxDistribution | undefined,
): boolean => distribution?.packageFamily !== undefined;

/** Parse an os-release document without executing its shell syntax. */
export const parseLinuxDistribution = (text: string): LinuxDistribution => {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
    if (match === null) continue;
    const key = match[1];
    const encoded = match[2];
    if (key === undefined || encoded === undefined) continue;
    const quote = encoded[0];
    const quoted = (quote === "'" || quote === '"') && encoded.endsWith(quote);
    const value = !quoted
      ? encoded
      : quote === "'"
        ? encoded.slice(1, -1)
        : encoded.slice(1, -1).replace(/\\(["\\$`])/gu, "$1");
    fields.set(key, value);
  }
  const id = (fields.get("ID") ?? "unknown").toLowerCase();
  const versionId = fields.get("VERSION_ID");
  return {
    id,
    ...(versionId === undefined ? {} : { versionId }),
    packageFamily: packageFamilyFor(id, fields.get("ID_LIKE")),
  };
};

/** Read the current Linux distribution. */
export const readLinuxDistribution = async (): Promise<
  LinuxDistribution | undefined
> => {
  try {
    return parseLinuxDistribution(await readFile("/etc/os-release", "utf8"));
  } catch {
    // An unreadable os-release leaves the distribution unknown.
    return undefined;
  }
};

const packageFamilyFor = (
  id: string,
  idLike: string | undefined,
): LinuxPackageFamily | undefined => {
  const identities = new Set([
    id,
    ...(idLike?.toLowerCase().split(/\s+/u) ?? []),
  ]);
  if (identities.has("ubuntu") || identities.has("debian")) return "deb";
  if (identities.has("fedora") || identities.has("rhel")) return "rpm";
  if (identities.has("arch")) return "arch";
  return undefined;
};
