type Props = {
  message: string;
};

export function ErrorOverlay({ message }: Props) {
  return (
    <p
      style={{
        position: "fixed",
        top: 8,
        left: 8,
        color: "salmon",
        fontSize: 11,
        background: "rgba(0,0,0,0.4)",
        padding: "2px 6px",
        borderRadius: 4,
      }}
    >
      {message}
    </p>
  );
}
