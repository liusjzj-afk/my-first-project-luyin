import type { ReactNode } from "react";

type TabButtonProps = {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
};

export function TabButton({ active, icon, label, onClick }: TabButtonProps) {
  return (
    <button className={`tab-button transition-all duration-300 ${active ? "active" : ""}`} onClick={onClick} role="tab" aria-selected={active}>
      {icon}
      {label}
      <span />
    </button>
  );
}
