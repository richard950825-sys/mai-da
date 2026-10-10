export type IconName =
  | 'arrow'
  | 'back'
  | 'close'
  | 'store'
  | 'bike'
  | 'pin'
  | 'target'
  | 'tag'
  | 'taste'
  | 'receipt'
  | 'check'
  | 'info'
  | 'refresh'
  | 'lock'
  | 'plus'
  | 'minus'
  | 'link'
  | 'chevron';
const paths: Record<IconName, React.ReactNode> = {
  arrow: (
    <>
      <path d="M5 12h14m-6-6 6 6-6 6" />
    </>
  ),
  back: <path d="M19 12H5m6-6-6 6 6 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  store: (
    <>
      <path d="M4 9v11h16V9M3 9l2-6h14l2 6M3 9c0 4 4 4 4 0 0 4 5 4 5 0 0 4 5 4 5 0 0 4 4 4 4 0M9 20v-7h6v7" />
    </>
  ),
  bike: (
    <>
      <circle cx="5" cy="17" r="3" />
      <circle cx="19" cy="17" r="3" />
      <path d="m5 17 5-9 5 9H5m5-9h5l4 9M8 5h4m2-1h3l1 4" />
    </>
  ),
  pin: (
    <>
      <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" />
      <circle cx="12" cy="10" r="2" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v3m0 16v3M1 12h3m16 0h3" />
    </>
  ),
  tag: (
    <>
      <path d="M3 3h9l9 9-9 9-9-9V3Z" />
      <circle cx="8" cy="8" r="1" />
    </>
  ),
  taste: (
    <>
      <path d="M5 3v7a3 3 0 0 0 6 0V3M8 3v18M19 3c-4 3-4 8 0 9v9M19 3v9" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2Z" />
      <path d="M9 7h6M9 11h6M9 15h3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 9a8 8 0 1 0 0 6M20 3v6h-6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  link: (
    <>
      <path d="m9 15 6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2M7 11l-2 2a5 5 0 0 0 7 7l2-2" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
};
export function Icon({
  name,
  size = 20,
  ...props
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
