import { expect, test } from "@playwright/test";

test("resizes the live world, advances each workload, and shares state across tabs", async ({
  page,
  context,
}) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const slider = page.getByRole("slider", { name: "Board size" });
  await expect(slider).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByText(/Ready · generation/)).toBeVisible({
    timeout: 120_000,
  });
  const address = await page.getByLabel("Your wallet").getAttribute("title");
  // The largest world still fits a stock node's 16 MiB storage output.
  await expect(slider).toHaveAttribute("max", "11400");
  const originalSize = Number(await slider.inputValue());
  async function setSize(size: number) {
    // A key release commits once; intermediate range inputs only preview.
    await slider.focus();
    await slider.evaluate((element, size) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, String(size));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, size);
    await expect(
      page.getByLabel(`Preview: ${size} by ${size} cells`),
    ).toBeVisible();
    await page.keyboard.up("ArrowRight");
    await expect(
      page.getByLabel(
        `Pan and zoom the ${size.toLocaleString()} by ${size.toLocaleString()} cell world`,
      ),
    ).toBeVisible({ timeout: 180_000 });
    await expect(
      page.getByText("Ready · generation 0", { exact: true }),
    ).toBeVisible({ timeout: 180_000 });
    await expect(slider).toBeEnabled();
  }
  if ((await slider.inputValue()) === "100") await setSize(200);
  for (const size of [100, 1_000, 11_400, 100]) {
    await setSize(size);
    await page
      .getByRole("button", {
        name: `Advance ${(size * size).toLocaleString()} cells`,
      })
      .click();
    await expect(
      page.getByText("Ready · generation 1", { exact: true }),
    ).toBeVisible({ timeout: 180_000 });
    const activity = page.locator("details").filter({
      has: page.locator("summary").filter({ hasText: /^Activity$/ }),
    });
    if (
      !(await activity.evaluate(
        (element) => (element as HTMLDetailsElement).open,
      ))
    )
      await activity.locator("summary").click();
    await expect(
      activity
        .getByRole("button", {
          name: /Copy transaction hash for generation 1, epoch/,
        })
        .first(),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/live/resize-${size}.png` });
  }
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByLabel("Your wallet")).toHaveAttribute(
    "title",
    address!,
    { timeout: 30_000 },
  );
  await expect(other.getByRole("slider", { name: "Board size" })).toHaveValue(
    "100",
    { timeout: 30_000 },
  );
  await page.reload();
  await expect(page.getByRole("slider", { name: "Board size" })).toHaveValue(
    "100",
    { timeout: 30_000 },
  );
  await expect(
    page.getByText("Ready · generation 1", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await other.close();
  // Leave the shared world at its original size for later live checks.
  if (originalSize !== 100) await setSize(originalSize);
  expect(errors).toEqual([]);
});
