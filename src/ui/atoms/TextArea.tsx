import type { TextareaHTMLAttributes } from "react";
import { input } from "../styles";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea({ style, ...rest }: Props) {
  return (
    <textarea
      style={{ ...input, resize: "vertical", fontFamily: "inherit", ...style }}
      {...rest}
    />
  );
}
