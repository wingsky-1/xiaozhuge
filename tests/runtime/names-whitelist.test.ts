import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, claim, acknowledge, readUnread } from "../../src/runtime/collab/mailbox.js";
import { setShard, getShard } from "../../src/runtime/collab/blackboard.js";
import { openGate, resolveGate, readGate } from "../../src/runtime/kernel/gates.js";
import {
  validateSessionId,
  validateMemberName,
  validateRoomName,
  validateGateId,
  validateEnvelopeId,
} from "../../src/runtime/kernel/names.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "xzg-names-"));
}

const ESCAPES = ["../../x", "..%2f..", "/etc/passwd", "a/b", "a\\b", "a\x00b", "a".repeat(65), ""];

/**
 * P0-2（issue #180）：五类入路径参数白名单统一——原语内部 assert 拒绝
 * 路径逃逸/分隔符/控制字符/超长；既有合法输入（模板 role id、房间名、
 * UUID、会话 id）不误拒。
 */
describe("入路径参数白名单（P0-2，#180）", () => {
  describe("校验函数（runtime kernel/names）", () => {
    it("会话 id：沿用 SESSION_PATTERN 口径（-/_ 合法、路径分隔符拒绝）", () => {
      expect(validateSessionId("session-abc_123")).toBe(true);
      expect(validateSessionId("../../x")).toBe(false);
      expect(validateSessionId("a".repeat(129))).toBe(false);
      expect(validateSessionId("")).toBe(false);
    });

    it("member / room / gate id / envelope id：通用安全名形态", () => {
      expect(validateMemberName("coder")).toBe(true);
      expect(validateMemberName("spec-writer")).toBe(true);
      expect(validateRoomName("root")).toBe(true);
      expect(validateGateId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      expect(validateEnvelopeId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      expect(validateMemberName("..")).toBe(false);
      expect(validateRoomName("a/b")).toBe(false);
      expect(validateGateId("a".repeat(65))).toBe(false);
    });
  });

  describe("mailbox 原语", () => {
    for (const bad of ESCAPES) {
      it(`deliver 拒绝非法 recipient: ${JSON.stringify(bad)}`, async () => {
        await expect(
          deliver(tmpHome(), bad, { from: "master", type: "task-assign", body: null }),
        ).rejects.toMatchObject({ code: "invalid-member-name" });
      });
      it(`deliver 拒绝非法信封 id: ${JSON.stringify(bad)}`, async () => {
        await expect(
          deliver(tmpHome(), "coder", { from: "master", type: "t", body: null }, { id: bad }),
        ).rejects.toMatchObject({ code: "invalid-envelope-id" });
      });
      it(`claim/acknowledge 拒绝非法 uuid: ${JSON.stringify(bad)}`, async () => {
        await expect(claim(tmpHome(), "coder", bad)).rejects.toMatchObject({
          code: "invalid-envelope-id",
        });
        await expect(acknowledge(tmpHome(), "coder", bad)).rejects.toMatchObject({
          code: "invalid-envelope-id",
        });
      });
      it(`readUnread 拒绝非法 member: ${JSON.stringify(bad)}`, async () => {
        await expect(readUnread(tmpHome(), bad)).rejects.toMatchObject({
          code: "invalid-member-name",
        });
      });
    }
  });

  describe("blackboard 原语", () => {
    for (const bad of ESCAPES) {
      it(`setShard/getShard 拒绝越界 room: ${JSON.stringify(bad)}`, async () => {
        await expect(
          setShard(tmpHome(), bad, "coder", { status: "running", ext: {} }),
        ).rejects.toMatchObject({ code: "invalid-room-name" });
        await expect(getShard(tmpHome(), bad, "coder")).rejects.toMatchObject({
          code: "invalid-room-name",
        });
      });
    }
  });

  describe("gates 原语", () => {
    for (const bad of ESCAPES) {
      it(`openGate/resolveGate/readGate 拒绝非法 gate id: ${JSON.stringify(bad)}`, async () => {
        const home = tmpHome();
        await expect(
          openGate(join(home, "gates"), { id: bad, reason: "r", requestedBy: "t" }),
        ).rejects.toMatchObject({ code: "invalid-gate-id" });
        await expect(resolveGate(join(home, "gates"), bad, "approved", "by")).rejects.toMatchObject(
          { code: "invalid-gate-id" },
        );
        await expect(readGate(join(home, "gates"), bad)).rejects.toMatchObject({
          code: "invalid-gate-id",
        });
      });
    }
  });

  describe("合法输入回归（不误拒）", () => {
    it("正常受信输入全链路通过（template role id / root 房间 / UUID / 会话 id）", async () => {
      const home = tmpHome();
      await expect(
        deliver(home, "coder", { from: "master", type: "t", body: null }),
      ).resolves.toMatch(/^[0-9a-f-]{36}$/);
      await expect(
        setShard(home, "root", "coder", { status: "running", ext: { step: 1 } }),
      ).resolves.toMatchObject({ role: "coder", status: "running" });
      const gid = "550e8400-e29b-41d4-a716-446655440000";
      await expect(
        openGate(join(home, "gates"), { id: gid, reason: "r", requestedBy: "t" }),
      ).resolves.toMatchObject({ id: gid, status: "pending" });
    });
  });
});