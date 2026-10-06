import { test, expect } from "bun:test";
import { platformOwnership } from "./platform-ownership.js";
for (const [p, kernel, env, family] of [
  ["darwin", "", {}, "macos"],
  ["linux", "Linux", {}, "linux"],
  ["linux", "Linux microsoft", {}, "wsl"],
  ["linux", "Linux", { WSL_INTEROP: "fixture" }, "wsl"],
  ["win32", "", {}, "native-windows"],
] as const) {
  test("exact declared platform " + family + kernel, () => {
    const v = platformOwnership("/synthetic", env, p, kernel);
    expect(v.platform).toBe(family);
    expect(v.mutation_authorized).toBe(false);
    expect(v.native_service_status).toBe("UNKNOWN");
    if (family === "native-windows") {
      expect(v.console_unit).toBeNull();
      expect(v.runtime_paths).toEqual({});
    } else {
      expect(v.console_unit).toBe(
        "/synthetic/" +
          (family === "macos"
            ? "Library/LaunchAgents/org.synthesisengineering.console.plist"
            : ".config/systemd/user/synthesis-console.service"),
      );
    }
  });
}
for (const value of ["relative", "/tmp/a/../b", "/tmp//b", "/tmp/b/"])
  test("invalid XDG " + value, () =>
    expect(() =>
      platformOwnership(
        "/synthetic",
        { XDG_CONFIG_HOME: value },
        "linux",
        "Linux",
      ),
    ).toThrow(),
  );
test("explicit XDG paths preserved", () => {
  const v = platformOwnership(
    "/synthetic",
    {
      XDG_CONFIG_HOME: "/conf",
      XDG_DATA_HOME: "/data",
      XDG_STATE_HOME: "/state",
    },
    "linux",
    "Linux",
  );
  expect(v.console_unit).toBe("/conf/systemd/user/synthesis-console.service");
  expect(v.console_receipt).toBe("/state/synthesis-console/autostart.json");
});
test("runtime paths name the synthesis v5 runtime, honoring SYNTHESIS_HOME", () => {
  expect(platformOwnership("/synthetic", {}, "darwin", "").runtime_paths).toEqual({
    runtime: "/synthetic/.synthesis/v5/current",
    bin: "/synthetic/.synthesis/v5/bin",
    state: "/synthetic/.synthesis/v5/state",
    "git-hooks": "/synthetic/.synthesis/v5/git-hooks",
    "day-end": "/synthetic/.synthesis/v5/bin",
  });
  expect(
    platformOwnership("/synthetic", { SYNTHESIS_HOME: "/opt/v5" }, "linux", "Linux").runtime_paths.bin,
  ).toBe("/opt/v5/bin");
  expect(() =>
    platformOwnership("/synthetic", { SYNTHESIS_HOME: "relative/v5" }, "linux", "Linux"),
  ).toThrow();
});
