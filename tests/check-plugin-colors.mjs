// 检查插件样式：背景、边框、阴影、描边不得写死颜色，须引用宿主主题变量 var(--qb-*)。
// 这样调整面板材质或主色时只改 packages/plugin-sdk/theme.css，插件无需改动。
// 确需实色（如二维码必须白底）时，在同一行加注释「/* 主题例外：原因 */」。
// 用法：node tests/check-plugin-colors.mjs
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PROPERTY = /(?:^|[;{\s])(background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|box-shadow|outline(?:-color)?)\s*:\s*([^;}]*)/g;
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|\bwhite\b|\bblack\b/;

async function cssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "tests"].includes(entry.name)) files.push(...await cssFiles(path));
    else if (entry.name.endsWith(".css")) files.push(path);
  }
  return files;
}

const plugins = await readdir(join(root, "plugins"));
const files = (await Promise.all(plugins.map((name) => cssFiles(join(root, "plugins", name, "src"))))).flat();
files.push(join(root, "examples/minimal-plugin/index.html"));

const problems = [];
for (const file of files) {
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    if (line.includes("主题例外")) return;
    for (const [, property, value] of line.matchAll(PROPERTY)) {
      if (LITERAL.test(value)) problems.push(`${relative(root, file)}:${index + 1}  ${property}: ${value.trim()}`);
    }
  });
}

if (problems.length) {
  console.error(`插件样式中有 ${problems.length} 处写死的颜色，请改用 var(--qb-*) 主题变量：\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`插件样式检查通过：${files.length} 个文件未写死背景、边框、阴影颜色`);
