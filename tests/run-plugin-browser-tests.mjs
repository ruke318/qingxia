// 无人值守运行三个插件及最小示例插件的浏览器回归页：启动 Vite 开发服务，逐页用独立的无界面 Chrome 打开，
// 读取页面中 <pre id="result"> 的 JSON 结果并汇总；任一页失败时退出码为 1。
// 只使用临时配置目录启动新的 Chrome 进程，不连接用户正在使用的浏览器。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const pages = [
  "tests/plugin-manager.browser.html",
  "plugins/json-tools/tests/editor.browser.html",
  "plugins/hosts-switch/tests/editor.browser.html",
  "plugins/clipboard-history/tests/history.browser.html",
  "plugins/qr-tools/tests/qr.browser.html",
  "tests/minimal-plugin.browser.html",
];
const PAGE_TIMEOUT = 90_000;
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 由系统分配空闲端口，避开开发服务常用的 1420、1421
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function launchChrome() {
  const profile = await mkdtemp(join(tmpdir(), "qingbox-browser-test-"));
  const child = spawn(chromePath, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  // Chrome 启动后把实际调试端口和浏览器地址写入配置目录下的 DevToolsActivePort
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  let endpoint = null;
  while (!endpoint) {
    if (child.exitCode !== null) throw new Error("无界面 Chrome 启动失败");
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("等待无界面 Chrome 调试端口超时"); }
    if (existsSync(portFile)) {
      const [port, path] = (await readFile(portFile, "utf8")).split("\n");
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    }
    if (!endpoint) await sleep(100);
  }
  return { child, exited, profile, endpoint };
}

// 极简 CDP 客户端：浏览器级连接，按 sessionId 区分页面
async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("无法连接无界面 Chrome")); });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    } else if (data.method) {
      for (const listener of listeners) listener(data);
    }
  };
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { socket.close(); },
  };
}

async function runPage(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  const off = cdp.onEvent((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
    if (event.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(event.params.type)) errors.push(`console.${event.params.type}: ${event.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ")}`);
  });
  try {
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url }, sessionId);
    const deadline = Date.now() + PAGE_TIMEOUT;
    while (Date.now() < deadline) {
      const { result } = await cdp.send("Runtime.evaluate", { expression: "document.getElementById('result')?.textContent ?? ''", returnByValue: true }, sessionId).catch(() => ({ result: {} }));
      if (result.value) return { result: JSON.parse(result.value), errors };
      await sleep(250);
    }
    return { result: { passed: 0, total: 0, failures: [{ scenario: "运行", message: `等待结果超时（${PAGE_TIMEOUT / 1000} 秒）` }] }, errors };
  } finally {
    off();
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function main() {
  const port = await freePort();
  const server = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    logLevel: "warn",
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  });
  let chrome = null;
  let cdp = null;
  let failed = false;
  try {
    await server.listen();
    console.log(`Vite 开发服务：http://127.0.0.1:${port}/`);
    chrome = await launchChrome();
    cdp = await connect(chrome.endpoint);
    for (const page of pages) {
      const { result, errors } = await runPage(cdp, `http://127.0.0.1:${port}/${page}`);
      const ok = result.total > 0 && result.passed === result.total && result.failures.length === 0;
      if (!ok) failed = true;
      console.log(`${ok ? "通过" : "失败"}  ${page}  ${result.passed}/${result.total}`);
      for (const failure of result.failures) console.log(`    ✗ [${failure.scenario}] ${failure.message}`);
      for (const error of errors) console.log(`    控制台：${error}`);
    }
  } catch (error) {
    failed = true;
    console.error(`运行失败：${error instanceof Error ? error.message : error}`);
  } finally {
    if (cdp) {
      await Promise.race([cdp.send("Browser.close").catch(() => {}), sleep(3000)]);
      cdp.close();
    }
    if (chrome) {
      // 优先正常关闭，超时后强制结束，确保不遗留 Chrome 进程
      if (chrome.child.exitCode === null) {
        const exited = await Promise.race([chrome.exited.then(() => true), sleep(5000).then(() => false)]);
        if (!exited) { chrome.child.kill("SIGKILL"); await chrome.exited; }
      }
      await rm(chrome.profile, { recursive: true, force: true }).catch(() => {});
    }
    await server.close();
  }
  console.log(failed ? "浏览器回归未通过" : "浏览器回归全部通过");
  process.exitCode = failed ? 1 : 0;
}

await main();
