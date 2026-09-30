/** Joins class names, skipping the ones that are off. Returns undefined when nothing is left, so no empty class attribute is written. */
export function cx(...names: Array<string | false | null | undefined>): string | undefined {
  const joined = names.filter(Boolean).join(" ");
  return joined || undefined;
}
