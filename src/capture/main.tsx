import React from "react";
import ReactDOM from "react-dom/client";
import { CaptureOverlay } from "./CaptureOverlay";
import "./capture.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CaptureOverlay />
  </React.StrictMode>,
);
