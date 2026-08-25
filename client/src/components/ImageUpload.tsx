import * as React from 'react';
import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { http } from '@/api/client';
import { ApiError } from '@/api/client';
import { cn } from '@/lib/utils';

interface ImageUploadProps {
  /** Current image URL, or null when none is set. */
  value: string | null;
  onChange: (url: string | null) => void;
  /** "image" for product photos, "logo" for store branding. */
  variant?: 'image' | 'logo';
  disabled?: boolean;
  className?: string;
  label?: string;
  hint?: string;
}

const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

/**
 * Optional image picker used for both product photos and the receipt logo.
 *
 * Uploads go through the existing `/uploads` endpoints, which sit on the
 * StorageProvider abstraction - so switching to S3 later changes nothing here.
 * An absent image is a first-class state: `null` is returned, and every consumer
 * renders a placeholder rather than breaking.
 */
export function ImageUpload({
  value,
  onChange,
  variant = 'image',
  disabled,
  className,
  label = 'Image',
  hint = 'Optional. JPEG, PNG, WebP or AVIF, up to 4 MB.',
}: ImageUploadProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);

  const handleFile = async (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      toast.error('Unsupported file type', { description: 'Use JPEG, PNG, WebP or AVIF.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('That image is too large', { description: 'Maximum size is 4 MB.' });
      return;
    }

    const form = new FormData();
    form.append('file', file);

    setUploading(true);
    try {
      const endpoint = variant === 'logo' ? '/uploads/logo' : '/uploads/image';
      const res = await http.post<{ success: true; data: { url: string } }>(endpoint, form);
      onChange(res.data.data.url);
      toast.success('Image uploaded');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        {value && !disabled && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(null)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted',
            variant === 'logo' ? 'h-16 w-28' : 'h-20 w-20',
          )}
        >
          {value ? (
            <img src={value} alt="" className="h-full w-full object-contain" />
          ) : (
            <ImagePlus className="h-6 w-6 text-muted-foreground/50" />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            {value ? 'Replace' : 'Upload'}
          </Button>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(',')}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
    </div>
  );
}
