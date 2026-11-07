// Hand-drawn 20px stroke icons. ponytail: a dozen paths beats an icon library dependency.
const paths = {
  inbox: 'M3 12h4l1.5 3h3L13 12h4M3 12l2.2-6.6A1 1 0 0 1 6.1 4.7h7.8a1 1 0 0 1 .9.7L17 12v3.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  drafts: 'M4 16.5V13L13.5 3.5a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L7 16.5zM12 5l3 3',
  sent: 'M3.5 10 16.5 3.5 13 16.5l-3-5.5zM10 11l6.5-7.5',
  archive: 'M3 4.5h14v3H3zM4.5 7.5v8h11v-8M8 11h4',
  junk: 'M10 3.5 17 16H3zM10 8.5v3.5M10 14.2v.1',
  trash: 'M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10',
  folder: 'M3 6V5a1 1 0 0 1 1-1h4l1.5 2H16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  reply: 'M8 5 3.5 9.5 8 14M3.5 9.5H12a4.5 4.5 0 0 1 4.5 4.5v1.5',
  replyAll: 'M10 5 5.5 9.5 10 14M6 5 1.5 9.5 6 14M5.5 9.5H13a4.5 4.5 0 0 1 4.5 4.5v1.5',
  forward: 'M12 5l4.5 4.5L12 14M16.5 9.5H8A4.5 4.5 0 0 0 3.5 14v1.5',
  unread: 'M3 5.5h14v9H3zM3 5.5l7 5.5 7-5.5',
  compose: 'M10 4H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1H15a1 1 0 0 0 1-1V10M8 12l.5-2.5 7-7 2 2-7 7z',
  search: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5 17 17',
  close: 'M5 5l10 10M15 5 5 15',
  back: 'M12 4 6 10l6 6',
  clip: 'M15 9.5 9.6 14.9a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.2 1.2 0 0 1-1.7-1.7L11.5 6',
  keyboard: 'M2.5 5.5h15v9h-15zM5.5 8.5h1M9.5 8.5h1M13.5 8.5h1M6 11.5h8',
  star: 'M10 2.8l2.2 4.6 5 .6-3.7 3.5 1 5L10 14l-4.5 2.5 1-5L2.8 8l5-.6z',
  bold: 'M6 4h5a3 3 0 0 1 0 6H6zM6 10h6a3 3 0 0 1 0 6H6z',
  italic: 'M12 4H8.5M11.5 16H8M11 4 9 16',
  bullets: 'M8 5h9M8 10h9M8 15h9M3.5 5h.1M3.5 10h.1M3.5 15h.1',
  numbers: 'M8 5h9M8 10h9M8 15h9M3 4l1-.5V7M3 9.5h2l-2 2.5h2M3 14h2v3H3M3 15.5h2',
  link: 'M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.8.8M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.8-.8',
  quote: 'M4 6h12M7 10h9M7 14h9M4 9v6',
  clearFormat: 'M6 4h9M10 4 8 16M4 16h6M14 12l4 4M18 12l-4 4',
  file: 'M11 3H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7zM11 3v4h4',
  download: 'M10 3v10M6 9l4 4 4-4M4 16h12',
  clock: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 6v4l2.5 2.5',
  tag: 'M3 10.2V4a1 1 0 0 1 1-1h6.2a1 1 0 0 1 .7.3l6 6a1 1 0 0 1 0 1.4l-6.2 6.2a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1-.3-.7zM7 7h.1',
  lock: 'M5 9h10v8H5zM7 9V6.5a3 3 0 0 1 6 0V9M10 12v2',
  shield: 'M10 2.5 16 5v4.5c0 3.8-2.6 6.6-6 8-3.4-1.4-6-4.2-6-8V5zM7.5 10l2 2 3.5-4',
  settings: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
  check: 'M4 10.5 8 14.5 16 5.5',
  more: 'M10 5h.01M10 10h.01M10 15h.01',
  calendar: 'M3.5 5.5h13v11h-13zM3.5 9h13M7 3.5v3M13 3.5v3',
  next: 'M8 4l6 6-6 6',
  chevron: 'M5 8l5 5 5-5',
  logout: 'M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M13 13.5 16.5 10 13 6.5M16.5 10H8',
  person: 'M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 17a6.5 6.5 0 0 1 13 0',
  templates: 'M4 3.5h12v13H4zM7 7h6M7 10h6M7 13h3',
  mute: 'M4 8v4h3l4 3.5v-11L7 8zM14 8l4 4M18 8l-4 4',
  bell: 'M10 3.5a4.5 4.5 0 0 0-4.5 4.5v3L4 13.5h12L14.5 11V8A4.5 4.5 0 0 0 10 3.5zM8.5 16a1.5 1.5 0 0 0 3 0',
  note: 'M5 3.5h10v13H5zM7.5 7h5M7.5 10h5M7.5 13h3',
  copy: 'M7 7h9.5v9.5H7zM13 7V3.5H3.5V13H7',
  signature: 'M3 13c2-5 4-8 5.5-6.5S6 13 8 13s3-5 5-5-.5 5 2 5h2M3 16.5h14',
  receipt: 'M3 10.5 7 14.5 13 6.5M9.5 14.5l.5.5 7-9',
  print: 'M6 7V3h8v4M6 14H4V8h12v6h-2M6 11h8v6H6z',
  command: 'M7 4.5a2.5 2.5 0 1 0-2.5 2.5H15.5A2.5 2.5 0 1 0 13 4.5v11a2.5 2.5 0 1 0 2.5-2.5H4.5A2.5 2.5 0 1 0 7 15.5z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, filled = false, className }: { name: IconName; size?: number; filled?: boolean; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 20 20" fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export const roleIcon = (role: string | null): IconName =>
  (({ inbox: 'inbox', drafts: 'drafts', sent: 'sent', archive: 'archive', junk: 'junk', trash: 'trash', snoozed: 'clock', starred: 'star', scheduled: 'clock', subscriptions: 'unread', contacts: 'person', calendar: 'calendar', tasks: 'check', notes: 'note' } as const)[role ?? ''] ?? 'folder');
