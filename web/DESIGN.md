# OpenMail design system

Mail is a tool people live in all day. The interface should be calm, exact and fast: nothing decorative, nothing
misaligned, every action where the hand expects it. These rules are binding for every screen and every PR.

## Principles

1. **One typeface, tuned by size.** Google Sans Flex (open source, OFL) for everything: interface, subjects and messages,
   like Gmail. Its optical-size axis adjusts letter shapes to the size, so small labels stay clear and headings stay
   crisp. Geist Mono for addresses, keys and codes. A serif (Newsreader) for messages is a per-device setting.
   **Headings are never italic.** Sizes scale with Settings → Text size (and with browser zoom): every font size is
   `calc(<px> * var(--scale))`.
2. **Grove by default, one accent.** Theme "Grove" (our own): white panes floating on a very light canvas with a
   breath of green, deep green (`--accent`) for "you can act here" or "this is new". "Clean" (Gmail-style blue) and
   "Paper" (warm off-white) are options. Dark is near-neutral charcoal. Compose is a soft tonal button so Send stays the one strong blue button. Gold only for stars, `--safe`
   (blue in Grove, green in Clean and Paper) only for privacy protections, red only for errors and destructive confirmations.
   **Unread is weight plus a dot, never a coloured stripe on the row edge.** A row leads with the sender's initial
   (colour from their address); it becomes the checkbox under the pointer, while selecting, and when tapped.
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
   Destructive confirmations: `variant="primary"` plus `className="btn--danger"` (red), only in dialogs.
   **Allowed native `<button>`s** (they are list items, not buttons): message-list rows (`.open`), rail items
   (`.nav-item`), menu rows (`.menu-item`), tabs (`.tab`), attachment chips (`.chip`), folded messages (`.folded`)
   and calendar events/cells. Anything that reads as an action button uses `<Button>`.
7. **Spacing comes from the scale.** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40: `--s1 --s2 --s3 --s4 --s5 --s6 --s8 --s10`.
   Exceptions: 2px gaps inside dense lists and 6px icon-to-label gaps (optical, not layout).
8. **Radius has three steps.** `--r-sm` 6px for inputs and chips, `--r-md` 10px for cards and menus, `--r-lg` 14px
   for sheets and dialogs, plus `--r-full` for pills and circles.
9. **Type has six sizes** (`--t-xs` 12 meta · `--t-sm` 13 secondary · `--t-md` 14 body UI · `--t-read` 15 reading
   (17 in serif) · `--t-h2` 22 · `--t-h1` 28), plus 15 for large buttons and pane titles, 20 for dialog titles and 22 for
   the wordmark; all × `--scale`. Density (Settings) sets list row padding (`--row-pad`). Weights 400/500/600/700.
10. **Contrast and reach.** Text meets WCAG AA (4.5:1; 3:1 for large text and icons) in light *and* dark. On
    phones, tap targets are at least 36px (`md`); `sm` controls are for pointer layouts only. HTML email always
    renders on `--white` (senders design for white), in both themes.
11. **States are always visible.** Hover, focus (2px accent ring), pressed, selected, disabled. Focus is never removed.
12. **Motion answers the user.** Sheets rise, toasts slide in; nothing animates on its own. Three named easings
    (`--ease-out`, `--ease-in`, `--ease-in-out`) and `--dur`; never bounce. Respect reduced motion.
13. **No browser dialogs.** `confirm()`, `prompt()` and `alert()` are banned: use `confirmIt` / `promptIt` / `notify`
    from `src/Dialog.tsx`. Destructive confirmations use the red primary and say what is lost.
14. **Words are plain.** Buttons say what happens ("Save settings", not "Submit"). Errors say what went wrong and how
    to fix it. Empty states invite the next action.

## Tokens

All tokens live at the top of `src/styles.css`, in OKLCH, with light and dark values. Components never use raw
colours, sizes or radii.

## Checklist for every UI change

- [ ] Same left edge as its siblings? Check with a screenshot at 1440px and 390px.
- [ ] Only `<Button>` for buttons; right variant; one primary per region.
- [ ] Heights from `sm/md/lg`; spacing and radius from the scale.
- [ ] Light and dark both checked; focus ring visible; works with keyboard only.
- [ ] No italic heading, no side-stripe, no browser dialog, numbers in columns are tabular.
