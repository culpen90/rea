import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";

/** Decode explicitly selected reference-source exclusion patterns. */
export const parseStringArray = (
  encoded: string,
  setting: string,
): Result<readonly string[], ConfigurationError> => {
  const decoded = safeParseJson(encoded);
  if (!decoded.ok)
    return err(
      configuredArrayError(setting, "must be valid JSON", decoded.cause),
    );
  const parsed = z.array(z.string().min(1)).safeParse(decoded.value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        configuredArrayError(
          setting,
          "must encode an array of strings",
          parsed.error,
        ),
      );
};

const configuredArrayError = (
  setting: string,
  requirement: string,
  cause: unknown,
): ConfigurationError => {
  const constraint = `${setting} ${requirement}`;
  return new ConfigurationError(constraint, {
    cause,
    settings: [{ setting, constraint }],
  });
};
