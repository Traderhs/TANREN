export function EntryEditButton({ onClick, disabled = false, label = "표현 편집" }: { onClick: () => void; disabled?: boolean; label?: string }) {
  return <button type="button" className="book-inline-entry-settings" onClick={onClick} disabled={disabled} aria-label={label} title="표현 편집">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4.2L19 9.2a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8V20Z" />
      <path d="m13.8 6 4.2 4.2" />
    </svg>
  </button>;
}
