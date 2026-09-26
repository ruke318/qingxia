import assert from "node:assert/strict";
import test from "node:test";
import { QingboxError, createTransport } from "../src/transport.ts";
import { MockWindow, createHost, flush, init } from "./mock-window.ts";

// 构造 iframe 场景：插件 window 的 parent 是另一个对象
function embed() {
  const parent = {};
  const win = new MockWindow(parent);
  const transport = createTransport(win as unknown as Window);
  return { parent, win, transport };
}

test("握手前的调用排队，握手后按顺序经端口发送", async () => {
  const { parent, win, transport } = embed();
  const host = createHost();
  assert.equal(transport.embedded, true);
  const first = transport.call("storage.get", { key: "draft" });
  const second = transport.call("view.ready");
  await flush();
  assert.equal(host.requests.length, 0);

  win.emit(init, parent, [host.port]);
  const [a, b] = await host.take(2);
  assert.deepEqual(a, { id: 1, method: "storage.get", params: { key: "draft" } });
  assert.deepEqual(b, { id: 2, method: "view.ready", params: {} });
  assert.equal(win.handlers.size, 0, "握手后不再监听 window 消息");

  host.send({ id: 1, ok: true, result: "内容" });
  host.send({ id: 2, ok: true, result: null });
  assert.equal(await first, "内容");
  assert.equal(await second, null);
});

test("成功响应返回 result；错误响应抛出带 code 的 QingboxError", async () => {
  const { parent, win, transport } = embed();
  const host = createHost();
  win.emit(init, parent, [host.port]);
  const ok = transport.call<{ version: string }>("hosts.get");
  const denied = transport.call("clipboard.list", { kind: "all" });
  const [a, b] = await host.take(2);
  host.send({ id: a.id, ok: true, result: { version: "v1" } });
  host.send({ id: b.id, ok: false, error: { code: "permission_denied", message: "插件未声明剪贴板历史权限" } });

  assert.deepEqual(await ok, { version: "v1" });
  await assert.rejects(denied, (error: unknown) => {
    assert.ok(error instanceof QingboxError);
    assert.ok(error instanceof Error);
    assert.equal(error.code, "permission_denied");
    assert.equal(error.message, "插件未声明剪贴板历史权限");
    return true;
  });
});

test("乱序响应按 id 匹配，未知 id 的迟到响应被忽略", async () => {
  const { parent, win, transport } = embed();
  const host = createHost();
  win.emit(init, parent, [host.port]);
  const calls = [transport.call("a"), transport.call("b"), transport.call("c")];
  const requests = await host.take(3);
  assert.deepEqual(requests.map((request) => request.id), [1, 2, 3]);

  host.send({ id: 99, ok: true, result: "迟到" });
  host.send({ id: 3, ok: true, result: "c" });
  host.send({ id: 1, ok: true, result: "a" });
  host.send({ id: 2, ok: true, result: "b" });
  host.send({ id: 1, ok: true, result: "重复" });
  assert.deepEqual(await Promise.all(calls), ["a", "b", "c"]);
});

test("忽略非 parent 来源的伪造 init 与非法 init，只接受首条合法 init", async () => {
  const { parent, win, transport } = embed();
  const forged = createHost();
  const host = createHost();
  const late = createHost();
  const pending = transport.call("storage.get", { key: "draft" });

  win.emit(init, {}, [forged.port]);
  win.emit(init, win, [forged.port]);
  win.emit({ ...init, protocol: 2 }, parent, [forged.port]);
  win.emit({ qingbox: "hello", protocol: 1 }, parent, [forged.port]);
  win.emit(init, parent, []);
  await flush();
  assert.equal(forged.requests.length, 0);

  win.emit(init, parent, [host.port]);
  win.emit(init, parent, [late.port]);
  const [request] = await host.take(1);
  host.send({ id: request.id, ok: true, result: 1 });
  assert.equal(await pending, 1);

  transport.call("view.ready");
  await host.take(1);
  await flush();
  assert.equal(forged.requests.length, 0);
  assert.equal(late.requests.length, 0);
});

test("事件订阅按名称分发，取消订阅后不再收到", async () => {
  const { parent, win, transport } = embed();
  const host = createHost();
  win.emit(init, parent, [host.port]);
  const shown: unknown[] = [];
  const themes: unknown[] = [];
  const off = transport.on("view.shown", (payload) => shown.push(payload));
  transport.on("theme.changed", (payload) => themes.push(payload));

  host.send({ event: "view.shown", payload: { command: "format" } });
  host.send({ event: "theme.changed", payload: "light" });
  await flush();
  assert.deepEqual(shown, [{ command: "format" }]);
  assert.deepEqual(themes, ["light"]);

  off();
  host.send({ event: "view.shown", payload: 2 });
  await flush();
  assert.deepEqual(shown, [{ command: "format" }]);
});

test("无法结构化克隆的参数以 invalid_params 失败", async () => {
  const { parent, win, transport } = embed();
  const host = createHost();
  win.emit(init, parent, [host.port]);
  await assert.rejects(transport.call("storage.set", { key: "k", value: () => 1 }), { name: "QingboxError", code: "invalid_params" });
});

test("顶层窗口不是 iframe，视为浏览器预览且不监听握手", () => {
  const win = new MockWindow();
  const transport = createTransport(win as unknown as Window);
  assert.equal(transport.embedded, false);
  assert.equal(win.handlers.size, 0);
});

test("握手后 init 携带宿主下发的命令；浏览器预览得到 null", async () => {
  const { parent, win, transport } = embed();
  const host = createHost();
  win.emit({ ...init, command: "hash" }, parent, [host.port]);
  assert.equal((await transport.init)?.command, "hash");
  const preview = new MockWindow(null);
  (preview as unknown as { parent: unknown }).parent = preview;
  assert.equal(await createTransport(preview as unknown as Window).init, null);
});
