import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cx } from "./cx";
import type { ControlLook } from "./TextField";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  look?: ControlLook;
  /**
   * `neutral` ticks in the theme's main colour, which is what the interface uses for every
   * control (green is reserved for status). `system` keeps the browser's own blue: the settings
   * pages have always shown it, and they say so explicitly. Delete `tone="system"` there to
   * bring them in line with the rest.
   */
  tone?: "neutral" | "system";
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ look = "field", tone = "neutral", className, ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      type="checkbox"
      data-ui="checkbox"
      className={cx(look === "field" && "ui-checkbox", look === "field" && tone === "neutral" && "ui-checkbox--neutral", className)}
    />
  );
});
