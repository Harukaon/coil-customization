# Form controls

Every input in the app is one of these. They carry the standard look, so a new field is right without knowing which page it lands on.

```tsx
import { Checkbox, Field, TextArea, TextField } from "../../ui/form";

<Field>Base URL<TextField value={url} onChange={...} /></Field>   // caption above a 34px field
<Field>Headers<TextArea value={json} onChange={...} /></Field>    // monospace, 72px min
<Field className="checkbox-setting"><Checkbox checked={on} onChange={...} />Enable</Field>
```

- **`look="field"`** (default): the standard bordered box.
- **`look="plain"`**: adds nothing. For controls whose surrounding component draws the box (a search field with an icon, a toolbar, a table cell); give it a class and style it with `input.my-class { ... }`.
- **`Checkbox tone`**: `neutral` (default) ticks in the theme's main colour. `system` keeps the browser's blue, which the settings pages still show.

Rules (enforced by `tests/form-controls.test.ts`):

1. No bare `<input>` / `<textarea>` in a page.
2. Never style a control by the container it sits in (`.page input { ... }`); put a class on the control. A container-wide rule reaches every control that ever lands in it, which is what made a new field come out wrong on its first try.
3. `!important` only goes down.

Changing any control style? Prove it moved nothing on screen:

```bash
FORM_AUDIT_OUT=/tmp/before.json npm run e2e -- form-audit   # on the old build
FORM_AUDIT_OUT=/tmp/after.json  npm run e2e -- form-audit   # on the new one
node scripts/form-audit-diff.mjs /tmp/before.json /tmp/after.json
```

It records the final computed style, box, placeholder and focus look of every control, label, form and footer on ~40 screens, in the light and dark theme.
