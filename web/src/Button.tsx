import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './icons';

export type Variant = 'primary' | 'secondary' | 'quiet' | 'link';
export type Size = 'sm' | 'md' | 'lg';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  /** Icon-only buttons need a label: it becomes the accessible name and the tooltip. */
  label?: string;
  /** Keyboard shortcut shown in the tooltip, e.g. "e". */
  shortcut?: string;
  /** Toggle buttons (star): pressed state. */
  pressed?: boolean;
  iconFilled?: boolean;
};

/** The only button in the app. See DESIGN.md §6 for when to use each variant. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'secondary', size = 'md', icon, label, shortcut, pressed, iconFilled, className = '', children, type = 'button', ...rest }, ref,
) {
  const iconOnly = !children && !!icon;
  const tip = label ? (shortcut ? `${label} (${shortcut})` : label) : undefined;
  return (
    <button ref={ref} type={type} {...rest}
      className={`btn btn--${variant} btn--${size}${iconOnly ? ' btn--icon' : ''}${pressed ? ' is-on' : ''} ${className}`.trim()}
      aria-label={iconOnly ? label : undefined} title={rest.title ?? tip} aria-pressed={pressed}>
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} filled={iconFilled ?? pressed} />}
      {children}
    </button>
  );
});
