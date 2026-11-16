use crate::types::*;
use game_of_life_core::digest::{CHUNK_BYTES, Sha256, WorldDigest};
use game_of_life_core::kernel::{compute_next_row_width, count_cells};
use game_of_life_core::prng::SplitMix64;
use thruput_sdk::storage::{Bytestring, Flaggable, Map, Value};
use thruput_sdk::*;

const MAX_SIZE: u32 = 10_000;
const ROW_BYTES: usize = 1_250;
/// Most bytes of a row that `get_chunk` returns: a view's return value is
/// limited to 1,024 bytes.
const PART_BYTES: usize = 1_000;

/// SHA-256 computed by the host, which costs far less gas than hashing in
/// the guest.
struct HostSha256;

impl Sha256 for HostSha256 {
    fn sha256(bytes: &[u8]) -> [u8; 32] {
        crypto::sha256(bytes).into_inner()
    }
}

type Digest = WorldDigest<HostSha256>;
type Bank = Map<u32, Bytestring>;

#[thruput_sdk::storage]
pub struct GameOfLife {
    state: Value<WorldState>,
    bank_a: Bank,
    bank_b: Bank,
}

#[contract(throws = GameOfLifeError, emits(WorldInitialized, GenerationAdvanced))]
impl GameOfLife {
    pub fn initialize(&mut self, seed: u64, size: u32, resizable: bool) -> WorldMetadata {
        if self.state.try_get().none_if_missing().is_some() {
            throw(GameOfLifeError::AlreadyInitialized);
        }
        self.initialize_world(size, 0, seed, resizable)
    }

    /// Resets the world at a new size and epoch, keeping its seed.
    pub fn resize(&mut self, size: u32) -> WorldMetadata {
        let state = self.require_state();
        if !state.resizable {
            throw(GameOfLifeError::FixedWorld);
        }
        let epoch = state
            .epoch
            .checked_add(1)
            .unwrap_or_else(|| throw(GameOfLifeError::EpochOverflow));
        self.initialize_world(size, epoch, state.seed, true)
    }

    /// Computes and stores the next generation of the complete world. All
    /// writes commit together or roll back together. The exclusive state lock
    /// lets only one concurrent advance from the same generation commit.
    pub fn advance(&mut self) -> WorldMetadata {
        let state = self.require_state();
        let generation = state
            .generation
            .checked_add(1)
            .unwrap_or_else(|| throw(GameOfLifeError::GenerationOverflow));
        let target_bank = 1 - state.active_bank;
        let width = row_bytes(state.size);
        let (source, target) = self.banks(state.active_bank);
        let mut window = Window::new(source, state.size);
        let mut writer = Writer::new(
            target,
            Digest::for_epoch_with(state.size, state.size, state.epoch, generation),
        );
        // The world wraps: the first and last rows are also each other's
        // neighbors, at the far end of the pass.
        let mut first = [0u8; ROW_BYTES];
        let mut last = [0u8; ROW_BYTES];
        window.copy_row(state.size - 1, &mut last[..width]);
        window.copy_row(0, &mut first[..width]);
        window.load_row(0);
        let mut population = 0u64;
        for row in 0..state.size {
            if row + 1 < state.size {
                window.load_row(row + 1);
            }
            let previous = if row == 0 {
                &last[..width]
            } else {
                window.row(row - 1)
            };
            let next = if row + 1 == state.size {
                &first[..width]
            } else {
                window.row(row + 1)
            };
            population += u64::from(compute_next_row_width(
                previous,
                window.row(row),
                next,
                writer.row(width),
                state.size as usize,
            ));
            writer.commit(width);
        }
        let state_digest = SHA256Hash::new(writer.finish());
        let next_state = WorldState {
            generation,
            active_bank: target_bank,
            population,
            state_digest,
            ..state
        };
        self.state.set_exclusive(&next_state);
        log_event(&GenerationAdvanced {
            advanced_by: &get_caller(),
            epoch: next_state.epoch,
            generation,
            population,
            state_digest: next_state.state_digest,
        });
        metadata(&next_state)
    }

    pub fn get_metadata(&self) -> WorldMetadata {
        metadata(&self.require_state())
    }

    /// Returns part of one row of the active bank: up to 1,000 bytes, padded
    /// with zeros.
    pub fn get_chunk(&self, row: u32, part: u32) -> [u8; PART_BYTES] {
        let state = self.require_state();
        let width = row_bytes(state.size);
        let start = part as usize * PART_BYTES;
        if row >= state.size || start >= width {
            throw(GameOfLifeError::ChunkOutOfBounds);
        }
        let mut output = [0u8; PART_BYTES];
        let length = (width - start).min(PART_BYTES);
        Window::new(self.bank(state.active_bank), state.size)
            .copy(row as usize * width + start, &mut output[..length]);
        output
    }
}

impl GameOfLife {
    fn initialize_world(
        &mut self,
        size: u32,
        epoch: u64,
        seed: u64,
        resizable: bool,
    ) -> WorldMetadata {
        if !(100..=MAX_SIZE).contains(&size) || !size.is_multiple_of(100) {
            throw(GameOfLifeError::InvalidWorldSize);
        }
        let mut prng = SplitMix64::new(seed);
        let mut writer = Writer::new(
            &mut self.bank_a,
            Digest::for_epoch_with(size, size, epoch, 0),
        );
        let mut population = 0u64;
        let length = row_bytes(size);
        for _ in 0..size {
            let bytes = writer.row(length);
            prng.fill_bytes(bytes);
            if !size.is_multiple_of(8) {
                bytes[length - 1] &= (1 << (size % 8)) - 1;
            }
            population += u64::from(count_cells(bytes));
            writer.commit(length);
        }
        let state_digest = SHA256Hash::new(writer.finish());
        let state = WorldState {
            resizable,
            size,
            epoch,
            generation: 0,
            active_bank: 0,
            seed,
            population,
            state_digest,
        };
        self.state.set_exclusive(&state);
        log_event(&WorldInitialized {
            epoch,
            size,
            seed,
            population,
            state_digest: state.state_digest,
        });
        metadata(&state)
    }

    fn require_state(&self) -> WorldState {
        self.state
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(GameOfLifeError::NotInitialized))
    }

    fn bank(&self, bank: u32) -> &Bank {
        match bank {
            0 => &self.bank_a,
            1 => &self.bank_b,
            _ => throw(GameOfLifeError::InvalidStoredState),
        }
    }

    /// The active bank to read and the other bank to write.
    fn banks(&mut self, active: u32) -> (&Bank, &mut Bank) {
        match active {
            0 => (&self.bank_a, &mut self.bank_b),
            1 => (&self.bank_b, &mut self.bank_a),
            _ => throw(GameOfLifeError::InvalidStoredState),
        }
    }
}

/// Chunks of the world that a [`Window`] holds at once.
const WINDOW_CHUNKS: usize = 3;
const WINDOW_BYTES: usize = WINDOW_CHUNKS * CHUNK_BYTES;
// Three adjacent rows span no more chunks than the window holds, and at most
// one of them crosses its end.
const _: () = assert!(3 * ROW_BYTES <= (WINDOW_CHUNKS - 1) * CHUNK_BYTES);
const _: () = assert!(4 * ROW_BYTES <= WINDOW_BYTES);

/// Reads a bank's world: its rows end to end, stored as chunks of
/// `CHUNK_BYTES`.
///
/// Chunks are read straight into a ring of slots, so that most rows can be
/// used where they lie instead of being copied. Loading rows in order reads
/// each chunk once.
struct Window<'a> {
    bank: &'a Bank,
    world_bytes: usize,
    row_bytes: usize,
    ring: [u8; WINDOW_BYTES],
    /// The chunk held in each slot of the ring.
    slots: [Option<usize>; WINDOW_CHUNKS],
    /// A copy of the row that crosses the end of the ring, if one is loaded.
    crossing: [u8; ROW_BYTES],
    crossing_row: Option<u32>,
}

impl<'a> Window<'a> {
    fn new(bank: &'a Bank, size: u32) -> Self {
        Self {
            bank,
            world_bytes: size as usize * row_bytes(size),
            row_bytes: row_bytes(size),
            ring: [0; WINDOW_BYTES],
            slots: [None; WINDOW_CHUNKS],
            crossing: [0; ROW_BYTES],
            crossing_row: None,
        }
    }

    /// Makes `row` available to [`Window::row`]. It stays available while
    /// the rows loaded after it reach no further than two rows ahead.
    fn load_row(&mut self, row: u32) {
        let offset = row as usize * self.row_bytes;
        let end = offset + self.row_bytes;
        for chunk in offset / CHUNK_BYTES..=(end - 1) / CHUNK_BYTES {
            self.load_chunk(chunk);
        }
        let start = offset % WINDOW_BYTES;
        if start + self.row_bytes > WINDOW_BYTES {
            let (head, tail) = self.crossing[..self.row_bytes].split_at_mut(WINDOW_BYTES - start);
            head.copy_from_slice(&self.ring[start..]);
            tail.copy_from_slice(&self.ring[..tail.len()]);
            self.crossing_row = Some(row);
        }
    }

    /// A row made available by [`Window::load_row`].
    fn row(&self, row: u32) -> &[u8] {
        if self.crossing_row == Some(row) {
            return &self.crossing[..self.row_bytes];
        }
        let start = row as usize * self.row_bytes % WINDOW_BYTES;
        &self.ring[start..start + self.row_bytes]
    }

    fn copy_row(&mut self, row: u32, output: &mut [u8]) {
        self.copy(row as usize * self.row_bytes, output);
    }

    /// Copies world bytes from `offset`. The range must lie within the world.
    fn copy(&mut self, mut offset: usize, mut output: &mut [u8]) {
        while !output.is_empty() {
            let chunk = offset / CHUNK_BYTES;
            let start = offset % CHUNK_BYTES;
            let (head, rest) = output.split_at_mut((CHUNK_BYTES - start).min(output.len()));
            let slot = self.load_chunk(chunk) + start;
            head.copy_from_slice(&self.ring[slot..slot + head.len()]);
            offset += head.len();
            output = rest;
        }
    }

    /// Reads a chunk into its slot unless it is there. Returns where it starts.
    fn load_chunk(&mut self, chunk: usize) -> usize {
        let slot = chunk % WINDOW_CHUNKS;
        let start = slot * CHUNK_BYTES;
        if self.slots[slot] != Some(chunk) {
            let length = (self.world_bytes - chunk * CHUNK_BYTES).min(CHUNK_BYTES);
            read_bytes(
                &self.bank.at(&(chunk as u32)),
                &mut self.ring[start..start + length],
            );
            self.slots[slot] = Some(chunk);
        }
        start
    }
}

/// Writes a world to a bank row by row, and digests the chunks it stores.
/// Rows are produced in the buffer that the chunks are stored from.
struct Writer<'a> {
    bank: &'a mut Bank,
    digest: Digest,
    /// Fewer than `CHUNK_BYTES` pending bytes, then room for one more row.
    buffer: [u8; CHUNK_BYTES + ROW_BYTES],
    filled: usize,
    index: u32,
}

impl<'a> Writer<'a> {
    fn new(bank: &'a mut Bank, digest: Digest) -> Self {
        Self {
            bank,
            digest,
            buffer: [0; CHUNK_BYTES + ROW_BYTES],
            filled: 0,
            index: 0,
        }
    }

    /// Space for the next row, to fill before [`Writer::commit`].
    fn row(&mut self, length: usize) -> &mut [u8] {
        &mut self.buffer[self.filled..self.filled + length]
    }

    /// Appends the row written to [`Writer::row`].
    fn commit(&mut self, length: usize) {
        self.filled += length;
        if self.filled >= CHUNK_BYTES {
            self.store(CHUNK_BYTES);
            self.buffer.copy_within(CHUNK_BYTES..self.filled, 0);
            self.filled -= CHUNK_BYTES;
        }
    }

    /// Stores the last, shorter chunk and returns the world digest.
    fn finish(mut self) -> [u8; 32] {
        if self.filled > 0 {
            self.store(self.filled);
        }
        self.digest.finish()
    }

    fn store(&mut self, length: usize) {
        let chunk = &self.buffer[..length];
        self.bank.at_mut(&self.index).set(chunk);
        self.digest.update(self.index, chunk);
        self.index += 1;
    }
}

fn row_bytes(size: u32) -> usize {
    (size as usize).div_ceil(8)
}

// The public syscall reads variable-length chunks into bounded stack storage.
fn read_bytes(value: &Bytestring, output: &mut [u8]) {
    let mut length = 0;
    sys::raw_BytestringGet(value.storage_key(), output, &mut length)
        .unwrap_or_else(|_| throw(GameOfLifeError::InvalidStoredState));
    if length as usize != output.len() {
        throw(GameOfLifeError::InvalidStoredState);
    }
}

fn metadata(state: &WorldState) -> WorldMetadata {
    WorldMetadata {
        epoch: state.epoch,
        size: state.size,
        generation: state.generation,
        seed: state.seed,
        population: state.population,
        state_digest: state.state_digest,
        resizable: state.resizable,
    }
}
