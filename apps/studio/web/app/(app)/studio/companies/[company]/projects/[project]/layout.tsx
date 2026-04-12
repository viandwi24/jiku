// PluginUIProvider lives in the parent `studio/layout.tsx` so the sidebar
// (rendered alongside this tree) also sees the registry. Keep this layout thin.
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
