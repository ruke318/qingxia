import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type RecordRect = { x: number; y: number; width: number; height: number };
export type RecordTarget = { kind: "region" | "display" | "window"; display: number; window?: number; rect: RecordRect };
export type RecordOptions = { systemAudio: boolean; microphone: boolean; showClicks: boolean };
/** 录屏选项加上“只录这个窗口”，保存在本机，下次录屏沿用。 */
export type RecordPreferences = RecordOptions & { windowOnly: boolean };
export type RecordCandidate = RecordRect & { id: number; name: string };
export type RecordContext = {
  role: "select" | "control" | "border" | "card";
  /** 选区、控制条为录屏会话编号；卡片为卡片编号。 */
  session: number;
  display?: number;
  screen?: number;
  scale?: number;
  image?: string | null;
  windows?: RecordCandidate[];
  // 以下为录完的操作卡片
  name?: string;
  path?: string;
  duration?: number;
  size?: number;
  warning?: string | null;
  video?: string;
};
export type RecordStatus = {
  phase: "preparing" | "selecting" | "starting" | "recording" | "finalizing" | "preview" | "failed";
  elapsed: number;
  duration: number;
  fileSize: number;
  error: string | null;
};
declare global { interface Window { __QINGBOX_RECORD__?: RecordContext } }

export const errorMessage = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

const PREFERENCES_KEY = "qingbox.record.options";
const DEFAULT_PREFERENCES: RecordPreferences = { systemAudio: false, microphone: false, showClicks: true, windowOnly: false };

/** 读取上次的录屏选项；数据损坏或无效字段用默认值（声音默认关闭）。 */
export function loadRecordPreferences(storage: Pick<Storage, "getItem"> = localStorage): RecordPreferences {
  const preferences = { ...DEFAULT_PREFERENCES };
  try {
    const saved = JSON.parse(storage.getItem(PREFERENCES_KEY) ?? "{}") as Partial<Record<keyof RecordPreferences, unknown>>;
    for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof RecordPreferences)[]) {
      if (typeof saved?.[key] === "boolean") preferences[key] = saved[key] as boolean;
    }
  } catch {
    // 数据损坏时使用默认选项
  }
  return preferences;
}

export function saveRecordPreferences(preferences: RecordPreferences, storage: Pick<Storage, "setItem"> = localStorage) {
  try { storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* 存储不可用时只在本次生效 */ }
}

/** 每个录屏页面只读取当前会话；卸载后丢弃迟到响应并清理轮询。 */
export function useRecordStatus(session: number) {
  const [status, setStatus] = useState<RecordStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  useEffect(() => {
    let active = true, pending = false;
    async function update() {
      if (pending) return;
      pending = true;
      try {
        const next = await invoke<RecordStatus>("record_status", { session });
        if (active) { setStatus(next); setPollError(null); }
      } catch (failure) { if (active) setPollError(errorMessage(failure)); }
      finally { pending = false; }
    }
    void update();
    const timer = window.setInterval(() => { void update(); }, 500);
    return () => { active = false; window.clearInterval(timer); };
  }, [session]);
  return { status, pollError };
}

export function recordTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

export function fileSize(bytes: number) {
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
