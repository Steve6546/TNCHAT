import { LoaderCircle } from 'lucide-react';

export function Spinner({ label = 'جارٍ التحميل' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LoaderCircle className="size-4 animate-spin" />
      {label}
    </span>
  );
}
