import { AtlasQueryError } from "./query-db.ts";
import { CacheError } from "./cache.ts";
import { PiPackageResolutionError } from "./resolve-pi.ts";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ErrorDetail {
  code: string;
  message: string;
  candidates?: string[];
}

export function failureFor(error: unknown): { exitCode: 1 | 2; error: ErrorDetail } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    return { exitCode: 1, error: { code: "USAGE_ERROR", message } };
  }
  if (error instanceof PiPackageResolutionError) {
    return { exitCode: 2, error: { code: "PI_PARSER_UNAVAILABLE", message, candidates: error.candidates } };
  }
  return {
    exitCode: 2,
    error: { code: error instanceof AtlasQueryError || error instanceof CacheError ? error.code : "OPERATION_FAILED", message },
  };
}
