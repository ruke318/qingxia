// 渲染 README 介绍动画：用独立的无界面 Chrome 逐帧截取 intro.html，再用 ffmpeg 合成。
// 用法：node docs/intro/render.mjs
// 依赖：Chrome（可用 CHROME_PATH 指定路径）与 ffmpeg（需包含 libx264、libwebp_anim）。
// 产物：docs/images/intro.mp4（1920×1080，30fps）与 docs/images/intro.webp（README 内嵌的循环动图）。
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const images = join(here, "..", "images");
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FPS = 30;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchChrome(profile) {
  const child = spawn(chromePath, [
    "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--allow-file-access-from-files",
    "--hide-scrollbars", "--force-color-profile=srgb", "about:blank",
  ], { stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("无界面 Chrome 启动失败");
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("等待 Chrome 调试端口超时"); }
    const port = await readFile(join(profile, "DevToolsActivePort"), "utf8").then((text) => text.split("\n")[0]).catch(() => null);
    if (port) {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => null);
      const page = pages?.find((item) => item.type === "page");
      if (page) return { child, url: page.webSocketDebuggerUrl };
    }
    await sleep(100);
  }
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    } else if (message.method && listeners.has(message.method)) listeners.get(message.method)(message.params);
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener("error", () => reject(new Error("无法连接 Chrome 调试端口")));
    socket.addEventListener("open", () => resolve({
      send: (method, params = {}) => new Promise((done, fail) => { id += 1; waiting.set(id, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id, method, params })); }),
      once: (method) => new Promise((done) => listeners.set(method, done)),
      close: () => socket.close(),
    }));
  });
}

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("ffmpeg 执行失败");
}

const profile = await mkdtemp(join(tmpdir(), "qingbox-intro-chrome-"));
const frames = await mkdtemp(join(tmpdir(), "qingbox-intro-frames-"));
let chrome = null;
try {
  chrome = await launchChrome(profile);
  const cdp = await connect(chrome.url);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: false });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__frameMode = true;" });
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: pathToFileURL(join(here, "intro.html")).href });
  await loaded;
  const evaluate = (expression) => cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((result) => result.result.value);
  await evaluate("document.fonts.ready.then(() => Promise.all([...document.images].map((image) => image.decode())))");
  const duration = await evaluate("window.DURATION");
  const total = Math.round(duration * FPS);
  for (let frame = 0; frame < total; frame += 1) {
    await evaluate(`window.renderAt(${frame / FPS})`);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(frames, `${String(frame).padStart(4, "0")}.png`), Buffer.from(data, "base64"));
    if (frame % 60 === 0) process.stdout.write(`已渲染 ${frame}/${total} 帧\n`);
  }
  cdp.close();

  const input = ["-framerate", String(FPS), "-i", join(frames, "%04d.png")];
  ffmpeg([...input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", join(images, "intro.mp4")]);
  ffmpeg([...input, "-vf", "fps=20,scale=960:-1:flags=lanczos", "-c:v", "libwebp_anim", "-q:v", "72", "-compression_level", "6", "-loop", "0", join(images, "intro.webp")]);
  console.log(`完成：共 ${total} 帧 → docs/images/intro.mp4、docs/images/intro.webp`);
} finally {
  chrome?.child.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true });
  await rm(frames, { recursive: true, force: true });
}
