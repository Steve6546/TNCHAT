import { Blocks } from 'lucide-react';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-8 items-center justify-center rounded-md border border-border bg-foreground text-background">
        <Blocks className="size-4" />
      </span>
      {!compact ? (
        <div className="leading-tight">
          <div className="text-sm font-medium">مركز الأوامر</div>
          <div className="text-[11px] text-muted-foreground">بوابة النماذج</div>
        </div>
      ) : null}
    </div>
  );
}
