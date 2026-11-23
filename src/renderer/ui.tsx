import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${variant} btn-${size} ${className}`} disabled={rest.disabled || loading} data-loading={loading || undefined}>
      {loading && <Spinner />}
      <span className="btn-label">{children}</span>
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Skeleton({ w = "100%", h = 14, r = 6, className = "" }: { w?: number | string; h?: number | string; r?: number; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ width: w, height: h, borderRadius: r }} />;
}

export function ProgressBar({ value, tone = "accent", thin }: { value: number; tone?: "accent" | "good" | "xp"; thin?: boolean }) {
  return (
    <div className={`bar ${thin ? "thin" : ""}`}>
      <div className={`bar-fill ${tone}`} style={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} />
    </div>
  );
}

/** Circular progress, e.g. level ring or daily target. */
export function Ring({ value, size = 44, stroke = 4, tone = "accent", children }: { value: number; size?: number; stroke?: number; tone?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className={`ring-fill ${tone}`}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-center">{children}</span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-glyph" />
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}
