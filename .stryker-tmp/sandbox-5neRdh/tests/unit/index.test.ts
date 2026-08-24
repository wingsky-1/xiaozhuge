// @ts-nocheck
import { describe, expect, it } from "vitest";
import { STAGES, VERSION, isStage } from "../../src/index.js";

describe("runtime 占位模块", () => {
  it("版本号为开发态", () => {
    expect(VERSION).toBe("0.0.0-dev");
  });

  it("保留态三元组恰好三个值", () => {
    expect(STAGES).toEqual(["running", "blocked", "done"]);
  });

  it("isStage 合法与非法判定", () => {
    expect(isStage("running")).toBe(true);
    expect(isStage("building")).toBe(false);
  });
});
