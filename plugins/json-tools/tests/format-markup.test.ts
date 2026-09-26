import assert from "node:assert/strict";
import test from "node:test";
import { compactMarkup, detectMarkup, formatMarkup } from "../src/format-markup.ts";

test("识别 HTML 与 XML，非标签开头返回空", () => {
  assert.equal(detectMarkup('  <?xml version="1.0"?><root/>'), "xml");
  assert.equal(detectMarkup("<!DOCTYPE html><html></html>"), "html");
  assert.equal(detectMarkup("<div><span>a</span></div>"), "html");
  assert.equal(detectMarkup("<order><id>1</id></order>"), "xml");
  assert.equal(detectMarkup('{"a":"<b>"}'), null);
  assert.equal(detectMarkup("a < b"), null);
});

test("XML 按层级缩进，短文本与开闭标签同行，注释、CDATA、声明原样保留", () => {
  const source = '<?xml version="1.0"?><order id="1"><!-- 订单 --><item name="a>b">苹果</item><empty></empty><note><![CDATA[<x>]]></note><self/></order>';
  assert.equal(formatMarkup(source, "xml"), [
    '<?xml version="1.0"?>',
    '<order id="1">',
    "  <!-- 订单 -->",
    '  <item name="a>b">苹果</item>',
    "  <empty></empty>",
    "  <note>",
    "    <![CDATA[<x>]]>",
    "  </note>",
    "  <self/>",
    "</order>",
  ].join("\n"));
});

test("HTML 空元素不增加缩进，pre 原样保留，script 重新缩进", () => {
  const source = '<div><br><img src="a.png"><pre>  a\n    b</pre><script>\n    if (a < b) {\n      go();\n    }\n</script></div>';
  assert.equal(formatMarkup(source, "html"), [
    "<div>",
    "  <br>",
    '  <img src="a.png">',
    "  <pre>  a\n    b</pre>",
    "  <script>",
    "    if (a < b) {",
    "      go();",
    "    }",
    "  </script>",
    "</div>",
  ].join("\n"));
});

test("标签不配对时不抛错，缩进不为负", () => {
  assert.equal(formatMarkup("</a><b><c>x</c>", "xml"), "</a>\n<b>\n  <c>x</c>");
});

test("压缩去掉标签间空白，原始内容不变", () => {
  assert.equal(compactMarkup("<a>\n  <b> x </b>\n</a>", "xml"), "<a><b>x</b></a>");
  assert.equal(compactMarkup("<pre> a\n b </pre>", "html"), "<pre> a\n b </pre>");
});
