/** Actual sandboxed browser keyboard/AX acceptance on a synthetic local page. */
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { layout } from "./layout.js";
import { conformanceView } from "./conformance.js";
import type { DoctorStatus } from "../doctor.js";

test("keyboard focus, named controls, status meanings and AX tree are real browser behavior", async () => {
  const chrome = process.env.SYNTHESIS_TEST_CHROMIUM;
  expect(
    chrome,
    "The complete interface requires SYNTHESIS_TEST_CHROMIUM; no browser skip is accepted.",
  ).toBeTruthy();
  const root = mkdtempSync(join(tmpdir(), "console-accessibility-"));
  const value: DoctorStatus = {
    launcher: "/synthetic/.synthesis/v5/bin/synthesis",
    installed: true,
    report: {
      healthy: true,
      ms: 1800,
      checks: [
        { status: "ok", name: "runtime", detail: "current release matches" },
        { status: "warn", name: "hook self-test", detail: "denied in 54 ms, over the 50 ms budget" },
        { status: "info", name: "latest", detail: "not checked" },
      ],
    },
    error: null,
    elapsedMs: 2100,
    checkedAt: "2026-10-06T12:00:00.000Z",
    ageSeconds: 10,
  };
  const html = layout({
    title: "Synthetic conformance",
    content: conformanceView(value),
    sources: [
      {
        name: "one",
        display_name: "One",
        root: "/synthetic/one",
        projects_dir: "projects",
      },
      {
        name: "two",
        display_name: "Two",
        root: "/synthetic/two",
        projects_dir: "projects",
      },
    ],
    activeSourceNames: ["one"],
    currentPath: "/conformance",
    demoMode: false,
  });
  writeFileSync(join(root, "page.html"), html);
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/api/conformance/refresh") {
        calls++;
        return Response.json({ ok: false, error: "fixture refusal" });
      }
      if (p.startsWith("/api/"))
        return Response.json({
          ok: true,
          installed: true,
          healthy: true,
          failures: 0,
          warnings: 1,
        });
      if (p === "/style.css")
        return new Response(
          readFileSync(resolve(import.meta.dir, "../../public/style.css")),
          { headers: { "Content-Type": "text/css" } },
        );
      if (p === "/vendor/pico-2.1.1.min.css")
        return new Response(
          readFileSync(
            resolve(import.meta.dir, "../../public/vendor/pico-2.1.1.min.css"),
          ),
          { headers: { "Content-Type": "text/css" } },
        );
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    },
  });
  const child = spawn(
    chrome!,
    [
      "--headless",
      "--remote-debugging-pipe",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--user-data-dir=${join(root, "profile")}`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
  );
  const pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (e: Error) => void }
  >();
  let next = 1,
    raw = "",
    stderr = "",
    closed = false;
  let fatal: Error | null = null;
  const fail = (error: Error) => {
    fatal = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.stderr!.on("data", (b) => {
    stderr += b.toString();
    if (stderr.length > 1024 * 1024) fail(Error("Browser diagnostic ceiling"));
  });
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    closed = true;
    fail(Error(`Browser exited (code=${code}, signal=${signal}): ${stderr}`));
  });
  (child.stdio[4] as any).on("data", (b: Buffer) => {
    try {
      raw += b.toString();
      if (raw.length > 4 * 1024 * 1024) throw Error("Browser protocol ceiling");
      for (;;) {
        const end = raw.indexOf("\0");
        if (end < 0) break;
        const row = JSON.parse(raw.slice(0, end));
        raw = raw.slice(end + 1);
        if (row.id) {
          const waiter = pending.get(row.id);
          pending.delete(row.id);
          row.error
            ? waiter?.reject(Error(JSON.stringify(row.error)))
            : waiter?.resolve(row.result);
        }
      }
    } catch (e) {
      fail(e instanceof Error ? e : Error(String(e)));
    }
  });
  const call = (method: string, params: any = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      if (fatal) {
        reject(fatal);
        return;
      }
      const id = next++;
      pending.set(id, { resolve, reject });
      (child.stdio[3] as any).write(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }) + "\0",
      );
    });
  const deadline = setTimeout(() => {
    fail(Error(`Browser deadline: ${stderr}`));
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (e: any) {
        if (e.code !== "ESRCH") fail(e);
      }
    }
  }, 25000);
  const evidence: any = { synthetic: true, native_agent_acceptance: false };
  try {
    const { targetId } = await call("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const evaluate = async (expression: string) =>
      (
        await call(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        )
      ).result.value;
    const key = async (key: string, code: string, virtual: number) => {
      await call(
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          key,
          code,
          windowsVirtualKeyCode: virtual,
          nativeVirtualKeyCode: virtual,
          ...(key === "Enter"
            ? { text: "\r", unmodifiedText: "\r" }
            : key === " "
              ? { text: " ", unmodifiedText: " " }
              : {}),
        },
        sessionId,
      );
      await call(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key,
          code,
          windowsVirtualKeyCode: virtual,
          nativeVirtualKeyCode: virtual,
        },
        sessionId,
      );
    };
    await call("Page.enable", {}, sessionId);
    await call(
      "Page.navigate",
      { url: `http://127.0.0.1:${server.port}/conformance` },
      sessionId,
    );
    for (let i = 0; i < 100; i++) {
      if (await evaluate('document.readyState === "complete"')) break;
      await Bun.sleep(20);
    }
    await key("Tab", "Tab", 9);
    evidence.firstFocus = await evaluate("document.activeElement.textContent");
    expect(evidence.firstFocus).toBe("Skip to main content");
    await key("Enter", "Enter", 13);
    expect(await evaluate("document.activeElement.id")).toBe("main-content");
    // Native tab traversal reaches the summary, rather than scripted focus alone.
    await evaluate("document.body.focus()");
    let found = false;
    for (let i = 0; i < 35; i++) {
      await key("Tab", "Tab", 9);
      if (await evaluate('document.activeElement.tagName === "SUMMARY"')) {
        found = true;
        break;
      }
    }
    expect(found).toBeTrue();
    await key("Enter", "Enter", 13);
    expect(
      await evaluate('document.querySelector(".source-picker").open'),
    ).toBeTrue();
    await key("Tab", "Tab", 9);
    expect(await evaluate("document.activeElement.type")).toBe("checkbox");
    await key(" ", "Space", 32);
    expect(await evaluate("location.pathname")).toBe("/conformance");
    expect(await evaluate("document.activeElement.type")).toBe("checkbox");
    await key("Escape", "Escape", 27);
    expect(
      await evaluate('document.querySelector(".source-picker").open'),
    ).toBeFalse();
    expect(await evaluate("document.activeElement.tagName")).toBe("SUMMARY");
    let rerun = false;
    for (let i = 0; i < 35; i++) {
      await key("Tab", "Tab", 9);
      if (await evaluate('document.activeElement.id === "doctor-run-btn"')) {
        rerun = true;
        break;
      }
    }
    expect(rerun).toBeTrue();
    await key("Enter", "Enter", 13);
    for (let i = 0; i < 100; i++) {
      if (
        await evaluate(
          'document.getElementById("doctor-progress").textContent.includes("could not run")',
        )
      )
        break;
      await Bun.sleep(10);
    }
    expect(calls).toBe(1);
    expect(await evaluate("document.activeElement.id")).toBe("doctor-run-btn");
    expect(
      await evaluate(
        'document.getElementById("doctor-progress").getAttribute("aria-live")',
      ),
    ).toBe("polite");
    evidence.ax = (
      await call("Accessibility.getFullAXTree", {}, sessionId)
    ).nodes;
    expect(evidence.ax.some((n: any) => n.role?.value === "main")).toBeTrue();
    expect(
      evidence.ax.some(
        (n: any) =>
          n.role?.value === "navigation" && n.name?.value === "Main navigation",
      ),
    ).toBeTrue();
    expect(
      evidence.ax.some(
        (n: any) => n.role?.value === "button" && n.name?.value === "Run again",
      ),
    ).toBeTrue();
    evidence.focusOutline = await evaluate(
      "getComputedStyle(document.activeElement).outlineStyle",
    );
    expect(evidence.focusOutline).toBe("solid");
    evidence.text = await evaluate(
      'document.getElementById("doctor-meaning").textContent',
    );
    expect(evidence.text).toContain("never affects");
    expect(evidence.text).toContain("does not approve a hook");
    expect(
      await evaluate('document.querySelector("caption").textContent'),
    ).toBe("3 checks from synthesis doctor");
    expect(
      await evaluate('document.querySelectorAll("[role=listbox]").length'),
    ).toBe(0);
    writeFileSync(
      join(root, "observed.json"),
      JSON.stringify(evidence, null, 2),
    );
  } finally {
    clearTimeout(deadline);
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (e: any) {
        if (e.code !== "ESRCH") throw e;
      }
    }
    for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(10);
    server.stop(true);
    writeFileSync(join(root, "browser.stderr"), stderr);
    writeFileSync(
      join(root, "process.json"),
      JSON.stringify({ pid: child.pid, closed }),
    );
    expect(closed).toBeTrue();
  }
}, 30000);
