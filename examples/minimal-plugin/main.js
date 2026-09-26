// 轻匣最小示例插件：不依赖 SDK 和构建工具，直接使用插件消息协议 v1。
// 流程：等待宿主握手 → 读取存储 → 调用 view.ready 请求显示 → 响应宿主事件 → 保存到存储。
"use strict";

const PROTOCOL_VERSION = 1;
const STORAGE_KEY = "note";
const note = document.getElementById("note");
const statusLine = document.getElementById("status");
const pending = new Map();
let port = null;
let nextId = 1;

/** 经握手得到的端口发送请求，按 id 等待响应；失败时抛出带 code 的 Error。 */
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!port) { reject(Object.assign(new Error("尚未与轻匣完成握手"), { code: "internal" })); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ id, method, params });
  });
}

function receive(data) {
  if (typeof data !== "object" || data === null) return;
  if (typeof data.id === "number") {
    const entry = pending.get(data.id);
    if (!entry) return; // 未知编号：迟到或重复的响应
    pending.delete(data.id);
    if (data.ok === true) entry.resolve(data.result);
    else entry.reject(Object.assign(new Error(data.error?.message ?? "宿主返回了无法识别的错误"), { code: data.error?.code ?? "internal" }));
  } else if (typeof data.event === "string") {
    onHostEvent(data.event, data.payload);
  }
}

function onHostEvent(event, payload) {
  // 宿主只能聚焦 iframe 本身，插件需在显示时自行聚焦编辑区
  if (event === "view.shown") note.focus();
  if (event === "theme.changed") applyTheme(payload?.theme);
  // 不认识的事件直接忽略，以兼容宿主日后新增的事件
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

function show(message, failed = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", failed);
}

async function start() {
  try {
    const saved = await call("storage.get", { key: STORAGE_KEY });
    note.value = saved?.text ?? "";
    show(saved ? "已恢复上次保存的内容" : "尚未保存内容");
    // 界面准备好后再请求显示，宿主随后下发 view.shown
    await call("view.ready");
  } catch (error) {
    show(`${error.message}（${error.code}）`, true);
  }
}

async function save() {
  try {
    await call("storage.set", { key: STORAGE_KEY, value: { text: note.value, savedAt: Date.now() } });
    show("已保存");
  } catch (error) {
    show(`${error.message}（${error.code}）`, true);
  }
}

// 握手：只接受来自 window.parent 的首条合法 init，并且必须附带端口；此后只经端口通信
window.addEventListener("message", function onInit(event) {
  const data = event.data;
  if (event.source !== window.parent || data?.qingbox !== "init" || data.protocol !== PROTOCOL_VERSION || !event.ports[0]) return;
  window.removeEventListener("message", onInit);
  port = event.ports[0];
  port.onmessage = (message) => receive(message.data);
  applyTheme(data.theme);
  void start();
});

document.getElementById("save").addEventListener("click", () => void save());
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
  // iframe 内的按键不会冒泡到宿主页面，返回搜索须由插件主动调用 view.back
  else if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); void call("view.back").catch(() => {}); }
});

if (window.parent === window) show("请在轻匣中打开此插件", true);
