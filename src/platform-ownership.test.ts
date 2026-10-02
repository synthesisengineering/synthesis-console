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
      expect(v.console_python).toBe(
        "/synthetic/.local/share/synthesis-console/python-runtime",
      );
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
  expect(v.console_python).toBe("/data/synthesis-console/python-runtime");
});
