import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(root, "skills");

function skill(name: string): string {
  return readFileSync(path.join(skillRoot, name, "SKILL.md"), "utf8");
}

describe("bundled skills", () => {
  it("ships the operator-facing workflow and standalone skills", () => {
    const names = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(names).toEqual([
      "autodoc",
      "autoimplement",
      "autoplan",
      "monitor",
      "parallel-slices",
      "pi-workflows",
      "sanity-check",
    ]);
    for (const name of names) {
      expect(skill(name)).toContain(`name: ${name}`);
    }
  });

  it.each(["autodoc", "autoimplement", "autoplan", "sanity-check"])(
    "routes %s through its built-in workflow",
    (name) => {
      expect(skill(name)).toContain(`built-in \`${name}\` workflow`);
    },
  );

  it("routes monitor through its built-in workflow", () => {
    expect(skill("monitor")).toContain("built-in Pi `monitor` workflow");
  });

  it("keeps parallel generation text-only and checks interaction after integration", () => {
    const markdown = skill("parallel-slices");
    expect(markdown).toContain("not a built-in executable workflow");
    expect(markdown).toContain("Keep the user's exact provider, endpoint, and model choice");
    expect(markdown).toContain("Omit tools and tool execution entirely");
    expect(markdown).toContain(
      "Preparing this skill or a plan is not permission to launch a batch",
    );
    expect(markdown).toContain("Tab **and Shift+Tab**");
    expect(markdown).toContain("dispatch only that slice within existing authorization");
  });

  it("keeps initial planning out of autoimplement and autodoc", () => {
    expect(skill("autoimplement")).toContain("Do not devise an initial plan");
    expect(skill("autodoc")).toContain("It does not choose, devise, improve, or revise");
  });
});
