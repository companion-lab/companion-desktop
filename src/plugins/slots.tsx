// React outlets that render registry contributions.
//
// - `SlotOutlet`: renders plugin widgets anchored at a main-window slot.
// - `WidgetHost`: renders a plugin override of a built-in widget if one is
//   registered, otherwise the built-in. The override contract is "same props
//   as the built-in widget".

import type { ComponentType } from "react";
import { getWidgetOverride, getWidgets, useRegistryVersion } from "./registry";
import type { MainSlot } from "./types";

export function SlotOutlet({ slot }: { slot: MainSlot }) {
  useRegistryVersion();
  const widgets = getWidgets(slot);
  if (widgets.length === 0) return null;
  return (
    <>
      {widgets.map((w, i) => (
        <w.component key={`${w.slot}:${i}`} />
      ))}
    </>
  );
}

type WidgetHostProps<P> = {
  targetId: string;
  /** The built-in widget. Optional: feature plugins replace built-ins, and
   *  once a built-in is extracted the host renders the target with no
   *  fallback — nothing shows unless a plugin overrides it. */
  fallback?: ComponentType<P>;
} & P;

// The spread makes this component transparent: built-ins keep receiving the
// exact props App.tsx always passed them, and overrides get them too.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function WidgetHost<P extends Record<string, any>>(
  props: WidgetHostProps<P>,
) {
  const { targetId, fallback: Fallback, ...rest } = props;
  useRegistryVersion();
  const Override = getWidgetOverride(targetId);
  const Component = (Override ?? Fallback) as ComponentType<P> | undefined;
  if (!Component) return null;
  return <Component {...(rest as unknown as P)} />;
}
