import { useState } from "react";

export function PluginIcon({ icon }: { icon: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (icon && failed !== icon) return <img className="plugin-icon" src={icon} alt="" onError={() => setFailed(icon)} />;
  return <svg className="plugin-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5h8v5h2a3 3 0 0 1 0 6h-2v8h-5v-2a3 3 0 0 0-6 0v2H5V5h7Z" />
  </svg>;
}
