import { button } from "../styles";

type Props<T extends string> = {
  items: readonly T[];
  active?: T;
  onPick: (item: T) => void;
};

export function ButtonGroup<T extends string>({ items, active, onPick }: Props<T>) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {items.map((item) => (
        <button
          key={item}
          onClick={() => onPick(item)}
          style={{
            ...button,
            padding: "6px 12px",
            ...(item === active && { background: "rgba(255,255,255,0.25)" }),
            textTransform: "capitalize",
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
