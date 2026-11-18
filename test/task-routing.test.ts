// #273: after "any news?" (task_list), "open the pr" still has the coding task tools.

import { describe, expect, it } from "vitest";
import { groupOfTool, groupsByWords } from "../src/answer/tool-groups.js";

describe("coding tasks are routed like code", () => {
  it("task tools belong to the code group, so the last answer's tools keep it", () => {
    for (const t of ["task_start", "task_list", "task_tell", "task_publish", "task_close"]) expect(groupOfTool(t)).toBe("code");
  });

  it("words about a task, a push or a pull request point at code", () => {
    expect(groupsByWords("open the pr")).toContain("code");
    expect(groupsByWords("push it and open the pull request")).toContain("code");
    expect(groupsByWords("como está a tarefa?")).toContain("code");
    expect(groupsByWords("is the heating on?")).not.toContain("code");
  });
});
