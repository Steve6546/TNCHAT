import { AlertCircle, RotateCw } from 'lucide-react';

import { Button } from '../ui/button';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-border bg-card px-6 text-center">
      <AlertCircle className="mb-3 size-6 text-red-500" />
      <h3 className="text-sm font-medium">تعذّر تحميل البيانات</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button variant="outline" className="mt-4" onClick={onRetry}>
          <RotateCw />
          إعادة المحاولة
        </Button>
      ) : null}
    </div>
  );
}
