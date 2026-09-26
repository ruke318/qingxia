// 插件浏览器回归测试共用的模拟宿主：按消息协议 v1 与 iframe 中的插件 SDK 通信。
// 测试页扮演宿主页面，用同源、不加 sandbox 的 iframe 加载插件框架页，以便直接操作插件 DOM；
// 沙箱隔离不在这里验证（PL11 已单独验证）。

// 协议主版本按契约写死为 1：SDK 若擅自升版本，握手失败，回归测试会直接暴露出来
const PROTOCOL_VERSION = 1;

/** 处理函数抛出此错误时，模拟宿主回传结构化失败 `{ ok: false, error: { code, message } }`。 */
export class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 在当前页面挂载插件 iframe，iframe 加载完成后发送 init 并转移端口。
 * @param {object} options
 * @param {string} options.src 插件框架页地址（同源）
 * @param {number} options.width iframe 宽度（像素）
 * @param {number} options.height iframe 高度（像素）
 * @param {Record<string, (params: Record<string, unknown>) => unknown>} options.handlers 按方法名应答请求；返回值即 result，可为 Promise；抛出 HostError 即结构化错误
 * @param {string} [options.command] 可选：握手 init 中携带的打开命令 ID（清单 `commands[].id`）
 * @returns 模拟宿主：`calls` 按收到顺序记录 `{ method, params }`；`ready` 在握手发出后给出 iframe 的窗口与文档；
 *   `pending` 为尚未应答的请求数；`emit` 主动推送宿主事件
 */
export function mountPlugin({ src, width, height, handlers, command }) {
  const calls = [];
  const unsupported = [];
  const strayMessages = [];
  const frame = document.createElement("iframe");
  frame.title = "插件";
  frame.style.cssText = `display:block;width:${width}px;height:${height}px;border:0`;
  let port = null;
  let pending = 0;

  // 协议规定握手后只经端口通信，插件向宿主窗口直接发消息视为违规
  window.addEventListener("message", (event) => {
    if (event.source === frame.contentWindow) strayMessages.push(event.data);
  });

  async function respond(request) {
    const { id, method, params } = request;
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler) {
      unsupported.push(method);
      port.postMessage({ id, ok: false, error: { code: "unsupported_method", message: `宿主不支持该方法：${method}` } });
      return;
    }
    pending += 1;
    try {
      const result = await handler(params ?? {});
      port.postMessage({ id, ok: true, result });
    } catch (error) {
      const payload = error instanceof HostError
        ? { code: error.code, message: error.message }
        : { code: "internal", message: error instanceof Error ? error.message : String(error) };
      port.postMessage({ id, ok: false, error: payload });
    } finally {
      pending -= 1;
    }
  }

  const ready = new Promise((resolve) => {
    const onLoad = () => {
      const win = frame.contentWindow;
      // 跳过可能出现的初始空白文档，只对插件框架页握手一次
      if (!win || win.location.href === "about:blank") return;
      frame.removeEventListener("load", onLoad);
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event) => { void respond(event.data); };
      const init = { qingbox: "init", protocol: PROTOCOL_VERSION, theme: "light", locale: "zh-CN" };
      if (command !== undefined) init.command = command;
      win.postMessage(init, location.origin, [channel.port2]);
      resolve({ win, doc: frame.contentDocument });
    };
    frame.addEventListener("load", onLoad);
  });
  frame.src = src;
  document.body.append(frame);

  return {
    frame,
    calls,
    unsupported,
    strayMessages,
    ready,
    /** 已收到但尚未应答的请求数。 */
    get pending() { return pending; },
    /** 经端口推送宿主事件，例如 `view.shown`、`theme.changed`；必须在 ready 之后调用。 */
    emit(event, payload) {
      if (!port) throw new Error("尚未完成握手，不能推送宿主事件");
      port.postMessage({ event, payload });
    },
  };
}

/**
 * 依次执行场景：场景之间共享插件状态，因此某一场景失败后，后续场景记为未执行。
 * 结束时检查协议约束（未调用宿主不支持的方法、未绕过端口发消息）。
 * @param {ReturnType<typeof mountPlugin>} host
 * @param {() => Promise<void>} setup 初始化步骤，失败时全部场景记为未执行
 * @param {[string, () => Promise<void>][]} scenarios `[场景说明, 执行函数]` 列表
 * @returns {Promise<{ passed: number, total: number, failures: { scenario: string, message: string }[], completed: string[] }>}
 */
export async function runScenarios(host, setup, scenarios) {
  const completed = [];
  const failures = [];
  const reason = (error) => error instanceof Error ? error.message : String(error);
  try {
    await setup();
  } catch (error) {
    failures.push({ scenario: "初始化", message: reason(error) });
  }
  for (const [name, run] of scenarios) {
    if (failures.length) { failures.push({ scenario: name, message: "未执行：前序步骤失败" }); continue; }
    try {
      await run();
      completed.push(name);
    } catch (error) {
      failures.push({ scenario: name, message: reason(error) });
    }
  }
  if (host.unsupported.length) failures.push({ scenario: "协议约束", message: `插件调用了宿主不支持的方法：${[...new Set(host.unsupported)].join("、")}` });
  if (host.strayMessages.length) failures.push({ scenario: "协议约束", message: `插件绕过端口向宿主窗口发送了 ${host.strayMessages.length} 条消息` });
  return { passed: completed.length, total: scenarios.length, failures, completed };
}

/** 把结果以 JSON 写入 `<pre id="result">`，供无界面 Chrome 读取。 */
export function writeResult(result) {
  const output = document.createElement("pre");
  output.id = "result";
  output.textContent = JSON.stringify(result, null, 2);
  document.body.append(output);
}
