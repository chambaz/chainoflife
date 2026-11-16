use crate::types::*;
use game_of_life_core::digest::{Sha256, WorldDigest};
use game_of_life_core::kernel::compute_next_row_width;
use game_of_life_core::prng::SplitMix64;
use thruput_sdk::storage::{Bytestring, Flaggable, Map, Value};
use thruput_sdk::*;

const MAX_SIZE: u32 = 10_000;
const ROW_BYTES: usize = 1_250;
const CHUNK_BYTES: usize = 1_000;

/// SHA-256 computed by the host, which costs far less gas than hashing in
/// the guest.
struct HostSha256;

impl Sha256 for HostSha256 {
    fn sha256(bytes: &[u8]) -> [u8; 32] {
        crypto::sha256(bytes).into_inner()
    }
}

type Digest = WorldDigest<HostSha256>;

#[thruput_sdk::storage]
pub struct GameOfLife {
    state: Value<WorldState>,
    bank_a: Map<u32, Bytestring>,
    bank_b: Map<u32, Bytestring>,
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
        // A three-row window. Rotating the slots avoids copying the rows.
        let mut rows = [[0u8; ROW_BYTES]; 3];
        let (mut previous, mut current, mut next) = (0, 1, 2);
        let mut output = [0u8; ROW_BYTES];
        self.read_row(&state, state.size - 1, &mut rows[previous]);
        self.read_row(&state, 0, &mut rows[current]);
        self.read_row(&state, 1, &mut rows[next]);
        let mut population = 0u64;
        let mut digest = Digest::for_epoch_with(state.size, state.size, state.epoch, generation);
        for row in 0..state.size {
            population += u64::from(compute_next_row_width(
                &rows[previous],
                &rows[current],
                &rows[next],
                &mut output[..width],
                state.size as usize,
            ));
            self.write_row(target_bank, state.size, row, &output, &mut digest);
            if row + 1 < state.size {
                (previous, current, next) = (current, next, previous);
                self.read_row(&state, (row + 2) % state.size, &mut rows[next]);
            }
        }
        let next_state = WorldState {
            generation,
            active_bank: target_bank,
            population,
            state_digest: SHA256Hash::new(digest.finish()),
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

    pub fn get_chunk(&self, row: u32, part: u32) -> [u8; CHUNK_BYTES] {
        let state = self.require_state();
        if row >= state.size || part >= chunks_per_row(state.size) {
            throw(GameOfLifeError::ChunkOutOfBounds);
        }
        let mut output = [0u8; CHUNK_BYTES];
        let length = (row_bytes(state.size) - part as usize * CHUNK_BYTES).min(CHUNK_BYTES);
        read_bytes(
            &self
                .bank(state.active_bank)
                .at(&(row * chunks_per_row(state.size) + part)),
            &mut output[..length],
        );
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
        let mut digest = Digest::for_epoch_with(size, size, epoch, 0);
        let mut population = 0u64;
        let mut bytes = [0u8; ROW_BYTES];
        let length = row_bytes(size);
        for row in 0..size {
            prng.fill_bytes(&mut bytes[..length]);
            if !size.is_multiple_of(8) {
                bytes[length - 1] &= (1 << (size % 8)) - 1;
            }
            population += bytes[..length]
                .iter()
                .map(|byte| u64::from(byte.count_ones()))
                .sum::<u64>();
            self.write_row(0, size, row, &bytes, &mut digest);
        }
        let state = WorldState {
            resizable,
            size,
            epoch,
            generation: 0,
            active_bank: 0,
            seed,
            population,
            state_digest: SHA256Hash::new(digest.finish()),
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

    fn bank(&self, bank: u32) -> &Map<u32, Bytestring> {
        match bank {
            0 => &self.bank_a,
            1 => &self.bank_b,
            _ => throw(GameOfLifeError::InvalidStoredState),
        }
    }

    fn read_row(&self, state: &WorldState, row: u32, output: &mut [u8; ROW_BYTES]) {
        for (part, chunk) in output[..row_bytes(state.size)]
            .chunks_mut(CHUNK_BYTES)
            .enumerate()
        {
            let key = row * chunks_per_row(state.size) + part as u32;
            read_bytes(&self.bank(state.active_bank).at(&key), chunk);
        }
    }

    fn write_row(
        &mut self,
        bank: u32,
        size: u32,
        row: u32,
        bytes: &[u8; ROW_BYTES],
        digest: &mut Digest,
    ) {
        let target = match bank {
            0 => &mut self.bank_a,
            1 => &mut self.bank_b,
            _ => throw(GameOfLifeError::InvalidStoredState),
        };
        for (part, chunk) in bytes[..row_bytes(size)].chunks(CHUNK_BYTES).enumerate() {
            let key = row * chunks_per_row(size) + part as u32;
            target.at_mut(&key).set(chunk);
            digest.update(key, chunk);
        }
    }
}

fn row_bytes(size: u32) -> usize {
    (size as usize).div_ceil(8)
}

fn chunks_per_row(size: u32) -> u32 {
    row_bytes(size).div_ceil(CHUNK_BYTES) as u32
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
