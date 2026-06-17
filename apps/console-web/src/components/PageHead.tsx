import { ReactNode } from "react";

export default function PageHead({
  eyebrow, title, lede, meta, actions,
}: {
  eyebrow?: string;
  title: string;
  lede?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="ph">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions ? <div className="ph-actions">{actions}</div>
                : meta ? <div className="ph-meta">{meta}</div> : null}
    </header>
  );
}
