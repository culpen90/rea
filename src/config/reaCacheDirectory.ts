import { isAbsolute } from "node:path";
import { appendCallerPath } from "../filesystem/callerPath.js";

/** A per-user cache directory REA owns on this host: `rea/<name>` under the platform's cache root. */
export const reaCacheDirectory = (
  home: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  name: string,
): string => {
  if (platform === "darwin")
    return appendCallerPath(home, `Library/Caches/rea/${name}`, platform);
  const xdg = environment.XDG_CACHE_HOME;
  const root =
    xdg !== undefined && isAbsolute(xdg)
      ? xdg
      : appendCallerPath(home, ".cache", platform);
  return appendCallerPath(root, `rea/${name}`, platform);
};
