import type { ChangeEvent } from "react";
import { RangeSlider } from "../atoms";
import { SectionCard } from "../molecules/SectionCard";
import {
  MIN_SCALE,
  scaleForSize,
  sizeForScale,
  type WindowSize,
} from "../../window-size";

type Props = {
  winSize: WindowSize;
  onChange: (size: WindowSize) => void;
};

export function WindowSizeSection({ winSize, onChange }: Props) {
  const scale = scaleForSize(winSize);
  const percent = Math.round(scale * 100);

  return (
    <SectionCard
      title="Companion Window"
      badge={`${winSize.width} × ${winSize.height}px`}
    >
      <div className="preset-bar">
        {[0.75, 1.0, 1.25, 1.5].map((s) => {
          const p = Math.round(s * 100);
          const active = Math.abs(scale - s) < 0.02;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onChange(sizeForScale(s))}
              className={`preset-btn ${active ? "preset-btn-active" : ""}`}
            >
              {p}%
            </button>
          );
        })}
      </div>

      <RangeSlider
        label="Scale Factor"
        valueLabel={`${percent}%`}
        min={MIN_SCALE}
        max={2.0}
        step={0.05}
        value={scale}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          onChange(sizeForScale(parseFloat(e.target.value)));
        }}
      />
    </SectionCard>
  );
}