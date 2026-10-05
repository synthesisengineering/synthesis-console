import { Hono, type MiddlewareHandler } from "hono";
import type { ConsoleConfig } from "../config.js";
import { activeSources } from "../active-sources.js";
import { operatorProjects, readOperator, safeSegment, RUN_ID, OperatorObservations, operatorObservationBinding, type OperatorObservationBinding } from "../autopilot.js";
import { operatorLanding, operatorDetail, operatorObservationPanel } from "../views/autopilot.js";
import { layout } from "../views/layout.js";

export function autopilotRoutes(config: ConsoleConfig, reader = readOperator, binding: OperatorObservationBinding = operatorObservationBinding) {
  const observations = new OperatorObservations(reader, binding);
  const app = new Hono();
  const localRead: MiddlewareHandler = async (c, next) => {
    c.header("Cache-Control","no-store");
    const url = new URL(c.req.url);
    const host = c.req.header("host");
    let hostname: string;
    try { hostname = host ? new URL("http://" + host).hostname : url.hostname; }
    catch { return c.json({error: "Invalid operator host."}, 421); }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return c.json({error: "Operator reads require a loopback host."}, 421);
    const origin = c.req.header("origin");
    if (origin && origin !== url.origin) return c.json({error: "Cross-origin operator reads are refused."}, 403);
    await next();
  };
  app.use("/autopilot", localRead);
  app.use("/autopilot/*", localRead);
  app.use("/api/autopilot/*", localRead);
  app.use("/autopilot/*", async (c, next) => { await next(); c.header("Cache-Control", "no-store"); });
  app.use("/api/autopilot/*", async (c, next) => { await next(); c.header("Cache-Control", "no-store"); });
  app.get("/autopilot", c => {
    const active = activeSources(c, config);
    const projects = active.map(source => {
      try { return {source, projects: operatorProjects(source), diagnostic: null}; }
      catch { return {source, projects: [], diagnostic: "Project registry is unavailable or unsafe. Ask the project owner to doctor this source."}; }
    });
    c.header("Cache-Control", "no-store");
    return c.html(layout({title: "Autopilot", content: operatorLanding(projects), sources: config.sources,
      activeSourceNames: active.map(s => s.name), currentPath: "/autopilot", demoMode: config.demoMode}));
  });
  for (const prefix of ["/autopilot", "/api/autopilot"]) {
    for (const suffix of ["", "/questions", "/runs/:run"]) {
      app.get(`${prefix}/:source/:project${suffix}`, async c => {
        const active = activeSources(c, config);
        const sourceName = c.req.param("source") || "";
        const project = c.req.param("project") || "";
        const run = c.req.param("run");
        const source = active.find(s => s.name === sourceName);
        // Gate the source before reading its registry, project or helper.
        if (!source || !safeSegment(sourceName) || !safeSegment(project) || (run && !RUN_ID.test(run))) return c.json({error: "Source is inactive or detail is not found."}, 404);
        const cursor = c.req.query("cursor");
        const limitText = c.req.query("limit");
        const limit = limitText === undefined ? 8 : Number(limitText);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 ||
            (cursor !== undefined && (run || !/^[A-Za-z0-9_=-]{1,512}$/.test(cursor)))) return c.json({error: "Invalid page selection."}, 400);
        const observationId = c.req.query("observation");
        const fragment = c.req.query("fragment");
        if ((observationId !== undefined && !RUN_ID.test(observationId)) ||
            (fragment !== undefined && (fragment !== "1" || observationId === undefined || prefix.startsWith("/api")))) return c.json({error:"Invalid observation selection."},400);
        let result = observationId === undefined ? observations.start(source,project,run,{limit,cursor}) : observations.observe(observationId,source,project,run,{limit,cursor});
        // Already-resolved injected/fast readers may finish in this microtask. An
        // unresolved helper is never awaited by the HTTP request.
        await Promise.resolve();
        if(result.observation.id) result=observations.observe(result.observation.id,source,project,run,{limit,cursor});
        const state=result.observation.state;
        const pending=state==="PENDING_RUNTIME" || state==="PENDING_READER";
        const status=pending?202:state==="UNAVAILABLE"?410:result.available?200:503;
        if (prefix.startsWith("/api")) return c.json(result,status);
        const url=new URL(c.req.url);
        url.searchParams.delete("fragment"); url.searchParams.delete("observation");
        url.searchParams.set("sources",source.name);
        const newUrl=url.pathname+url.search;
        if(result.observation.id)url.searchParams.set("observation",result.observation.id);
        const observeUrl=url.pathname+url.search;
        url.searchParams.set("fragment","1");
        const links={newUrl,observeUrl,pollUrl:url.pathname+url.search};
        if(fragment==="1")return c.html(operatorObservationPanel(source,project,result,suffix==="/questions",links),status);
        return c.html(layout({title: "Autopilot status", content: operatorDetail(source, project, result, suffix === "/questions",links),
          sources: config.sources, activeSourceNames: active.map(s => s.name), currentPath: "/autopilot", demoMode: config.demoMode}),status);
      });
    }
  }
  return app;
}
