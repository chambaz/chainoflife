/// Compute one toroidal Conway row. The width is `N * 8` cells.
pub fn compute_next_row<const N: usize>(
    previous: &[u8; N],
    current: &[u8; N],
    next: &[u8; N],
    output: &mut [u8; N],
) -> u32 {
    assert!(N > 0, "a Life row must contain at least one byte");
    compute_next_row_width(previous, current, next, output, N * 8)
}

/// Compute a toroidal row, excluding padding bits beyond `width`.
pub fn compute_next_row_width(
    previous: &[u8],
    current: &[u8],
    next: &[u8],
    output: &mut [u8],
    width: usize,
) -> u32 {
    assert!(width > 0);
    let bytes = width.div_ceil(8);
    assert!(previous.len() >= bytes && current.len() >= bytes && next.len() >= bytes);
    assert!(output.len() >= bytes);
    output.fill(0);
    let mut population = 0;

    for x in 0..width {
        let left = if x == 0 { width - 1 } else { x - 1 };
        let right = if x + 1 == width { 0 } else { x + 1 };
        let neighbors = bit(previous, left)
            + bit(previous, x)
            + bit(previous, right)
            + bit(current, left)
            + bit(current, right)
            + bit(next, left)
            + bit(next, x)
            + bit(next, right);
        let alive = bit(current, x) != 0;
        if neighbors == 3 || (alive && neighbors == 2) {
            output[x / 8] |= 1 << (x % 8);
            population += 1;
        }
    }

    population
}

#[inline]
fn bit(row: &[u8], x: usize) -> u8 {
    (row[x / 8] >> (x % 8)) & 1
}
