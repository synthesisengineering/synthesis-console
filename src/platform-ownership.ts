/** Read-only shared platform mapping; actual service mutations stay with their owner. */
import catalog from "./contracts/platform-ownership-v1.json";
import { createHash } from "node:crypto";
import { homedir, release } from "node:os";
import { isAbsolute, normalize } from "node:path";
export function platformOwnership(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  kernel = release(),
) {
  const family =
    platform === "darwin"
      ? "macos"
      : platform === "linux"
        ? env.WSL_INTEROP ||
          env.WSL_DISTRO_NAME ||
          kernel.toLowerCase().includes("microsoft")
          ? "wsl"
          : "linux"
        : ["win32", "cygwin"].includes(platform)
          ? "native-windows"
          : null;
  if (!family) throw Error("Unsupported platform ownership contract");
  const value: any = structuredClone(catalog.platforms[family]);
  Object.assign(value, {
    platform: family,
    contract_sha256: createHash("sha256")
      .update(JSON.stringify(catalog, null, 2) + "\n")
      .digest("hex"),
    mutation_authorized: false,
    native_service_status: "UNKNOWN",
    owner: catalog.owner,
    console_owner: catalog.console_owner,
  });
  if (!value.runtime_supported) {
    value.runtime_paths = {};
    return value;
  }
  const roots: Record<string, string> = {
    home,
    engine_state:
      env.SYNTHESIS_STATE_HOME ||
      `${env.XDG_STATE_HOME || home + "/.local/state"}/synthesis`,
    config: env.XDG_CONFIG_HOME || home + "/.config",
    state: env.XDG_STATE_HOME || home + "/.local/state",
    data: env.XDG_DATA_HOME || home + "/.local/share",
  };
  for (const path of Object.values(roots))
    if (
      !isAbsolute(path) ||
      normalize(path) !== path ||
      (path.length > 1 && path.endsWith("/")) ||
      path.split("/").includes("..")
    )
      throw Error("Platform roots require exact absolute POSIX paths");
  const expand = (v: string) =>
    v.replace(/\{([^}]+)\}/g, (_, name) => {
      if (!(name in roots)) throw Error("Unknown platform root");
      return roots[name];
    });
  for (const key of Object.keys(value))
    if (typeof value[key] === "string" && value[key].includes("{"))
      value[key] = expand(value[key]);
  value.runtime_paths = Object.fromEntries(
    Object.entries(catalog.runtime_paths).map(([k, v]) => [k, expand(v)]),
  );
  return value;
}
