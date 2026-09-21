import { describe, expect, test } from "bun:test";
import { projectListView } from "./project-list.js";
import { projectDetailView } from "./project-detail.js";
import type { ProjectWithSource } from "../parsers/yaml.js";
import type { Source } from "../config.js";

const sources: Source[] = [{ name: "personal", root: "/tmp" }];
const projects: ProjectWithSource[] = [
  {
    id: "demo-proj",
    name: "Demo",
    status: "active",
    description: "",
    tags: [],
    _source: "personal",
  },
];

function listHtml(): string {
  return projectListView({
    projects,
    allTags: new Map(),
    currentFilters: {},
    sources,
    activeSourceNames: ["personal"],
    demoMode: false,
    initiatives: [],
    groupByInitiative: false,
    resumeSkillInstalled: true,
  });
}

describe("resume prompt UX", () => {
  test("list binds copy buttons via delegation (rows render after the script)", () => {
    const html = listHtml();
    expect(html).toContain("closest('.resume-copy')");
    expect(html).not.toContain("querySelectorAll('.resume-copy').forEach");
  });

  test("list buttons name the copy action and confirm via toast", () => {
    const html = listHtml();
    expect(html).toContain(">Copy resume prompt</button>");
    expect(html).toContain("resume-toast");
    expect(html).toContain("aria-live");
  });

  test("detail explains the paste flow and confirms via toast", () => {
    const html = projectDetailView({
      project: projects[0],
      contextHtml: null,
      referenceHtml: null,
      sessions: [],
      sourceName: "personal",
      resumeSkillInstalled: true,
    });
    expect(html).toContain("resume-explainer");
    expect(html).toContain(">Copy resume prompt</button>");
    expect(html).toContain("resume-toast");
  });
});
