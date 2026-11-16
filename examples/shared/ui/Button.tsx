import type { ReactNode } from "react";

export function Button({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button className="ui-button" onClick={onClick}>
      {children}
    </button>
  );
}
