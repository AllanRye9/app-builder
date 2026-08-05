export default function BrandMark({ size = 18 }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13 2 4 14h6l-1 8 10-13h-6l0-7Z"
        fill="currentColor"
      />
    </svg>
  );
}
