import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ResizePreview } from "./resize-preview";

test.each([
  [2200, 500],
  [1000, 2200],
  [10000, 100],
  [100, 10000],
])(
  "keeps both size outlines inside the comparison when resizing %i to %i",
  (currentSize, proposedSize) => {
    render(
      <ResizePreview currentSize={currentSize} proposedSize={proposedSize} />,
    );
    const current = screen.getByTestId("current-size-outline");
    const proposed = screen.getByTestId("proposed-size-outline");
    for (const outline of [current, proposed]) {
      expect(parseFloat(outline.style.width)).toBeGreaterThan(0);
      expect(parseFloat(outline.style.width)).toBeLessThanOrEqual(100);
    }
    expect(
      parseFloat(proposed.style.width) / parseFloat(current.style.width),
    ).toBeCloseTo(proposedSize / currentSize);
  },
);
