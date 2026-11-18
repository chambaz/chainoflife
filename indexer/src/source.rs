use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{StreamExt, TryStreamExt, stream};
use thruput_contract_util::{NormalizedMethodSignature, contract_entrypoint_id};
use thruput_json_rpc_client::{
    DecodedResponse, HttpClient, HttpClientBuilder, NativeClient, NativeClientError,
};
use thruput_json_rpc_types::base58::Base58;
use thruput_json_rpc_types::hex::HexBytes;
use thruput_json_rpc_types::requests::{
    BlockQuery, EmptyRequest, Invocation, SimulateInvocationRequest as ViewRequest,
    SimulateInvocationsRequest,
};
use thruput_json_rpc_types::responses::{
    InvocationOutput as RootInvocationOutput, SimulationResult as ViewResponse,
};
use thruput_xdr::types::{ContractAddress, SHA256Hash};
use tokio::sync::OnceCell;

use crate::{CHUNK_BYTES, ChunkResponse, SnapshotMetadata};

const INTERFACE: &str = "GameOfLife";
const VERSION: &str = "0.1.0";

#[derive(Clone, Debug)]
pub struct SourceConfig {
    /// Concurrent RPC requests during a download.
    pub concurrency: usize,
    /// Most `get_chunk` views in one `simulateInvocations` request. The
    /// endpoint's advertised batch limit lowers it; 1 disables batching.
    pub batch_size: u32,
    pub call_timeout: Duration,
    pub max_attempts: u32,
    pub initial_backoff: Duration,
}

impl Default for SourceConfig {
    fn default() -> Self {
        Self {
            concurrency: 64,
            batch_size: 16,
            call_timeout: Duration::from_secs(10),
            max_attempts: 4,
            initial_backoff: Duration::from_millis(100),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CoherentDownload {
    pub metadata: SnapshotMetadata,
    pub chunks: Vec<ChunkResponse>,
    pub source_block_height: u64,
    pub source_block_hash: [u8; 32],
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("build RPC client: {0}")]
    Client(String),
    #[error("RPC {operation} failed after bounded retries: {message}")]
    Rpc {
        operation: &'static str,
        message: String,
    },
    #[error("RPC {operation} timed out after bounded retries")]
    Timeout { operation: &'static str },
    #[error("contract view {0} did not return normally")]
    View(&'static str),
    #[error("decode {0}: {1}")]
    Decode(&'static str, String),
    #[error("mixed-generation download: {0}")]
    Mixed(String),
}

#[async_trait]
pub trait ChainSource: Send + Sync {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError>;
    async fn download(&self) -> Result<CoherentDownload, SourceError>;
}

pub struct ThruputSource {
    client: Arc<NativeClient<HttpClient>>,
    contract: ContractAddress,
    config: SourceConfig,
    /// Views per download request, once the endpoint's limits are known.
    batch_size: OnceCell<usize>,
}

impl ThruputSource {
    pub fn new(
        rpc_url: &str,
        contract: ContractAddress,
        config: SourceConfig,
    ) -> Result<Self, SourceError> {
        let client = HttpClientBuilder::default()
            .build(rpc_url)
            .map_err(|error| SourceError::Client(error.to_string()))?;
        Ok(Self {
            client: Arc::new(NativeClient::new(client)),
            contract,
            config,
            batch_size: OnceCell::new(),
        })
    }

    fn entrypoint(method: &'static str) -> HexBytes {
        HexBytes(
            contract_entrypoint_id(
                Some(INTERFACE),
                VERSION,
                &NormalizedMethodSignature::new(method),
            )
            .into_inner()
            .to_vec(),
        )
    }

    /// The configured batch size, capped by the endpoint's batch limits.
    async fn batch_size(&self) -> Result<usize, SourceError> {
        self.batch_size
            .get_or_try_init(|| async {
                if self.config.batch_size <= 1 {
                    return Ok(1);
                }
                let limits = self
                    .retry("getServerLimits", || {
                        self.client.get_server_limits(EmptyRequest {})
                    })
                    .await?;
                Ok(limits.simulation_batch.map_or(1, |batch| {
                    batch.max_invocations.clamp(1, self.config.batch_size) as usize
                }))
            })
            .await
            .copied()
    }

    /// Reads `get_chunk` for each `(row, part)` key at a state height of at
    /// least `height`. A batch executes every view against one snapshot.
    async fn chunks(
        &self,
        keys: &[(u32, u32)],
        height: i64,
    ) -> Result<Vec<ChunkResponse>, SourceError> {
        let (response_height, outputs) = if let [(row, part)] = keys {
            let response = self.view("get_chunk", encode(&(*row, *part))?).await?;
            (*response.state_block_height, vec![response.output])
        } else {
            let invocations = keys
                .iter()
                .map(|key| {
                    Ok(Invocation {
                        address: Base58((*self.contract).into()),
                        entrypoint: Self::entrypoint("get_chunk"),
                        calldata: HexBytes(encode(key)?),
                        caller: None,
                        assumed_auth: None,
                        gas_limit: None,
                    })
                })
                .collect::<Result<Vec<_>, SourceError>>()?;
            let request = SimulateInvocationsRequest {
                invocations,
                min_state_block_height: Some(height.into()),
            };
            let response = self
                .retry("get_chunk batch", || {
                    self.client.simulate_invocations(request.clone())
                })
                .await?;
            if response.results.len() != keys.len() {
                return Err(SourceError::Decode(
                    "get_chunk",
                    format!(
                        "batch returned {} results for {} calls",
                        response.results.len(),
                        keys.len()
                    ),
                ));
            }
            let outputs = response.results.into_iter().map(|result| result.output);
            (*response.state_block_height, outputs.collect())
        };
        if response_height < height {
            return Err(SourceError::Mixed(format!(
                "chunks {keys:?} used height {response_height}, expected {height}"
            )));
        }
        keys.iter()
            .zip(outputs)
            .map(|(&(row, part), output)| {
                let bytes: [u8; CHUNK_BYTES] = decode("get_chunk", &output)?;
                Ok(ChunkResponse {
                    row,
                    part,
                    bytes: bytes.to_vec(),
                })
            })
            .collect()
    }

    async fn view(
        &self,
        method: &'static str,
        calldata: Vec<u8>,
    ) -> Result<ViewResponse, SourceError> {
        let request = ViewRequest {
            address: Base58((*self.contract).into()),
            assumed_auth: None,
            gas_limit: None,
            min_state_block_height: None,
            entrypoint: Self::entrypoint(method),
            calldata: HexBytes(calldata),
            caller: None,
        };
        self.retry(method, || self.client.simulate_invocation(request.clone()))
            .await
    }

    async fn retry<T, F, Fut>(&self, operation: &'static str, mut call: F) -> Result<T, SourceError>
    where
        F: FnMut() -> Fut + Send,
        Fut: std::future::Future<Output = Result<DecodedResponse<T>, NativeClientError>> + Send,
        T: Send,
    {
        let mut backoff = self.config.initial_backoff;
        let mut last = None;
        for attempt in 1..=self.config.max_attempts {
            match tokio::time::timeout(self.config.call_timeout, call()).await {
                Ok(Ok(DecodedResponse::Known(value))) => return Ok(value),
                Ok(Ok(_)) => {
                    return Err(SourceError::Decode(
                        operation,
                        "unsupported RPC response".into(),
                    ));
                }
                Ok(Err(error)) => {
                    last = Some(SourceError::Rpc {
                        operation,
                        message: error.to_string(),
                    })
                }
                Err(_) => last = Some(SourceError::Timeout { operation }),
            }
            if attempt < self.config.max_attempts {
                tokio::time::sleep(backoff).await;
                backoff = backoff.saturating_mul(2);
            }
        }
        Err(last.unwrap_or(SourceError::Timeout { operation }))
    }

    /// Reads and validates metadata, so callers can trust its layout fields.
    async fn metadata_response(&self) -> Result<(SnapshotMetadata, i64), SourceError> {
        let response = self.view("get_metadata", encode(&())?).await?;
        let height = *response.state_block_height;
        let metadata: SnapshotMetadata =
            decode::<WireMetadata>("get_metadata", &response.output)?.into();
        metadata
            .validate()
            .map_err(|error| SourceError::Decode("get_metadata", error.to_string()))?;
        Ok((metadata, height))
    }
}

#[async_trait]
impl ChainSource for ThruputSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        Ok(self.metadata_response().await?.0)
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        let (before, height) = self.metadata_response().await?;
        let batch_size = self.batch_size().await?;
        let parts = before.chunks_per_row();
        let keys = (0..before.chunk_count() as u32)
            .map(|key| (key / parts, key % parts))
            .collect::<Vec<_>>();
        let batches = keys
            .chunks(batch_size)
            .map(<[_]>::to_vec)
            .collect::<Vec<_>>();
        let chunks = stream::iter(batches)
            .map(|keys| async move { self.chunks(&keys, height).await })
            .buffer_unordered(self.config.concurrency)
            .try_concat()
            .await?;
        let (after, after_height) = self.metadata_response().await?;
        if after_height < height || before != after {
            return Err(SourceError::Mixed(format!(
                "world changed during download: before={height}, after={after_height}"
            )));
        }
        // A generation can span many blocks. The full digest check in snapshot.rs
        // verifies the downloaded bytes; unrelated blocks need not stop indexing.
        let block = self
            .retry("getBlockByHeight", || {
                self.client.get_block_by_height(BlockQuery {
                    block_height: height.into(),
                })
            })
            .await?
            .ok_or_else(|| SourceError::Mixed("source block is unavailable".into()))?;
        let source_block_height = u64::try_from(height)
            .map_err(|_| SourceError::Mixed("negative source height".into()))?;
        let source_block_hash: [u8; 32] = block
            .block_hash
            .as_ref()
            .try_into()
            .map_err(|_| SourceError::Mixed("invalid block hash".into()))?;
        Ok(CoherentDownload {
            metadata: before,
            chunks,
            source_block_height,
            source_block_hash,
        })
    }
}

#[derive(Debug, PartialEq, Eq, xdrs::ReadXDR)]
#[xdrs(crate = "::xdrs")]
struct WireMetadata {
    epoch: u64,
    size: u32,
    generation: u64,
    seed: u64,
    population: u64,
    state_digest: SHA256Hash,
    // Deployment policy is not part of the world digest or tile schema.
    resizable: bool,
}

impl From<WireMetadata> for SnapshotMetadata {
    fn from(value: WireMetadata) -> Self {
        Self {
            epoch: value.epoch,
            size: value.size,
            generation: value.generation,
            seed: value.seed,
            population: value.population,
            state_digest: value.state_digest.into_inner(),
        }
    }
}

fn decode<T: for<'a> xdrs::ReadXDR<'a>>(
    name: &'static str,
    output: &RootInvocationOutput,
) -> Result<T, SourceError> {
    let RootInvocationOutput::Return { return_data } = output else {
        return Err(SourceError::View(name));
    };
    xdrs::cxs::decode(&return_data.0).map_err(|error| SourceError::Decode(name, error.to_string()))
}
fn encode<T: xdrs::WriteXDR>(value: &T) -> Result<Vec<u8>, SourceError> {
    xdrs::cxs::encode(value).map_err(|error| SourceError::Decode("calldata", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_decoder_reads_the_contract_layout() {
        let bytes = xdrs::cxs::encode(&(
            3u64,
            10_000u32,
            7u64,
            0u64,
            49_999_272u64,
            SHA256Hash::from([5; 32]),
            true,
        ))
        .expect("metadata payload");
        let wire: WireMetadata = xdrs::cxs::decode(&bytes).expect("decode metadata");
        assert!(wire.resizable);
        let metadata = SnapshotMetadata::from(wire);
        assert_eq!(metadata.epoch, 3);
        assert_eq!(metadata.size, 10_000);
        assert_eq!(metadata.generation, 7);
        assert_eq!(metadata.population, 49_999_272);
        assert_eq!(metadata.chunks_per_row(), 2);
        assert_eq!(metadata.chunk_count(), 20_000);
        let mut trailing = bytes;
        trailing.push(0);
        assert!(xdrs::cxs::decode::<WireMetadata>(&trailing).is_err());
    }
}
