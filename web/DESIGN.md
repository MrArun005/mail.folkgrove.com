# OpenMail design system

Mail is a tool people live in all day. The interface should be calm, exact and fast: nothing decorative, nothing
misaligned, every action where the hand expects it. These rules are binding for every screen and every PR.

## Principles

1. **Reading is the product.** Messages and the compose editor use the reading serif (Newsreader). Everything else
   is interface and uses the grotesk (Schibsted Grotesk). Never mix them inside one control.
2. **One accent, one meaning.** Ultramarine (`--accent`) means "you can act here" or "this is new". It is never
   decoration. Gold is reserved for stars; green only for privacy protections; red only for errors and destruction.
3. **Every pane has one left edge.** Each pane defines a gutter (`--gutter-*`). Titles, search, rows, toolbars and
   body text all start on it. Icon-only toolbars are *optically* aligned: the icon, not the button, sits on the edge.
4. **Messages have one text column.** Inside a message, the avatar sits on the pane gutter and everything else
   (body, notices, attachments, reply buttons) starts on the text column after it (`--text-col`).
5. **Three control heights.** `sm` 28px, `md` 36px, `lg` 44px. Controls in a row share one height. Icons are 16px
   in `sm` and 18px otherwise.
6. **One button component.** `<Button>` in `src/Button.tsx` is the only way to make a button. Variants:
   - `primary` — the single most important action in a region (Send, Compose, Save). At most one per region.
   - `secondary` — outlined; other explicit actions (Reply, Cancel).
   - `quiet` — no chrome until hover; toolbars, row actions, close buttons.
   - `link` — inline text action inside a sentence (Load images, Undo, Unsubscribe).
   Shape: buttons are pills; icon-only buttons are circles. No square buttons.
7. **Spacing comes from the scale.** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 (`--s1`…`--s10`). No other values.
8. **Radius has three steps.** `--r-sm` 6px for inputs and chips, `--r-md` 10px for cards and menus, `--r-lg` 14px
   for sheets and dialogs, plus `--r-full` for pills and circles.
9. **Type has five sizes.** 12 meta · 13 secondary · 14 body UI · 17 reading · 24/30 headings. Weights 400/500/600/700.
10. **States are always visible.** Hover, focus (2px accent ring), pressed, selected, disabled. Focus is never removed.
11. **Motion answers the user.** Sheets rise, toasts slide in; nothing animates on its own. Respect reduced motion.
12. **Words are plain.** Buttons say what happens ("Save settings", not "Submit"). Errors say what went wrong and how
    to fix it. Empty states invite the next action.

## Tokens

All tokens live at the top of `src/styles.css`, with light and dark values. Components never use raw colours,
sizes or radii.

## Checklist for every UI change

- [ ] Same left edge as its siblings? Check with a screenshot at 1440px and 390px.
- [ ] Only `<Button>` for buttons; right variant; one primary per region.
- [ ] Heights from `sm/md/lg`; spacing and radius from the scale.
- [ ] Light and dark both checked; focus ring visible; works with keyboard only.
