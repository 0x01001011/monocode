import type { ComponentPropsWithRef } from "react";

type Props = Omit<ComponentPropsWithRef<"button">, "className"> & {
  danger?: boolean;
};

export function SecondaryButton({
  danger = false,
  type = "button",
  children,
  ...props
}: Props) {
  return (
    <button
      {...props}
      type={type}
      className={`flex shrink-0 items-center gap-1.5 rounded-md border border-content/10 px-2.5 py-1 text-[12px] ${
        danger
          ? "text-danger hover:border-danger/40 hover:bg-danger/10"
          : "text-content/70 hover:bg-content/10 hover:text-content"
      } press-feedback focus-visible:focus-ring disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent`}
    >
      {children}
    </button>
  );
}
