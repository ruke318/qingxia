import assert from "node:assert/strict";
import test from "node:test";
import { MockWindow, createHost, init } from "./mock-window.ts";

// SDK 在模块加载时读取全局 window，每个场景用查询参数加载一份新的模块实例
async function load(win: MockWindow, name: string) {
  (globalThis as any).window = win;
  return import(`../src/index.ts?case=${name}`);
}

test("顶层预览：存储走 localStorage、复制走 navigator.clipboard，需要宿主的接口给出中文提示", async () => {
  const win = new MockWindow();
  const { qingbox } = await load(win, "preview");

  await qingbox.storage.set("draft", { text: "你好" });
  assert.equal(win.store.get("qingbox-json-preview:draft"), '{"text":"你好"}');
  assert.deepEqual(await qingbox.storage.get("draft"), { text: "你好" });
  assert.equal(await qingbox.storage.get("missing"), null);

  await qingbox.clipboard.writeText("复制内容");
  assert.deepEqual(win.copied, ["复制内容"]);

  await qingbox.view.ready();
  await qingbox.view.hide();
  await qingbox.view.back();
  assert.equal(win.history.backCount, 1);
  assert.equal(await qingbox.shortcuts.get(), null);

  await assert.rejects(qingbox.hosts.get(), { message: "请在轻匣桌面应用中查看系统 Hosts" });
  await assert.rejects(qingbox.clipboard.list("all"), { message: "请在轻匣桌面应用中查看剪贴板历史" });
  await assert.rejects(qingbox.shortcuts.set("Alt+J"), { message: "请在轻匣桌面应用中设置全局快捷键" });
  const off = qingbox.events.on("view.shown", () => {});
  off();
});

test("顶层预览：读取文本剪贴板走 navigator.clipboard", async () => {
  const win = new MockWindow();
  await win.navigator.clipboard.writeText("剪贴板文本");
  const { qingbox } = await load(win, "preview-read-clipboard");
  assert.equal(await qingbox.clipboard.readText(), "剪贴板文本");
});

test("iframe 内：对外接口经端口发送原方法名与参数，事件经 qingbox.events 订阅", async () => {
  const parent = {};
  const win = new MockWindow(parent);
  const { qingbox, QingboxError, PROTOCOL_VERSION } = await load(win, "embedded");
  assert.equal(PROTOCOL_VERSION, 1);
  const host = createHost();
  win.emit(init, parent, [host.port]);

  const saved = qingbox.hosts.save([{ id: "a", name: "开发", content: "127.0.0.1 a", enabled: true }], "v1");
  const stored = qingbox.storage.set("draft", "内容");
  const drag = qingbox.view.startDragging();
  const [save, set, dragRequest] = await host.take(3);
  assert.deepEqual(save, { id: 1, method: "hosts.save", params: { groups: [{ id: "a", name: "开发", content: "127.0.0.1 a", enabled: true }], version: "v1" } });
  assert.deepEqual(set, { id: 2, method: "storage.set", params: { key: "draft", value: "内容" } });
  assert.equal(dragRequest.method, "view.drag");
  assert.deepEqual(win.store, new Map(), "iframe 内不使用 localStorage");

  host.send({ id: 2, ok: true, result: null });
  host.send({ id: 3, ok: true, result: null });
  host.send({ id: 1, ok: false, error: { code: "cancelled", message: "已取消系统授权" } });
  await stored;
  await drag;
  await assert.rejects(saved, (error: unknown) => error instanceof QingboxError && (error as any).code === "cancelled");

  const received: unknown[] = [];
  const off = qingbox.events.on("theme.changed", (payload: unknown) => received.push(payload));
  host.send({ event: "theme.changed", payload: "dark" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  off();
  assert.deepEqual(received, ["dark"]);
});


test("iframe 文本剪贴板：经宿主读取原文并保留权限错误", async () => {
  const parent = {};
  const win = new MockWindow(parent);
  const { qingbox, QingboxError } = await load(win, "clipboard-read-embedded");
  const host = createHost();
  win.emit(init, parent, [host.port]);
  const read = qingbox.clipboard.readText();
  const [request] = await host.take(1);
  assert.equal(request.method, "clipboard.readText");
  assert.deepEqual(request.params, {});
  host.send({ id: request.id, ok: true, result: "剪贴板原文\n  " });
  assert.equal(await read, "剪贴板原文\n  ");
  const denied = qingbox.clipboard.readText();
  const [second] = await host.take(1);
  const rejection = assert.rejects(denied, (error: unknown) => error instanceof QingboxError && error.code === "permission_denied");
  host.send({ id: second.id, ok: false, error: { code: "permission_denied", message: "插件没有读取文本剪贴板权限" } });
  await rejection;
});
