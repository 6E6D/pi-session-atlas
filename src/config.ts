import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Host metadata, not access authority. No parser import or cache/source I/O. */
export interface HostConfig {
  schemaVersion: 1;
  cachePath?: string;
  sessionsPath?: string;
  pathHome?: string;
  piPackagePath?: string;
}
export interface ConfigOverrides {
  configPath?: string;
  cachePath?: string;
  sessionsPath?: string;
  pathHome?: string;
}
export interface Setting {
  value: string | null;
  source: string;
}
export interface EffectiveConfig {
  configFile: { path: string; selection: "--config" | "default"; present: boolean };
  settings: Record<"cachePath" | "sessionsPath" | "pathHome" | "piPackagePath", Setting>;
}
export class HostConfigError extends Error {
  readonly code: string;
  constructor(message: string, code = "CONFIG_INVALID") {
    super(message); this.name = "HostConfigError"; this.code = code;
  }
}
const MAX_CONFIG_BYTES = 64 * 1024;
const keys = ["schemaVersion", "cachePath", "sessionsPath", "pathHome", "piPackagePath"];

function absolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/u.test(value) || !isAbsolute(value)) {
    throw new HostConfigError(`${label} must be a nonempty absolute path without control characters; no tilde or variable expansion is performed`);
  }
  return resolve(value);
}

function readHost(path: string, required: boolean): HostConfig | undefined {
  // A dangling link is not an absent optional configuration. Never open a FIFO,
  // device or a leaf symlink, and bound even a file that grows during the read.
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return undefined;
    throw new HostConfigError(`Cannot inspect host configuration ${path}: ${(error as NodeJS.ErrnoException).code ?? "I/O failure"}`, "CONFIG_UNREADABLE");
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_CONFIG_BYTES ||
        (process.getuid && before.uid !== process.getuid()) || (before.mode & 0o022) !== 0) {
      throw new HostConfigError(`Host configuration ${path} must be a user-owned regular, single-link file, not group/world-writable, at most ${MAX_CONFIG_BYTES} bytes`, "CONFIG_UNSAFE");
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, size);
      if (!read) break;
      size += read;
    }
    const after = fstatSync(fd);
    const atPath = lstatSync(path);
    if (size > MAX_CONFIG_BYTES || !atPath.isFile() || [after, atPath].some(s =>
      s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size ||
      s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs)) {
      throw new HostConfigError(`Host configuration ${path} changed during reading or exceeds the size limit`, "CONFIG_UNSAFE");
    }
    let value: unknown;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
      value = JSON.parse(text);
    } catch { throw new HostConfigError(`Host configuration ${path} must contain valid UTF-8 JSON`); }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HostConfigError(`Host configuration ${path} must be an object`);
    }
    // JSON.parse accepts duplicate object keys. Reject them at the root rather
    // than silently selecting the last cache or parser path. JSON syntax has
    // already been validated; strings are consumed whole, including escapes.
    const seen = new Set<string>();
    let depth = 0, keyNext = false;
    for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/gu)) {
      if (token === "{" || token === "[") { depth++; keyNext = depth === 1; }
      else if (token === "}" || token === "]") { depth--; keyNext = false; }
      else if (depth === 1 && token === ",") keyNext = true;
      else if (depth === 1 && keyNext && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (seen.has(key)) throw new HostConfigError(`Host configuration ${path} contains duplicate fields`);
        seen.add(key); keyNext = false;
      }
    }
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).some(key => !keys.includes(key))) {
      // Do not echo unknown fields or raw content: they may contain secrets.
      throw new HostConfigError(`Host configuration ${path} contains unsupported fields`);
    }
    if (fields.schemaVersion !== 1) throw new HostConfigError(`Host configuration ${path} requires schemaVersion 1`, "CONFIG_VERSION_UNSUPPORTED");
    const config: HostConfig = { schemaVersion: 1 };
    for (const key of ["cachePath", "sessionsPath", "pathHome", "piPackagePath"] as const) {
      if (Object.hasOwn(fields, key)) config[key] = absolute(fields[key], `host configuration ${key}`);
    }
    return config;
  } catch (error) {
    if (error instanceof HostConfigError) throw error;
    throw new HostConfigError(`Cannot read host configuration ${path}: ${(error as NodeJS.ErrnoException).code ?? "I/O failure"}`, "CONFIG_UNREADABLE");
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function resolveHostConfig(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): EffectiveConfig {
  const required = overrides.configPath !== undefined;
  // An explicit file does not depend on XDG_CONFIG_HOME being valid.
  const configPath = required ? resolve(overrides.configPath!) : join(
    env.XDG_CONFIG_HOME ? absolute(env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME") : join(home, ".config"),
    "session-atlas", "host.json",
  );
  const host = readHost(configPath, required);
  const choose = (cli: string | undefined, cliName: string, environment: string | undefined,
    envName: string, key: keyof Omit<HostConfig, "schemaVersion">, fallback: string | null): Setting => {
    if (cli !== undefined) return { value: resolve(cli), source: cliName };
    if (environment !== undefined) return { value: resolve(environment), source: envName };
    if (host?.[key] !== undefined) return { value: host[key], source: "host.json" };
    return { value: fallback, source: "built-in" };
  };
  return {
    configFile: { path: configPath, selection: required ? "--config" : "default", present: host !== undefined },
    settings: {
      cachePath: choose(overrides.cachePath, "--db", env.ATLAS_HOME !== undefined ? join(resolve(env.ATLAS_HOME), "atlas.db") : undefined,
        "ATLAS_HOME", "cachePath", join(home, ".pi", "agent", "atlas", "atlas.db")),
      sessionsPath: choose(overrides.sessionsPath, "--sessions-dir", env.ATLAS_SESSIONS_DIR,
        "ATLAS_SESSIONS_DIR", "sessionsPath", join(home, ".pi", "agent", "sessions")),
      pathHome: choose(overrides.pathHome, "--path-home", undefined, "", "pathHome", home),
      // Preserve explicit-empty parser selection until a parser is actually
      // needed. Index-only queries historically do not require a usable Pi.
      piPackagePath: env.ATLAS_PI_PACKAGE !== undefined && !env.ATLAS_PI_PACKAGE.trim()
        ? { value: env.ATLAS_PI_PACKAGE, source: "ATLAS_PI_PACKAGE" }
        : choose(undefined, "", env.ATLAS_PI_PACKAGE, "ATLAS_PI_PACKAGE", "piPackagePath", null),
    },
  };
}
