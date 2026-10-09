import { X } from "../../shared/ui/icons";
import type { InstalledUpdate } from "../model/updateNotice";

type Props = {
  update: InstalledUpdate | null;
  onOpen: (version: string) => void;
  onDismiss: () => void;
};

export function UpdateRailCard({ update, onOpen, onDismiss }: Props) {
  if (!update) return null;

  return (
    <section
      role="status"
      className="relative overflow-hidden rounded-lg bg-content/12"
    >
      <button
        type="button"
        onClick={() => onOpen(update.version)}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-2 pr-8 text-left hover:bg-accent/10 focus-visible:focus-ring-inset"
      >
        <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center">
          <img
            src="/monocode.png"
            alt=""
            aria-hidden
            className="size-4 object-contain"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium leading-tight text-content">
            Updated to {update.version}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted">
            What's new
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss update notification"
        onClick={onDismiss}
        className="absolute right-1 top-1 grid size-6 place-items-center rounded-md text-muted hover:bg-content/8 hover:text-content focus-visible:focus-ring"
      >
        <X className="size-3.5" strokeWidth={1.75} />
      </button>
    </section>
  );
}
