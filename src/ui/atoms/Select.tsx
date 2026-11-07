import type { SelectHTMLAttributes } from "react";
import { select } from "../styles";

type Props = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ style, ...rest }: Props) {
  return <select style={{ ...select, ...style }} {...rest} />;
}
