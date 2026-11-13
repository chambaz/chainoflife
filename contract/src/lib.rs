#![cfg_attr(not(feature = "dev"), no_std)]

thruput_sdk::declare_mock_contract!();

mod contract;
mod types;

pub use contract::{GameOfLife, GameOfLifeClient};
pub use types::*;
