import React from "react";
import ReactDOM from "react-dom/client";
import { CaptureOverlay } from "./CaptureOverlay";
import { PinView } from "./PinView";
import { LongShotPanel } from "./LongShotPanel";
import { RecordSelector } from "./RecordSelector";
import { RecordControl } from "./RecordControl";
import { RecordCard } from "./RecordCard";
import "./capture.css";
import "./record.css";

// 同一页面入口承载截图覆盖窗与贴图窗口，由宿主注入的变量区分
const pin = window.__QINGBOX_PIN__;
const record = window.__QINGBOX_RECORD__;
const longShot = window.__QINGBOX_LONG__;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {record ? record.role === "select" ? <RecordSelector context={record} />
      : record.role === "control" ? <RecordControl context={record} />
      : record.role === "card" ? <RecordCard context={record} />
      : <div className="record-border" aria-hidden="true" />
      : longShot ? <LongShotPanel session={longShot.session} side={longShot.side} />
      : pin ? <PinView image={pin.image} /> : <CaptureOverlay />}
  </React.StrictMode>,
);
