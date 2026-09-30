import { forwardRef } from "react";
import type { TextareaHTMLAttributes } from "react";
import { cx } from "./cx";
import type { ControlLook } from "./TextField";

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  look?: ControlLook;
}

/** A multi-line input. The standard look is monospace, because most of what is typed here is JSON, a command or a prompt. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ look = "field", className, ...props }, ref) {
  return <textarea {...props} ref={ref} data-ui="textarea" className={cx(look === "field" && "ui-textarea", className)} />;
});
