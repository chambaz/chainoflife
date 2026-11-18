use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{DENSITY_ENCODING, Error, MAX_WORLD_WIDTH, MAX_ZOOM, Result, TILE_SIZE};

/// Version of the published JSON documents.
pub const SCHEMA_VERSION: u8 = 2;
const TILE_TEMPLATE: &str = "tiles/{z}/{x}/{y}.bin";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verification {
    pub canonical_download_verified: bool,
    pub individual_tile_proofs: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeManifest {
    pub epoch: String,
    pub schema_version: u8,
    pub network_id: String,
    pub contract_address: String,
    pub generation: String,
    pub seed: String,
    pub width: u32,
    pub height: u32,
    pub population: String,
    pub state_digest: String,
    pub tile_size: u32,
    pub max_zoom: u8,
    pub density_encoding: String,
    pub cell_encoding: String,
    pub tile_path_template: String,
    pub verification: Verification,
}

impl LifeManifest {
    pub fn new(identity: &SnapshotIdentity) -> Self {
        Self {
            epoch: identity.epoch.to_string(),
            schema_version: SCHEMA_VERSION,
            network_id: identity.network_id.clone(),
            contract_address: identity.contract_address.clone(),
            generation: identity.generation.to_string(),
            seed: identity.seed.to_string(),
            width: identity.width,
            height: identity.height,
            population: identity.population.to_string(),
            state_digest: hex32(&identity.state_digest),
            tile_size: TILE_SIZE,
            max_zoom: MAX_ZOOM,
            density_encoding: DENSITY_ENCODING.into(),
            cell_encoding: "row-major-lsb-first".into(),
            tile_path_template: TILE_TEMPLATE.into(),
            verification: Verification {
                canonical_download_verified: true,
                individual_tile_proofs: false,
            },
        }
    }

    pub fn validate(&self) -> Result<()> {
        parse_u64("epoch", &self.epoch)?;
        require(
            self.schema_version == SCHEMA_VERSION,
            "schemaVersion",
            "must be 2",
        )?;
        validate_network_id(&self.network_id)?;
        validate_hex32("contractAddress", &self.contract_address)?;
        parse_u64("generation", &self.generation)?;
        parse_u64("seed", &self.seed)?;
        validate_hex32("stateDigest", &self.state_digest)?;
        require(
            (100..=MAX_WORLD_WIDTH).contains(&self.width) && self.width.is_multiple_of(100),
            "width",
            "unsupported width",
        )?;
        require(self.height == self.width, "height", "world must be square")?;
        require(
            parse_u64("population", &self.population)?
                <= u64::from(self.width) * u64::from(self.height),
            "population",
            "exceeds dimensions",
        )?;
        require(
            self.tile_size == TILE_SIZE,
            "tileSize",
            "unsupported tile size",
        )?;
        require(
            self.max_zoom == MAX_ZOOM,
            "maxZoom",
            "unsupported maximum zoom",
        )?;
        require(
            self.density_encoding == DENSITY_ENCODING,
            "densityEncoding",
            "unsupported encoding",
        )?;
        require(
            self.cell_encoding == "row-major-lsb-first",
            "cellEncoding",
            "unsupported encoding",
        )?;
        require(
            self.tile_path_template == TILE_TEMPLATE,
            "tilePathTemplate",
            "must be the confined version-one template",
        )?;
        require(
            self.verification.canonical_download_verified,
            "verification.canonicalDownloadVerified",
            "must be true",
        )?;
        require(
            !self.verification.individual_tile_proofs,
            "verification.individualTileProofs",
            "must be false",
        )
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        parse_validated(bytes, Self::validate)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotIdentity {
    pub epoch: u64,
    pub width: u32,
    pub height: u32,
    pub network_id: String,
    pub contract_address: String,
    pub generation: u64,
    pub seed: u64,
    pub population: u64,
    pub state_digest: [u8; 32],
}

/// Verification record for one published snapshot. It binds the verified
/// world identity to the block whose state was downloaded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeProvenance {
    pub schema_version: u8,
    pub network_id: String,
    pub contract_address: String,
    pub epoch: String,
    pub generation: String,
    pub seed: String,
    pub population: String,
    pub state_digest: String,
    pub source_block_height: String,
    pub source_block_hash: String,
    pub verified_at: String,
}

impl LifeProvenance {
    pub fn validate(&self) -> Result<()> {
        require(
            self.schema_version == SCHEMA_VERSION,
            "schemaVersion",
            "must be 2",
        )?;
        validate_network_id(&self.network_id)?;
        validate_hex32("contractAddress", &self.contract_address)?;
        parse_u64("epoch", &self.epoch)?;
        parse_u64("generation", &self.generation)?;
        parse_u64("seed", &self.seed)?;
        parse_u64("population", &self.population)?;
        validate_hex32("stateDigest", &self.state_digest)?;
        parse_u64("sourceBlockHeight", &self.source_block_height)?;
        validate_hex32("sourceBlockHash", &self.source_block_hash)?;
        validate_timestamp("verifiedAt", &self.verified_at)
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        parse_validated(bytes, Self::validate)
    }

    pub(crate) fn matches(&self, identity: &SnapshotIdentity) -> bool {
        self.network_id == identity.network_id
            && self.epoch == identity.epoch.to_string()
            && self.contract_address == identity.contract_address
            && self.generation == identity.generation.to_string()
            && self.seed == identity.seed.to_string()
            && self.population == identity.population.to_string()
            && self.state_digest == hex32(&identity.state_digest)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LatestPointer {
    pub epoch: String,
    pub schema_version: u8,
    pub generation: String,
    pub state_digest: String,
    pub manifest_url: String,
    pub source_block_height: String,
    pub source_block_hash: String,
    pub published_at: String,
}

impl LatestPointer {
    pub fn validate_for(&self, network_id: &str, contract_address: &str) -> Result<()> {
        parse_u64("epoch", &self.epoch)?;
        require(
            self.schema_version == SCHEMA_VERSION,
            "schemaVersion",
            "must be 2",
        )?;
        parse_u64("generation", &self.generation)?;
        validate_hex32("stateDigest", &self.state_digest)?;
        parse_u64("sourceBlockHeight", &self.source_block_height)?;
        validate_hex32("sourceBlockHash", &self.source_block_hash)?;
        validate_timestamp("publishedAt", &self.published_at)?;
        validate_network_id(network_id)?;
        validate_hex32("contractAddress", contract_address)?;
        let expected = format!(
            "/v2/worlds/{network_id}/{contract_address}/{}/manifest.json",
            self.state_digest
        );
        require(
            self.manifest_url == expected,
            "manifestUrl",
            "must exactly match the canonical pointer scope",
        )
    }

    /// Publication order: `(epoch, generation)`.
    pub(crate) fn order(&self) -> Result<(u64, u64)> {
        Ok((
            parse_u64("epoch", &self.epoch)?,
            parse_u64("generation", &self.generation)?,
        ))
    }

    pub fn from_json_for(bytes: &[u8], network_id: &str, contract_address: &str) -> Result<Self> {
        let value: Self =
            serde_json::from_slice(bytes).map_err(|error| Error::Json(error.to_string()))?;
        value.validate_for(network_id, contract_address)?;
        Ok(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexerState {
    Idle,
    Preparing,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedIdentity {
    pub epoch: String,
    pub generation: String,
    pub state_digest: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressUnit {
    Chunks,
    Tiles,
    Files,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    pub epoch: String,
    pub generation: String,
    pub state_digest: String,
    pub completed_units: u32,
    pub total_units: u32,
    pub unit: ProgressUnit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Retry {
    pub attempt: u32,
    pub next_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeStatus {
    pub schema_version: u8,
    pub state: IndexerState,
    pub observed: Option<PublishedIdentity>,
    pub preparing: Option<Progress>,
    pub published: Option<PublishedIdentity>,
    pub retry: Option<Retry>,
    pub error_code: Option<String>,
    pub heartbeat_at: String,
}

pub(crate) fn compact_json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|error| Error::Json(error.to_string()))
}

fn parse_validated<T: DeserializeOwned>(bytes: &[u8], validate: fn(&T) -> Result<()>) -> Result<T> {
    let value = serde_json::from_slice(bytes).map_err(|error| Error::Json(error.to_string()))?;
    validate(&value)?;
    Ok(value)
}

fn validate_network_id(value: &str) -> Result<()> {
    require(
        is_network_id(value),
        "networkId",
        "must be 64 lowercase hexadecimal characters without 0x",
    )
}

fn validate_hex32(field: &'static str, value: &str) -> Result<()> {
    require(
        is_hex32(value),
        field,
        "must be canonical lowercase 0x-prefixed 32-byte hexadecimal",
    )
}

fn validate_timestamp(field: &'static str, value: &str) -> Result<()> {
    require(
        value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok(),
        field,
        "must be a UTC RFC 3339 timestamp",
    )
}

pub(crate) fn parse_u64(field: &'static str, value: &str) -> Result<u64> {
    require(
        value == "0" || !value.starts_with('0'),
        field,
        "must be a canonical decimal u64",
    )?;
    value.parse().map_err(|_| Error::Schema {
        field,
        reason: "must be a canonical decimal u64",
    })
}

fn require(condition: bool, field: &'static str, reason: &'static str) -> Result<()> {
    condition
        .then_some(())
        .ok_or(Error::Schema { field, reason })
}

/// Returns true for 64 lowercase hexadecimal characters without a prefix.
pub(crate) fn is_network_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(is_lower_hex)
}

/// Returns true for canonical lowercase 0x-prefixed 32-byte hexadecimal.
pub(crate) fn is_hex32(value: &str) -> bool {
    value
        .strip_prefix("0x")
        .is_some_and(|digits| digits.len() == 64 && digits.bytes().all(is_lower_hex))
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

pub(crate) fn hex32(value: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(value))
}

pub(crate) fn now() -> String {
    timestamp(chrono::Utc::now())
}

pub(crate) fn timestamp(value: chrono::DateTime<chrono::Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
