import type { CSSProperties } from "react";

export const section: CSSProperties = {
  marginBottom: 16,
};

export const heading: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#8ab4f8",
  marginBottom: 8,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

export const label: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 12,
  opacity: 0.85,
};

export const input: CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "6px 8px",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 4,
  background: "rgba(255,255,255,0.06)",
  color: "white",
  boxSizing: "border-box",
};

export const select: CSSProperties = {
  ...input,
  appearance: "none",
  cursor: "pointer",
};

export const button: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 4,
  background: "rgba(255,255,255,0.06)",
  color: "white",
  cursor: "pointer",
};

export const card: CSSProperties = {
  padding: "10px 12px",
  background: "rgba(255,255,255,0.04)",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.08)",
};
