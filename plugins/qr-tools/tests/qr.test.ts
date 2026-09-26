import assert from "node:assert/strict";
import test from "node:test";
import { decodePixels, LEVELS, renderPixels, toSvg } from "../src/qr.ts";

test("生成后可识别回原文：中文、表情、网址、多行与各纠错级别", () => {
  const samples = ["https://example.com/path?q=二维码&x=1", "你好，轻匣 👋", "第一行\n第二行\t制表", "1234567890", "HELLO WORLD"];
  for (const text of samples) for (const { id } of LEVELS) {
    assert.equal(decodePixels(renderPixels(text, id)), text, `${id}：${text}`);
  }
});

test("反色二维码（深底浅码）同样可识别", () => {
  const pixels = renderPixels("反色内容", "M");
  for (let index = 0; index < pixels.data.length; index += 4) {
    for (const channel of [0, 1, 2]) pixels.data[index + channel] = 255 - pixels.data[index + channel];
  }
  assert.equal(decodePixels(pixels), "反色内容");
});

test("没有二维码的图片返回 null", () => {
  const width = 200;
  assert.equal(decodePixels({ data: new Uint8ClampedArray(width * width * 4).fill(255), width, height: width }), null);
});

test("生成 SVG；超出容量时给出中文错误", async () => {
  assert.match(await toSvg("abc", "M"), /^<svg[\s\S]*<\/svg>\s*$/);
  await assert.rejects(toSvg("字".repeat(3000), "H"), /内容太长（9000 字节）/);
});
