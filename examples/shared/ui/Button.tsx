import type { ReactNode } from "react";
import "./button.css";

export function Button({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button className="ui-button" onClick={onClick}>
      {children}
    </button>
  );
}
