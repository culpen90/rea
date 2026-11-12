import { DEFAULT_CATALOG_IDENTITY } from "../catalogIdentity.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import type { DoctorHost } from "./Doctor.js";

/** Healthy recording host for focused doctor and projection tests. */
export const createDoctorHostFixture = (
  overrides: Partial<DoctorHost> = {},
): DoctorHost => ({
  platform: "darwin",
  homeDirectory: "/fixture/home",
  architecture: "x64",
  runtime: { id: "node", version: "24.22.1" },
  macosVersion: () => Promise.resolve("14.0"),
  linuxDistribution: () => Promise.resolve(undefined),
  validTarget: (path) => Promise.resolve(path.includes("example")),
  installedSkillIdentity: () =>
    Promise.resolve({
      version: PRODUCT_IDENTITY.skillVersion,
      toolCount: DEFAULT_CATALOG_IDENTITY.counts.mcp_tools,
      canonical: true,
    }),
  ...overrides,
});
