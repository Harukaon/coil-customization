import { forwardRef } from "react";
import type { LabelHTMLAttributes } from "react";
import { cx } from "./cx";
import type { ControlLook } from "./TextField";

export interface FieldProps extends LabelHTMLAttributes<HTMLLabelElement> {
  look?: ControlLook;
}

/** A label that wraps its caption and the control: the caption sits above, in the small heavy form type. */
export const Field = forwardRef<HTMLLabelElement, FieldProps>(function Field({ look = "field", className, ...props }, ref) {
  return <label {...props} ref={ref} data-ui="field" className={cx(look === "field" && "ui-field", className)} />;
});
