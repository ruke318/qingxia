import React from "react";
import ReactDOM from "react-dom/client";
import { CaptureOverlay } from "./CaptureOverlay";
import { PinView } from "./PinView";
import "./capture.css";

// 同一页面入口承载截图覆盖窗与贴图窗口，由宿主注入的变量区分
const pin = window.__QINGBOX_PIN__;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {pin ? <PinView image={pin.image} /> : <CaptureOverlay />}
  </React.StrictMode>,
);
