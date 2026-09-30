import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * How a control gets its look.
 *
 * - `field` is the standard look every form uses (bordered box, 34px for a single line). It
 *   is the default, so a new field is right without knowing which page it lands on.
 * - `plain` adds nothing. Use it when the surrounding component draws the box itself (a
 *   search field with an icon, a toolbar, a table cell) and a class you pass owns the rest.
 */
export type ControlLook = "field" | "plain";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  look?: ControlLook;
}

/** A single-line input: text, number, password, search, ... Checkboxes have their own component. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({ look = "field", className, ...props }, ref) {
  return <input {...props} ref={ref} data-ui="input" className={cx(look === "field" && "ui-input", className)} />;
});
