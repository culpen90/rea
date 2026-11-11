import { posix, win32 } from "node:path";
import { absoluteCallerPath } from "./callerPath.js";

/**
 * True when `child` is `parent` or is spelled below it. Parent traversal is
 * never collapsed, because after a symbolic link it leads somewhere else:
 * callers resolve such spellings through the filesystem instead.
 */
export const withinLexicalDirectory = (
  child: string,
  parent: string,
  platform: NodeJS.Platform,
): boolean => {
  const base = lexicalDirectory(parent, platform);
  const inner = lexicalDirectory(child, platform);
  const separator = (platform === "win32" ? win32 : posix).sep;
  return (
    inner === base ||
    inner.startsWith(base.endsWith(separator) ? base : base + separator)
  );
};

/** True when a POSIX spelling contains a `..` segment, whose meaning only the filesystem knows. */
export const hasParentTraversal = (value: string): boolean =>
  value.split("/").includes("..");

const lexicalDirectory = (value: string, platform: NodeJS.Platform): string => {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = absoluteCallerPath(value, { platform });
  const root = pathApi.parse(normalized).root;
  let end = normalized.length;
  while (
    end > root.length &&
    normalized.charCodeAt(end - 1) === pathApi.sep.charCodeAt(0)
  )
    end -= 1;
  return normalized.slice(0, end);
};
