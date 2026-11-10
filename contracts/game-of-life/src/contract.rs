use crate::types::*;
use game_of_life_core::digest::WorldDigest;
use game_of_life_core::kernel::compute_next_row_width;
use game_of_life_core::prng::SplitMix64;
use thruput_sdk::storage::{Bytestring, CapacityConstraint, Flaggable, Map, NNInt, RCQ, Value};
use thruput_sdk::*;

pub const WORLD_WIDTH: u32 = 10_000;
pub const WORLD_HEIGHT: u32 = 10_000;
pub const CELL_COUNT: u64 = 100_000_000;
pub const ROW_BYTES: usize = 1_250;
pub const CHUNK_BYTES: usize = 1_000;
pub const TAIL_BYTES: usize = 250;
pub const CHUNKS_PER_ROW: u32 = 2;
pub const CHUNKS_PER_BANK: u32 = 20_000;

#[thruput_sdk::storage]
pub struct GameOfLife {
    state: Value<WorldState>,
    bank_a: Map<u32, Bytestring>,
    bank_b: Map<u32, Bytestring>,
    requests: RCQ<TickRequest>,
    request_sequence: NNInt,
    queue_slots: CapacityConstraint,
}

#[contract(
    throws = GameOfLifeError,
    emits(WorldInitialized, TickRequested, GenerationAdvanced)
)]
impl GameOfLife {
    pub fn initialize(&mut self, seed: u64, max_queue_len: u32) -> WorldMetadata {
        if self.state.try_get().none_if_missing().is_some() {
            throw(GameOfLifeError::AlreadyInitialized);
        }
        if max_queue_len == 0 {
            throw(GameOfLifeError::InvalidQueueCapacity);
        }
        self.queue_slots.set_capacity(i128::from(max_queue_len));
        self.initialize_world(WORLD_WIDTH, 0, seed, max_queue_len)
    }

    pub fn resize(&mut self, size: u32) -> WorldMetadata {
        if !(100..=WORLD_WIDTH).contains(&size) || !size.is_multiple_of(100) {
            throw(GameOfLifeError::InvalidWorldSize);
        }
        let state = self.require_state();
        // A rejected reset rolls back this attempted consumption too.
        if self.requests.try_consume().none_if_missing().is_some() {
            throw(GameOfLifeError::PendingRequests);
        }
        let epoch = state
            .epoch
            .checked_add(1)
            .unwrap_or_else(|| throw(GameOfLifeError::EpochOverflow));
        self.initialize_world(size, epoch, state.seed, state.max_queue_len)
    }

    pub fn request_tick(&mut self) -> RequestId {
        let state = self.require_state();
        // Serialize admission against a reset, including within the same block.
        self.state.set_exclusive(&state);
        self.queue_slots.consume_capacity(1);
        self.request_sequence.inc(1);
        let request_id = (get_source_transaction_hash(), self.request_sequence.get()).hash();
        let requested_by = get_caller();
        self.requests.insert(&TickRequest {
            epoch: state.epoch,
            request_id,
            requested_by,
        });
        log_event(&TickRequested {
            epoch: state.epoch,
            request_id: &request_id,
            requested_by: &requested_by,
        });
        request_id
    }

    pub fn process_next_tick(&mut self) -> Option<TickResult> {
        let state = self.require_state();
        let request = self.requests.try_consume().none_if_missing()?;
        if request.epoch != state.epoch {
            throw(GameOfLifeError::InvalidStoredState);
        }
        let next_generation = state
            .generation
            .checked_add(1)
            .unwrap_or_else(|| throw(GameOfLifeError::GenerationOverflow));
        let inactive_bank = 1 - state.active_bank;
        let mut previous = [0u8; ROW_BYTES];
        let mut current = [0u8; ROW_BYTES];
        let mut next = [0u8; ROW_BYTES];
        let mut output = [0u8; ROW_BYTES];
        self.read_row(&state, state.size - 1, &mut previous);
        self.read_row(&state, 0, &mut current);
        self.read_row(&state, 1, &mut next);
        let mut population = 0u64;
        let mut digest =
            WorldDigest::for_epoch(state.size, state.size, state.epoch, next_generation);
        for row in 0..state.size {
            population += u64::from(compute_next_row_width(
                &previous,
                &current,
                &next,
                &mut output[..row_bytes(state.size)],
                state.size as usize,
            ));
            self.write_row(inactive_bank, state.size, row, &output, &mut digest);
            if row + 1 < state.size {
                core::mem::swap(&mut previous, &mut current);
                core::mem::swap(&mut current, &mut next);
                self.read_row(&state, (row + 2) % state.size, &mut next);
            }
        }
        let next_state = WorldState {
            generation: next_generation,
            active_bank: inactive_bank,
            population,
            state_digest: SHA256Hash::new(digest.finish()),
            ..state
        };
        self.state.set_exclusive(&next_state);
        self.queue_slots.consume_capacity(-1);
        log_event(&GenerationAdvanced {
            epoch: next_state.epoch,
            request_id: &request.request_id,
            generation: next_generation,
            requested_by: &request.requested_by,
            population,
            state_digest: next_state.state_digest,
        });
        Some(TickResult {
            request_id: request.request_id,
            requested_by: request.requested_by,
            metadata: metadata(&next_state),
        })
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

    pub fn get_cell(&self, x: u32, y: u32) -> bool {
        let state = self.require_state();
        if x >= state.size || y >= state.size {
            throw(GameOfLifeError::CoordinateOutOfBounds);
        }
        let byte = x as usize / 8;
        let chunk = self.get_chunk(y, (byte / CHUNK_BYTES) as u32);
        ((chunk[byte % CHUNK_BYTES] >> (x % 8)) & 1) != 0
    }
}

impl GameOfLife {
    fn initialize_world(
        &mut self,
        size: u32,
        epoch: u64,
        seed: u64,
        max_queue_len: u32,
    ) -> WorldMetadata {
        let mut prng = SplitMix64::new(seed);
        let mut digest = WorldDigest::for_epoch(size, size, epoch, 0);
        let mut population = 0u64;
        let mut bytes = [0u8; ROW_BYTES];
        let length = row_bytes(size);
        for row in 0..size {
            // Keep the existing full-world seed stream: PRNG calls follow chunks.
            for chunk in bytes[..length].chunks_mut(CHUNK_BYTES) {
                prng.fill_bytes(chunk);
            }
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
            size,
            epoch,
            generation: 0,
            active_bank: 0,
            seed,
            population,
            state_digest: SHA256Hash::new(digest.finish()),
            max_queue_len,
        };
        self.state.set_exclusive(&state);
        log_event(&WorldInitialized {
            epoch,
            size,
            seed,
            max_queue_len,
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
        digest: &mut WorldDigest,
    ) {
        for (part, chunk) in bytes[..row_bytes(size)].chunks(CHUNK_BYTES).enumerate() {
            let key = row * chunks_per_row(size) + part as u32;
            match bank {
                0 => self.bank_a.at_mut(&key).set(chunk),
                1 => self.bank_b.at_mut(&key).set(chunk),
                _ => throw(GameOfLifeError::InvalidStoredState),
            }
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
        width: state.size,
        height: state.size,
        generation: state.generation,
        seed: state.seed,
        population: state.population,
        state_digest: state.state_digest,
        chunk_bytes: CHUNK_BYTES as u32,
        chunks_per_row: chunks_per_row(state.size),
        max_queue_len: state.max_queue_len,
    }
}
