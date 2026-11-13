use thruput_sdk::*;

#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug, PartialEq, Eq))]
pub struct WorldState {
    pub resizable: bool,
    pub size: u32,
    pub epoch: u64,
    pub generation: u64,
    pub active_bank: u32,
    pub seed: u64,
    pub population: u64,
    pub state_digest: SHA256Hash,
}

#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug, PartialEq, Eq))]
pub struct WorldMetadata {
    pub epoch: u64,
    pub size: u32,
    pub generation: u64,
    pub seed: u64,
    pub population: u64,
    pub state_digest: SHA256Hash,
    pub resizable: bool,
}

#[contract_exception]
pub enum GameOfLifeError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidWorldSize = 3,
    FixedWorld = 4,
    ChunkOutOfBounds = 5,
    GenerationOverflow = 6,
    EpochOverflow = 7,
    InvalidStoredState = 8,
}

#[derive(Event, Clone, Debug)]
pub struct WorldInitialized {
    pub epoch: u64,
    pub size: u32,
    pub seed: u64,
    pub population: u64,
    pub state_digest: SHA256Hash,
}

#[derive(Event, Clone, Debug)]
pub struct GenerationAdvanced<'a> {
    #[topic]
    pub advanced_by: &'a ContractAddress,
    pub epoch: u64,
    pub generation: u64,
    pub population: u64,
    pub state_digest: SHA256Hash,
}
