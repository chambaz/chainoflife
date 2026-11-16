//! Bit-sliced toroidal Conway kernel.
//!
//! Rows are LSB-first bit strings. The kernel evaluates 32 cells per step:
//! it adds the three rows of each column with carry-save logic, then adds the
//! left, centre, and right column sums. No step depends on a cell's value, so
//! the work per row depends only on its width.

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
    let (previous, current, next) = (&previous[..bytes], &current[..bytes], &next[..bytes]);
    let (output, unused) = output.split_at_mut(bytes);
    unused.fill(0);

    // The last word holds `last_bits` cells and may be shorter than four bytes.
    let words = width.div_ceil(32);
    let last_at = (words - 1) * 4;
    let last_bits = width - (words - 1) * 32;
    let last_mask = u32::MAX >> (32 - last_bits);
    let last = Columns::new(
        partial_word(&previous[last_at..]) & last_mask,
        partial_word(&current[last_at..]) & last_mask,
        partial_word(&next[last_at..]) & last_mask,
    );
    let previous = previous.as_chunks::<4>().0;
    let current = current.as_chunks::<4>().0;
    let next = next.as_chunks::<4>().0;
    let columns = if words == 1 {
        last
    } else {
        Columns::load(&previous[0], &current[0], &next[0])
    };
    let first = columns;

    // The cell left of the row's first cell is its last cell.
    let mut state = State {
        columns,
        carry_low: (last.with_low >> (last_bits - 1)) & 1,
        carry_high: (last.with_high >> (last_bits - 1)) & 1,
        population: 0,
    };
    let output_words = output.as_chunks_mut::<4>().0;
    if words > 1 {
        // Each of these words has a complete word to its right.
        let inner = 1..words - 1;
        state.advance_words(
            &previous[inner.clone()],
            &current[inner.clone()],
            &next[inner],
            &mut output_words[..words - 2],
        );
        output_words[words - 2] = state.advance(&last).to_le_bytes();
    }

    // The cell right of the row's last cell is its first cell.
    let alive = last.next_cells(
        state.carry_low,
        state.carry_high,
        &first,
        last_bits as u32 - 1,
    ) & last_mask;
    let tail = &mut output[last_at..];
    tail.copy_from_slice(&alive.to_le_bytes()[..tail.len()]);
    state.population + alive.count_ones()
}

/// Progress along a row: the word to evaluate and the column left of it.
struct State {
    columns: Columns,
    carry_low: u32,
    carry_high: u32,
    population: u32,
}

impl State {
    /// Evaluate the pending word, whose right neighbor is `right`.
    #[inline(always)]
    fn advance(&mut self, right: &Columns) -> u32 {
        let alive = self
            .columns
            .next_cells(self.carry_low, self.carry_high, right, 31);
        self.population += alive.count_ones();
        self.carry_low = self.columns.with_low >> 31;
        self.carry_high = self.columns.with_high >> 31;
        self.columns = *right;
        alive
    }

    /// Evaluate one word per input word. The inputs are the words to the
    /// right of those evaluated. Kept out of line so that the loop has the
    /// whole register file: a wide load costs three times a register move.
    #[inline(never)]
    fn advance_words(
        &mut self,
        previous: &[[u8; 4]],
        current: &[[u8; 4]],
        next: &[[u8; 4]],
        output: &mut [[u8; 4]],
    ) {
        let mut state = State { ..*self };
        for (((previous, current), next), output) in
            previous.iter().zip(current).zip(next).zip(output)
        {
            *output = state
                .advance(&Columns::load(previous, current, next))
                .to_le_bytes();
        }
        *self = state;
    }
}

/// Per-column sums of three vertically adjacent words, as two-bit numbers.
#[derive(Clone, Copy)]
struct Columns {
    cells: u32,
    /// Rows above and below, without the centre row.
    without_low: u32,
    without_high: u32,
    /// All three rows.
    with_low: u32,
    with_high: u32,
}

impl Columns {
    #[inline(always)]
    fn new(previous: u32, cells: u32, next: u32) -> Self {
        let without_low = previous ^ next;
        let without_high = previous & next;
        Self {
            cells,
            without_low,
            without_high,
            with_low: without_low ^ cells,
            with_high: without_high | (without_low & cells),
        }
    }

    #[inline(always)]
    fn load(previous: &[u8; 4], current: &[u8; 4], next: &[u8; 4]) -> Self {
        Self::new(
            u32::from_le_bytes(*previous),
            u32::from_le_bytes(*current),
            u32::from_le_bytes(*next),
        )
    }

    /// Next state of this word's cells. `carry_*` is the three-row sum of the
    /// column left of bit zero. Bit zero of `right` is the column right of
    /// bit `top`, the word's last cell.
    #[inline(always)]
    fn next_cells(&self, carry_low: u32, carry_high: u32, right: &Self, top: u32) -> u32 {
        let left_low = (self.with_low << 1) | carry_low;
        let left_high = (self.with_high << 1) | carry_high;
        let right_low = (self.with_low >> 1) | ((right.with_low & 1) << top);
        let right_high = (self.with_high >> 1) | ((right.with_high & 1) << top);

        // neighbors = ones + 2 * (number of set twos), where the twos are
        // `left_high`, `without_high`, `right_high`, and `carry`.
        let partial = left_low ^ self.without_low;
        let ones = partial ^ right_low;
        let carry = (left_low & self.without_low) | (partial & right_low);
        let left_pair = left_high ^ self.without_high;
        let right_pair = right_high ^ carry;
        let two_or_more = (left_high & self.without_high) | (right_high & carry);
        // An odd number of twos that has no pair set is exactly one: two or
        // three neighbors. Three always lives; two keeps a live cell alive.
        (left_pair ^ right_pair) & !two_or_more & (ones | self.cells)
    }
}

/// Little-endian word from the first four bytes, or fewer at the end of a row.
#[inline]
fn partial_word(bytes: &[u8]) -> u32 {
    let mut word = [0u8; 4];
    let length = bytes.len().min(4);
    word[..length].copy_from_slice(&bytes[..length]);
    u32::from_le_bytes(word)
}
