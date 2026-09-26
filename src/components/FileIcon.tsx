import type { FileIconKind } from "../lib/file-types";

export function FileIcon({ kind }: { kind: FileIconKind }) {
  return (
    <svg className={`file-icon file-icon-${kind}`} viewBox="0 0 32 32" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {kind === "folder" ? <>
        <path d="M3.5 9a2 2 0 0 1 2-2h6l3 3h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-21a2 2 0 0 1-2-2Z" fill="currentColor" fillOpacity=".15" />
        <path d="M4 13h24" />
      </> : kind === "application" ? <>
        <rect x="4" y="4" width="24" height="24" rx="6" fill="currentColor" fillOpacity=".12" />
        <path d="m11 22 8-13m-5 0 8 13M8 19h16" strokeWidth="2" />
      </> : <>
        <path d="M7 3.5h12l6 6V27a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 7 27Z" fill="currentColor" fillOpacity=".08" />
        <path d="M19 3.5v6h6" opacity=".65" />
        {kind === "pdf" && <><path d="m11 23 5-10 5 10m-8-4h6" /><path d="M10 25h12" opacity=".55" /></>}
        {kind === "json" && <><path d="M13 14h-1v3l-2 2 2 2v3h1m6-10h1v3l2 2-2 2v3h-1" /><circle cx="16" cy="17" r=".7" fill="currentColor" stroke="none" /><circle cx="16" cy="21" r=".7" fill="currentColor" stroke="none" /></>}
        {kind === "code" && <><path d="m12.5 15-3 4 3 4m7-8 3 4-3 4m-2-9-3 10" /></>}
        {kind === "document" && <path d="M11 15h10m-10 4h10m-10 4h6" />}
        {kind === "spreadsheet" && <><rect x="10.5" y="13.5" width="11" height="11" rx=".5" /><path d="M14 14v10m-3-7h10m-10 3.5h10" /></>}
        {kind === "presentation" && <><rect x="10" y="13" width="12" height="9" rx="1" /><path d="M16 22v3m-3 1 3-1 3 1m-6-8 2-2 3 3 2-2" /></>}
        {kind === "image" && <><rect x="10" y="13" width="12" height="11" rx="1" /><circle cx="18.5" cy="16.5" r="1" /><path d="m10 22 4-5 5 6m-2-2 2-2 3 3" /></>}
        {kind === "audio" && <><path d="M14 22v-8l7-1v7m-7-3 7-1" /><ellipse cx="12" cy="23" rx="2" ry="1.5" /><ellipse cx="19" cy="21" rx="2" ry="1.5" /></>}
        {kind === "video" && <><rect x="10" y="13" width="12" height="11" rx="1" /><path d="m15 16 4 3-4 2Z" fill="currentColor" fillOpacity=".2" /></>}
        {kind === "archive" && <><path d="M16 11v10" strokeDasharray="1 2" strokeWidth="3" /><rect x="14" y="22" width="4" height="3" rx="1" /></>}
        {kind === "file" && <path d="M11 17h10m-10 4h7" opacity=".6" />}
      </>}
    </svg>
  );
}
