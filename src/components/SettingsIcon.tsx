import type { ReactNode } from "react";

/** 设置页的单色图标，颜色跟随现有主题。 */
export function SettingsIcon({ name }: { name: string }) {
  const shapes: Record<string, ReactNode> = {
    launcher: <><circle cx="10" cy="10" r="6" /><path d="m14.5 14.5 4 4" /></>,
    shortcuts: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 9h.01M11 9h.01M15 9h.01M7 13h.01M11 13h.01M15 13h.01M8 16h8" /></>,
    screenshot: <><path d="M8 4H5a1 1 0 0 0-1 1v3m12-4h3a1 1 0 0 1 1 1v3M4 16v3a1 1 0 0 0 1 1h3m12-4v3a1 1 0 0 1-1 1h-3" /><rect x="8" y="8" width="8" height="8" rx="1" /></>,
    recording: <><rect x="3" y="5" width="14" height="14" rx="3" /><path d="m17 10 4-3v10l-4-3" /><circle cx="10" cy="12" r="2" /></>,
    fullscreen: <><path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5M4 4l5 5m11-5-5 5M4 20l5-5m11 5-5-5" /></>,
    "clipboard-history": <><rect x="5" y="5" width="14" height="16" rx="2" /><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M9 11h6m-6 4h6" /></>,
    "crypto-tools": <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-5 1 2-12" /></>,
    "hosts-switch": <><path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" /></>,
    "json-tools": <><path d="M8 4H6v6l-2 2 2 2v6h2m8-16h2v6l2 2-2 2v6h-2" /></>,
    "qr-tools": <><path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h2v2h4v4h-6v-2m6-4v1" /></>,
  };
  return <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {shapes[name] ?? <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></>}
  </svg>;
}
