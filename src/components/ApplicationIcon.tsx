import { useEffect, useRef, useState } from "react";
import { getApplicationIcon } from "../lib/bridge";
import { FileIcon } from "./FileIcon";

const iconCache = new Map<string, Promise<string>>();

function loadIcon(path: string): Promise<string> {
  const cached = iconCache.get(path);
  if (cached) {
    iconCache.delete(path);
    iconCache.set(path, cached);
    return cached;
  }
  const request = getApplicationIcon(path);
  iconCache.set(path, request);
  if (iconCache.size > 128) iconCache.delete(iconCache.keys().next().value!);
  void request.catch(() => {
    if (iconCache.get(path) === request) iconCache.delete(path);
  });
  return request;
}

export function ApplicationIcon({ path }: { path: string }) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [icon, setIcon] = useState<{ path: string; source: string } | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let cancelled = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (cancelled || !entry.isIntersecting || entry.intersectionRatio === 0) return;
      observer.disconnect();
      void loadIcon(path).then((source) => {
        if (!cancelled) setIcon({ path, source });
      }).catch(() => {});
    });
    observer.observe(element);
    return () => { cancelled = true; observer.disconnect(); };
  }, [path]);

  return (
    <span className="application-icon" ref={elementRef}>
      {icon?.path === path ? <img src={icon.source} alt="" onError={() => {
        iconCache.delete(path);
        setIcon(null);
      }} /> : <FileIcon kind="application" />}
    </span>
  );
}
