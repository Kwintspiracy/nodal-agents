/**
 * SetMini — inline action row (canvas-coloured bg, label + description + action slot).
 * Used for optional feature toggles like "Google OAuth → Add".
 */
export function SetMini({
  name,
  description,
  action,
}: {
  name: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 px-4 py-3.5 rounded-[10px] bg-neutral-950/50 mt-2">
      <span className="flex-1 min-w-0">
        <span className="block text-[13.5px] font-medium leading-[1.3] text-white">{name}</span>
        <span className="block text-[12.5px] leading-[1.4] text-neutral-400 mt-0.5">
          {description}
        </span>
      </span>
      <span className="flex-shrink-0">{action}</span>
    </div>
  );
}
