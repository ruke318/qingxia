// 宿主插件消息桥测试（PL13）：握手、请求转发、结构化错误、乱序与迟到响应、关闭后丢弃。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connectPlugin, type PluginCall } from "../src/features/plugins/bridge.ts";

const ports: MessagePort[] = [];
after(() => { for (const port of ports) port.close(); });

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/** 模拟插件 iframe：记录 init，持有转移过来的端口，收集宿主回传的消息。 */
function mount(call: PluginCall) {
  const inits: { message: unknown; origin: string; transfer: Transferable[] }[] = [];
  const target = { postMessage: (message: unknown, origin: string, transfer: Transferable[]) => { inits.push({ message, origin, transfer }); } };
  const connection = connectPlugin(target as unknown as Window, { token: "令牌-甲", theme: "light", locale: "zh-CN", call });
  const port = inits[0].transfer[0] as MessagePort;
  ports.push(port);
  const received: any[] = [];
  let wake: (() => void) | null = null;
  port.onmessage = (event) => { received.push(event.data); wake?.(); };
  return {
    inits,
    connection,
    received,
    send: (message: unknown) => port.postMessage(message),
    async take(count: number) {
      while (received.length < count) await new Promise<void>((resolve) => { wake = resolve; });
      return received.splice(0, count);
    },
  };
}

/** 可手动完成的调用，用于构造乱序与迟到响应。 */
function deferredCalls() {
  const calls: { token: string; method: string; params: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  const call: PluginCall = (token, method, params) => new Promise((resolve, reject) => { calls.push({ token, method, params, resolve, reject }); });
  return { calls, call };
}

test("握手：发送协议 v1 的 init，目标来源为 *，并只转移一个端口", () => {
  const plugin = mount(async () => null);
  assert.equal(plugin.inits.length, 1);
  assert.deepEqual(plugin.inits[0].message, { qingbox: "init", protocol: 1, theme: "light", locale: "zh-CN" });
  assert.equal(plugin.inits[0].origin, "*");
  assert.equal(plugin.inits[0].transfer.length, 1);
  plugin.connection.close();
});

test("成功：请求附带令牌转发，缺省 params 补为空对象，按 id 回传结果", async () => {
  const seen: unknown[] = [];
  const plugin = mount(async (token, method, params) => { seen.push({ token, method, params }); return method === "storage.get" ? "草稿内容" : null; });
  plugin.send({ id: 1, method: "storage.get", params: { key: "draft" } });
  plugin.send({ id: 2, method: "view.ready" });
  assert.deepEqual(await plugin.take(2), [{ id: 1, ok: true, result: "草稿内容" }, { id: 2, ok: true, result: null }]);
  assert.deepEqual(seen, [
    { token: "令牌-甲", method: "storage.get", params: { key: "draft" } },
    { token: "令牌-甲", method: "view.ready", params: {} },
  ]);
  plugin.connection.close();
});

test("失败：Rust 结构化错误原样回传，其他异常归为 internal", async () => {
  const failures: unknown[] = [
    { code: "permission_denied", message: "插件没有剪贴板历史权限", extra: "不应透传" },
    { code: "unsupported_method", message: "宿主不支持该插件调用：foo.bar" },
    new Error("网络断开"),
    "Command plugin_call not allowed by ACL",
    { code: "未知错误码", message: "格式不对" },
  ];
  const plugin = mount(async (_token, method) => { throw failures[Number(method)]; });
  failures.forEach((_, index) => plugin.send({ id: index + 1, method: String(index) }));
  const responses = await plugin.take(failures.length);
  assert.deepEqual(responses[0], { id: 1, ok: false, error: { code: "permission_denied", message: "插件没有剪贴板历史权限" } });
  assert.deepEqual(responses[1], { id: 2, ok: false, error: { code: "unsupported_method", message: "宿主不支持该插件调用：foo.bar" } });
  for (const response of responses.slice(2)) {
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "internal");
    assert.match(response.error.message, /^宿主处理插件调用失败：/);
  }
  plugin.connection.close();
});

test("格式错误的请求返回 invalid_params，没有 id 的消息被忽略", async () => {
  let calls = 0;
  const plugin = mount(async () => { calls += 1; return null; });
  plugin.send({ id: 7, method: 42 });
  plugin.send({ id: 8, method: "storage.set", params: ["数组"] });
  plugin.send({ method: "view.hide" });
  plugin.send("文本消息");
  const responses = await plugin.take(2);
  assert.deepEqual(responses.map((response) => [response.id, response.error.code]), [[7, "invalid_params"], [8, "invalid_params"]]);
  await flush();
  assert.equal(plugin.received.length, 0);
  assert.equal(calls, 0, "格式错误或无 id 的消息不能转给 Rust");
  plugin.connection.close();
});

test("迟到响应：先发的慢请求晚回，仍按各自 id 回传", async () => {
  const { calls, call } = deferredCalls();
  const plugin = mount(call);
  plugin.send({ id: 1, method: "hosts.save", params: { version: "v1" } });
  plugin.send({ id: 2, method: "storage.get", params: { key: "draft" } });
  while (calls.length < 2) await flush();
  calls[1].resolve("先完成");
  assert.deepEqual(await plugin.take(1), [{ id: 2, ok: true, result: "先完成" }]);
  calls[0].resolve({ version: "v2" });
  assert.deepEqual(await plugin.take(1), [{ id: 1, ok: true, result: { version: "v2" } }]);
  plugin.connection.close();
});

test("宿主事件经端口下发；关闭后迟到的响应与事件都被丢弃", async () => {
  const { calls, call } = deferredCalls();
  const plugin = mount(call);
  plugin.connection.emit("view.shown");
  plugin.connection.emit("theme.changed", { theme: "dark" });
  assert.deepEqual(await plugin.take(2), [{ event: "view.shown", payload: undefined }, { event: "theme.changed", payload: { theme: "dark" } }]);
  plugin.send({ id: 1, method: "hosts.save" });
  plugin.send({ id: 2, method: "clipboard.copy", params: { id: 3 } });
  while (calls.length < 2) await flush();
  plugin.connection.close();
  calls[0].resolve({ version: "v2" });
  calls[1].reject({ code: "internal", message: "复制失败" });
  plugin.connection.emit("view.shown");
  await flush();
  assert.deepEqual(plugin.received, [], "关闭后不应再向插件发送任何消息");
});
