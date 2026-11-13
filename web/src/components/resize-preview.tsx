export function ResizePreview({
  currentSize,
  proposedSize,
}: {
  readonly currentSize: number;
  readonly proposedSize: number;
}) {
  const extent = Math.max(currentSize, proposedSize);
  const dimensions = (size: number) =>
    `${size.toLocaleString()} × ${size.toLocaleString()}`;
  return (
    <figure
      aria-label={`Size comparison: ${dimensions(currentSize)} to ${dimensions(proposedSize)}`}
      className="pointer-events-none absolute top-28 right-3 z-20 grid w-48 gap-2 rounded-md border border-border bg-panel/95 p-3 text-base tabular-nums sm:top-3 sm:text-sm"
    >
      <figcaption className="font-medium">Size preview</figcaption>
      <div className="relative aspect-square" aria-hidden="true">
        <div
          data-testid="current-size-outline"
          className="absolute top-0 left-0 min-h-1 min-w-1 border-2 border-muted-foreground bg-muted/30"
          style={{
            width: `${(currentSize / extent) * 100}%`,
            height: `${(currentSize / extent) * 100}%`,
          }}
        />
        <div
          data-testid="proposed-size-outline"
          className="absolute top-0 left-0 min-h-1 min-w-1 border-2 border-dashed border-primary bg-primary/10 outline outline-background"
          style={{
            width: `${(proposedSize / extent) * 100}%`,
            height: `${(proposedSize / extent) * 100}%`,
          }}
        />
      </div>
      <div className="grid gap-1">
        <p className="text-muted-foreground">Now {dimensions(currentSize)}</p>
        <p className="text-primary">New {dimensions(proposedSize)}</p>
      </div>
    </figure>
  );
}
