/**
 * goal 全家桶接入与 Gate 人审联动行为测试（issue #191，ADR 0022）。
 *
 * 验证面：
 * 1. Tier-0 巡场规程中 R1/R2/R3 及 goal 原语（create_goal/get_goal/update_goal）契约完备；
 * 2. Gate Console 页面包含引导用户回到主会话唤醒主控的文案；
 * 3. 任务卡 Gate -> 账本 status=blocked -> Web Console resolve 批准 -> 解除阻塞回到 running。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTier0Playbook,
} from "../../src/runtime/template/template-loader.js";
import { createHandlers, rootCaller, type Handlers } from "../../src/plugin/handlers.js";
import { openGate } from "../../src/runtime/kernel/gates.js";
import { layout } from "../../src/runtime/kernel/paths.js";
import { consolePageHtml, makeGateRoutes } from "../../src/plugin/gate-console.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SESSION = "session-goal-test-1";

describe("巡场规程 goal 全家桶契约（ADR 0022）", () => {
  it("规程中显式包含 create_goal 硬参数化、get_goal 巡检与 update_goal 合法操作", () => {
    const playbook = loadTier0Playbook(REPO_ROOT);

    // R1/R2/R3 明确指认
    expect(playbook.text).toContain("资源防护三项");
    expect(playbook.text).toContain("max_goal_rounds");
    expect(playbook.text).toContain("blocked_streak");

    // 官方 goal 原语与合法 action
    expect(playbook.text).toContain("create_goal");
    expect(playbook.text).toContain("get_goal");
    expect(playbook.text).toContain("update_goal(action=blocked");
    expect(playbook.text).toContain("update_goal(action=complete)");

    // 自治轮权限声明：自治轮内模型无权 pause/resume
    expect(playbook.text).toContain("自治轮内模型无权 pause/resume");
  });
});

describe("Gate Console 唤醒引导与人审联动（ADR 0022）", () => {
  let home: string;
  let handlers: Handlers;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "xzg-goal-test-"));
    handlers = createHandlers(home, SESSION, rootCaller());
    await handlers.init({});
  });

  it("Gate Console HTML 包含人审批准后的主控唤醒引导文案", () => {
    const html = consolePageHtml("test-nonce");
    expect(html).toContain("Gate 裁决已写入。若主控处于等待/阻塞状态，请回到主会话聊天窗口发送「已批准，请继续」唤醒主控");
  });

  it("端到端联动：任务等待 Gate -> status 翻转 blocked -> resolve 批准 -> 恢复 running", async () => {
    const l = layout(home);

    // 1. 创建任务
    const createRes = (await handlers.taskCreate({
      title: "需求设计文档编写",
      room: "root",
      dod: ["pass: 规格完备"],
    })) as { task_id: string; status: string };
    const taskId = createRes.task_id;

    // 2. 派发给 spec-writer 并置为 running（Playbook 步骤 ④ 派发后置 running 规范）
    await handlers.dispatch({
      member: "spec-writer",
      durable_id: "dur-spec",
      role: "spec-writer",
      tier: 1,
      task_id: taskId,
    });
    await handlers.taskUpdate({
      task_id: taskId,
      status: "running",
    });

    // 3. 打开人审 Gate（如 plan-approval）
    const gate = await openGate(l.gatesDir, {
      id: "gate-plan",
      reason: "方案审批",
      requestedBy: "spec-writer",
    });
    expect(gate.status).toBe("pending");

    // 4. 模拟巡场步骤 ②：检测到 pending gate，将任务转为 blocked
    await handlers.taskUpdate({
      task_id: taskId,
      status: "blocked",
    });

    let taskView = (await handlers.taskList({})) as {
      tasks: Array<{ id: string; status: string }>;
    };
    expect(taskView.tasks.find((t) => t.id === taskId)?.status).toBe("blocked");

    // 5. 人类在 Console 审批批准该 Gate
    const routes = makeGateRoutes({
      teamHomeFor: () => home,
      sessionForDurableId: () => SESSION,
    });
    const resolveRoute = routes.find((r) => r.path === "/api/xiaozhuge/gates/resolve");
    expect(resolveRoute).toBeDefined();

    let resolveBody = "";
    const resolveReq = {
      method: "POST",
      url: "/api/xiaozhuge/gates/resolve",
      headers: {
        host: "127.0.0.1:3080",
        origin: "http://127.0.0.1:3080",
        "content-type": "application/json",
      },
      socket: { remoteAddress: "127.0.0.1" },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(
          JSON.stringify({
            session: SESSION,
            gate_id: "gate-plan",
            decision: "approved",
            by: "human-web",
          }),
        );
      },
    };
    const resolveRes = {
      writeHead: () => {},
      end: (data: string) => {
        resolveBody = data;
      },
    };

    await resolveRoute!.handler(resolveReq as any, resolveRes as any);
    const parsed = JSON.parse(resolveBody);
    expect(parsed.ok).toBe(true);
    expect(parsed.gate.status).toBe("approved");

    // 6. 巡场解除阻塞：检测到 gate approved，任务恢复 running
    await handlers.taskUpdate({
      task_id: taskId,
      status: "running",
    });

    taskView = (await handlers.taskList({})) as {
      tasks: Array<{ id: string; status: string }>;
    };
    expect(taskView.tasks.find((t) => t.id === taskId)?.status).toBe("running");
  });
});
