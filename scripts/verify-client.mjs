/**
 * 客户端 bundle 契约验证（node vm 模拟浏览器端 loader）：
 * 1. 执行 dist/client.js（__ModuleLoader__.load 注册）；
 * 2. 验证 exports.apply / exports.inject 装配；
 * 3. 用 stub ctx 调 apply，验证 conversation.input.right 插槽注册。
 * 不依赖真实宿主（React external 用 stub 注入）。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = readFileSync(join(ROOT, "dist", "client.js"), "utf8");

// ---- 宿主 external stub：react / jsx-runtime / cordis / slots 等 ----
function stubModule(name, exports) {
  return { name, exports };
}
const noop = () => {};
const reactStub = stubModule("react", {
  useState: (v) => [v, noop],
  useEffect: noop,
  useLayoutEffect: noop,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  createElement: () => ({ $$typeof: Symbol.for("react.element") }),
  createContext: (defaultValue) => ({ Provider: () => null, Consumer: () => null, _defaultValue: defaultValue }),
  memo: (c) => c,
  forwardRef: (render) => (props) => render(props, null),
  version: "stub",
});
const jsxRuntimeStub = stubModule("react/jsx-runtime", {
  jsx: () => ({ $$typeof: Symbol.for("react.element") }),
  jsxs: () => ({ $$typeof: Symbol.for("react.element") }),
});

let registered = null;
const registrations = [];
const slotsStub = stubModule("@deepseek-ai/dsh-client-ui-slots", {});
const cordisStub = stubModule("@deepseek-ai/cordis", {});
const runtimeStub = stubModule("@deepseek-ai/dsh-client-runtime", {});
// runtime/client 子路径：createScope（issue 81 会话作用域寻址用）。
const runtimeClientStub = stubModule("@deepseek-ai/dsh-client-runtime/client", {
  createScope: () => ({ fiber: { dispose: async () => {} }, ctx: {} }),
  scopeOf: () => undefined,
});
const connectionStub = stubModule("@deepseek-ai/dsh-client-connection", {});
const conversationStub = stubModule("@deepseek-ai/dsh-client-ui-conversation", {});

const table = new Map([
  ["react", reactStub],
  ["react/jsx-runtime", jsxRuntimeStub],
  ["@deepseek-ai/cordis", cordisStub],
  ["@deepseek-ai/dsh-client-ui-slots", slotsStub],
  ["@deepseek-ai/dsh-client-runtime", runtimeStub],
  ["@deepseek-ai/dsh-client-runtime/client", runtimeClientStub],
  ["@deepseek-ai/dsh-client-connection", connectionStub],
  ["@deepseek-ai/dsh-client-ui-conversation", conversationStub],
]);

function makeLoader() {
  const factories = new Map();
  return {
    load(registration) {
      registered = registration;
      const exportsObj = registration.factory((spec) => {
        const mod = table.get(spec);
        if (!mod) throw new Error(`require("${spec}") missed the module table`);
        return mod.exports;
      });
      // 契约：exports.apply / exports.inject 装配
      if (typeof exportsObj.apply !== "function" || !Array.isArray(exportsObj.inject)) {
        throw new Error(`契约失败: apply=${typeof exportsObj.apply} inject=${Array.isArray(exportsObj.inject)}`);
      }
      factories.set(registration.id, exportsObj);
      return exportsObj;
    },
    factories,
  };
}

const loader = makeLoader();
const sandbox = {
  window: {
    __ModuleLoader__: loader,
    __DSH_BOOT__: { rev: "test", entries: [] },
  },
  console,
};
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: "dist/client.js" });

// ---- 断言 ----
let failed = 0;
function assert(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.error("FAIL:", msg); failed++; }
}

assert(registered !== null, "bundle 已调用 __ModuleLoader__.load");
assert(registered?.id === "@wingsky-1/dsh-xiaozhuge", "load id = 包名");
const mod = registered?.factory ? loader.factories.get(registered.id) : null;
assert(mod !== null, "factory 产物已注册");
assert(typeof mod?.apply === "function", "exports.apply 是函数");
assert(Array.isArray(mod?.inject), "exports.inject 是数组");
assert(JSON.stringify(mod?.inject) === JSON.stringify(["slots", "connection", "sessions", "conversation"]), "inject = [slots, connection, sessions, conversation]");

// ---- apply(ctx) 插槽注册 ----
const ctxStub = {
  get(key) {
    if (key === "connection") {
      return {
        api: {
          sessions: {
            list: async () => ({ result: { ok: true, value: { items: [] } } }),
            prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
          },
        },
      };
    }
    if (key === "conversation") {
      // IConversation 公开面子集：apply 只存 input resolver 句柄（issue 81）。
      return { input: { for: () => ({ setDraft: noop }) } };
    }
    if (key === "sessions") {
      // ISessions 导航子集（团队视图「打开会话」用）。
      return {
        open: noop,
        openSubagent: noop,
        subagentAddress: () => undefined,
        refreshSubagents: async () => {},
      };
    }
    if (key === "slots") {
      const allowedSlots = new Set([
        "conversation.input.right",
        "conversation.session.header.actions",
      ]);
      return {
        inject(slotKey, callback) {
          assert(allowedSlots.has(slotKey), `注入插槽合法（实际 ${slotKey}）`);
          const disposer = callback();
          registrations.push({ slotKey, disposer });
        },
        register(spec, component) {
          assert(
            spec.name === "conversation.input.right" ||
              spec.name === "conversation.session.header.actions",
            `register 声明合法插槽（实际 ${spec.name}）`,
          );
          assert(
            spec.id === "xiaozhuge-team-create" ||
              spec.id === "xiaozhuge-team-view-watcher" ||
              spec.id === "xiaozhuge-team-back-nav",
            `register id 合法（实际 ${spec.id}）`,
          );
          assert(typeof component === "function", "组件是函数（React 组件）");
          return () => {};
        },
      };
    }
    throw new Error(`unexpected ctx.get(${key})`);
  },
};
mod.apply(ctxStub);
assert(registrations.length === 3, "apply 完成 3 次插槽注册");

console.log(failed === 0 ? "\n全部客户端契约断言通过。" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
