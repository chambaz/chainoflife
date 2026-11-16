use core::marker::PhantomData;

const DOMAIN: &[u8] = b"chain-of-life/world/v2";

/// Bytes of the world in each digest step and each stored chunk. The last
/// chunk of a world may be shorter.
pub const CHUNK_BYTES: usize = 4_096;
const HEADER_BYTES: usize = DOMAIN.len() + 4 + 4 + 8 + 8;
const STEP_BYTES: usize = 32 + 4 + 4 + 32;

/// A SHA-256 implementation. The contract supplies the host's; every
/// implementation must produce the standard digest.
pub trait Sha256 {
    fn sha256(bytes: &[u8]) -> [u8; 32];
}

/// SHA-256 computed in this crate.
pub struct Software;

impl Sha256 for Software {
    fn sha256(bytes: &[u8]) -> [u8; 32] {
        <sha2::Sha256 as sha2::Digest>::digest(bytes).into()
    }
}

pub struct WorldDigest<H = Software> {
    accumulator: [u8; 32],
    hasher: PhantomData<H>,
}

impl WorldDigest<Software> {
    /// Bind reset identity as well as dimensions and generation to the digest.
    pub fn for_epoch(width: u32, height: u32, epoch: u64, generation: u64) -> Self {
        Self::for_epoch_with(width, height, epoch, generation)
    }

    /// Digest of a complete world: its rows end to end, in chunks of
    /// `CHUNK_BYTES` numbered from zero.
    pub fn of_world(
        width: u32,
        height: u32,
        epoch: u64,
        generation: u64,
        world: &[u8],
    ) -> [u8; 32] {
        let mut digest = Self::for_epoch(width, height, epoch, generation);
        for (key, chunk) in world.chunks(CHUNK_BYTES).enumerate() {
            digest.update(key as u32, chunk);
        }
        digest.finish()
    }
}

impl<H: Sha256> WorldDigest<H> {
    /// [`WorldDigest::for_epoch`] with a chosen SHA-256 implementation.
    pub fn for_epoch_with(width: u32, height: u32, epoch: u64, generation: u64) -> Self {
        let mut header = [0u8; HEADER_BYTES];
        let (domain, fields) = header.split_at_mut(DOMAIN.len());
        domain.copy_from_slice(DOMAIN);
        fields[..4].copy_from_slice(&width.to_be_bytes());
        fields[4..8].copy_from_slice(&height.to_be_bytes());
        fields[8..16].copy_from_slice(&epoch.to_be_bytes());
        fields[16..].copy_from_slice(&generation.to_be_bytes());
        Self {
            accumulator: H::sha256(&header),
            hasher: PhantomData,
        }
    }

    pub fn update(&mut self, chunk_key: u32, bytes: &[u8]) {
        let mut step = [0u8; STEP_BYTES];
        step[..32].copy_from_slice(&self.accumulator);
        step[32..36].copy_from_slice(&chunk_key.to_be_bytes());
        step[36..40].copy_from_slice(&(bytes.len() as u32).to_be_bytes());
        step[40..].copy_from_slice(&H::sha256(bytes));
        self.accumulator = H::sha256(&step);
    }

    pub const fn finish(self) -> [u8; 32] {
        self.accumulator
    }
}
