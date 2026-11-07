import type { InputHTMLAttributes } from "react";
import { input } from "../styles";

type Props = InputHTMLAttributes<HTMLInputElement>;

export function TextInput({ style, ...rest }: Props) {
  return <input style={{ ...input, ...style }} {...rest} />;
}
