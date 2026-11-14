use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use crate::schema::{hex32, now, timestamp};
use crate::snapshot::tile_count;
use crate::source::{ChainSource, CoherentDownload, SourceError};
use crate::storage::{Publisher, StorageError};
use crate::{
    IndexerState, LatestPointer, LifeProvenance, LifeStatus, Progress, ProgressUnit,
    PublishedIdentity, SnapshotMetadata, build_snapshot,
};

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub network_id: String,
    pub contract_address: String,
    pub poll_interval: Duration,
    pub retention_grace: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error(transparent)]
    Source(#[from] SourceError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Snapshot(#[from] crate::Error),
}

/// A publication that `latest.json` has replaced. Browsers can still
/// be loading it, so it stays on disk for the retention grace period.
struct Superseded {
    digest: String,
    since: Instant,
}

/// Polls the chain, verifies changed worlds, and publishes them.
///
/// All durable state is on the filesystem: immutable digest directories and
/// `latest.json`. The publisher's writer lock makes this the only writer.
pub struct IndexerService<S> {
    config: ServiceConfig,
    source: S,
    publisher: Publisher,
    status: Arc<RwLock<LifeStatus>>,
    latest: Option<LatestPointer>,
    reconciled: bool,
    /// Oldest first. The last entry is the previous publication.
    superseded: Vec<Superseded>,
    retry_attempt: u32,
}

impl<S: ChainSource> IndexerService<S> {
    pub fn new(
        config: ServiceConfig,
        source: S,
        publisher: Publisher,
        status: Arc<RwLock<LifeStatus>>,
    ) -> Self {
        Self {
            config,
            source,
            publisher,
            status,
            latest: None,
            reconciled: false,
            superseded: Vec::new(),
            retry_attempt: 0,
        }
    }

    pub async fn run(mut self) -> Result<(), ServiceError> {
        loop {
            let delay = self.step().await;
            tokio::time::sleep(delay).await;
        }
    }

    #[doc(hidden)]
    pub async fn step(&mut self) -> Duration {
        match self.cycle().await {
            Ok(()) => {
                self.retry_attempt = 0;
                self.config.poll_interval
            }
            Err(error) => {
                // RPC calls retry with backoff in the source; failed cycles wait one poll.
                self.retry_attempt = self.retry_attempt.saturating_add(1);
                let delay = self.config.poll_interval;
                let mut status = self.status.write().await;
                status.state = IndexerState::Error;
                status.preparing = None;
                status.error_code = Some(error_code(&error).into());
                status.retry = Some(crate::Retry {
                    attempt: self.retry_attempt,
                    next_at: timestamp(
                        chrono::Utc::now() + chrono::Duration::from_std(delay).unwrap_or_default(),
                    ),
                });
                delay
            }
        }
    }

    pub async fn cycle(&mut self) -> Result<(), ServiceError> {
        let cycle_started = Instant::now();
        if !self.reconciled {
            self.reconcile().await?;
        }
        let observed = self.source.metadata().await?;
        let digest = hex32(&observed.state_digest);
        if self.is_latest(&observed, &digest) {
            self.cleanup()?;
            self.set_idle(&observed, &digest).await;
            return Ok(());
        }

        self.set_preparing(&observed, &digest, ProgressUnit::Chunks, 0)
            .await;
        let download_started = Instant::now();
        let download = self.source.download().await?;
        eprintln!(
            "game_of_life_indexer_metric stage=download generation={} elapsed_ms={}",
            observed.generation,
            download_started.elapsed().as_millis()
        );
        if download.metadata != observed {
            return Err(
                SourceError::Mixed("world changed between poll and download".into()).into(),
            );
        }
        let CoherentDownload {
            metadata,
            chunks,
            source_block_height,
            source_block_hash,
        } = download;

        // Reuse the provenance of an interrupted install of the same digest,
        // so retried immutable files keep identical bytes.
        let provenance = match self.publisher.provenance(
            &self.config.network_id,
            &self.config.contract_address,
            &digest,
        )? {
            Some(existing) => existing,
            None => self.provenance(&metadata, source_block_height, source_block_hash),
        };
        self.set_preparing(&metadata, &digest, ProgressUnit::Tiles, 0)
            .await;
        let build_started = Instant::now();
        // Verifies population and digest before any artifact is written.
        let snapshot = build_snapshot(
            &metadata,
            self.config.network_id.clone(),
            self.config.contract_address.clone(),
            chunks,
            provenance,
        )?;
        let generated_bytes = snapshot
            .artifacts
            .iter()
            .map(|artifact| artifact.bytes.len() as u64)
            .sum::<u64>();
        eprintln!(
            "game_of_life_indexer_metric stage=build generation={} elapsed_ms={} generated_bytes={generated_bytes}",
            metadata.generation,
            build_started.elapsed().as_millis()
        );

        self.set_preparing(&metadata, &digest, ProgressUnit::Files, 0)
            .await;
        let publication_started = Instant::now();
        self.publisher.publish_snapshot(
            &self.config.network_id,
            &self.config.contract_address,
            &digest,
            &snapshot.artifacts,
        )?;
        let pointer = LatestPointer {
            epoch: metadata.epoch.to_string(),
            schema_version: crate::schema::SCHEMA_VERSION,
            generation: metadata.generation.to_string(),
            state_digest: digest.clone(),
            manifest_url: format!(
                "/v1/worlds/{}/{}/{digest}/manifest.json",
                self.config.network_id, self.config.contract_address
            ),
            source_block_height: snapshot.provenance.source_block_height.clone(),
            source_block_hash: snapshot.provenance.source_block_hash.clone(),
            published_at: now(),
        };
        // A failed promotion can still have replaced latest.json; reload it next cycle.
        self.reconciled = false;
        self.publisher.promote(
            &self.config.network_id,
            &self.config.contract_address,
            &pointer,
        )?;
        if let Some(previous) = self.latest.replace(pointer)
            && previous.state_digest != digest
        {
            self.superseded.push(Superseded {
                digest: previous.state_digest,
                since: Instant::now(),
            });
        }
        self.reconciled = true;
        eprintln!(
            "game_of_life_indexer_metric stage=publication generation={} elapsed_ms={} total_ms={}",
            metadata.generation,
            publication_started.elapsed().as_millis(),
            cycle_started.elapsed().as_millis()
        );
        self.cleanup()?;
        self.set_idle(&metadata, &digest).await;
        Ok(())
    }

    fn is_latest(&self, metadata: &SnapshotMetadata, digest: &str) -> bool {
        self.latest.as_ref().is_some_and(|latest| {
            latest.epoch == metadata.epoch.to_string()
                && latest.generation == metadata.generation.to_string()
                && latest.state_digest == digest
        })
    }

    fn provenance(
        &self,
        metadata: &SnapshotMetadata,
        height: u64,
        hash: [u8; 32],
    ) -> LifeProvenance {
        LifeProvenance {
            schema_version: crate::schema::SCHEMA_VERSION,
            network_id: self.config.network_id.clone(),
            contract_address: self.config.contract_address.clone(),
            epoch: metadata.epoch.to_string(),
            generation: metadata.generation.to_string(),
            seed: metadata.seed.to_string(),
            population: metadata.population.to_string(),
            state_digest: hex32(&metadata.state_digest),
            source_block_height: height.to_string(),
            source_block_hash: hex32(&hash),
            verified_at: now(),
        }
    }

    /// Loads `latest.json`. On startup, every older complete publication is
    /// treated as just superseded, so a restart keeps it for one grace period.
    async fn reconcile(&mut self) -> Result<(), ServiceError> {
        let network = &self.config.network_id;
        let contract = &self.config.contract_address;
        let loaded = self.publisher.latest(network, contract)?;
        // A failed promotion can still have replaced latest.json.
        if let Some(previous) = std::mem::replace(&mut self.latest, loaded)
            && self
                .latest
                .as_ref()
                .is_some_and(|latest| latest.state_digest != previous.state_digest)
        {
            self.superseded.push(Superseded {
                digest: previous.state_digest,
                since: Instant::now(),
            });
        }
        if self.superseded.is_empty()
            && let Some(latest) = &self.latest
        {
            // Ready directories above latest are unpromoted candidates, not
            // publications. The next cycle can reuse or remove them.
            let order = latest.order()?;
            self.superseded = self
                .publisher
                .ready_identities(network, contract)?
                .into_iter()
                .filter(|identity| (identity.epoch, identity.generation) < order)
                .map(|identity| Superseded {
                    digest: identity.state_digest,
                    since: Instant::now(),
                })
                .collect();
        }
        if let Some(latest) = &self.latest {
            let (epoch, generation) = latest.order()?;
            self.status.write().await.published =
                Some(identity(epoch, generation, &latest.state_digest));
        }
        self.reconciled = true;
        Ok(())
    }

    /// Keeps the latest publication, the previous publication, and anything
    /// superseded within the grace period. Removes every other digest directory.
    fn cleanup(&mut self) -> Result<(), ServiceError> {
        let Some(latest) = &self.latest else {
            return Ok(());
        };
        let grace = self.config.retention_grace;
        let previous = self.superseded.len().saturating_sub(1);
        let mut index = 0;
        self.superseded.retain(|entry| {
            let keep = index == previous || entry.since.elapsed() < grace;
            index += 1;
            keep && entry.digest != latest.state_digest
        });
        let mut retained = vec![latest.state_digest.clone()];
        retained.extend(self.superseded.iter().map(|entry| entry.digest.clone()));
        self.publisher.cleanup(
            &self.config.network_id,
            &self.config.contract_address,
            &retained,
        )?;
        Ok(())
    }

    async fn set_preparing(
        &self,
        metadata: &SnapshotMetadata,
        digest: &str,
        unit: ProgressUnit,
        completed_units: u32,
    ) {
        let total_units = match unit {
            ProgressUnit::Chunks => metadata.chunk_count() as u32,
            ProgressUnit::Tiles => tile_count(metadata.size),
            // Every tile plus manifest.json and provenance.json.
            ProgressUnit::Files => tile_count(metadata.size) + 2,
        };
        let mut status = self.status.write().await;
        status.observed = Some(identity(metadata.epoch, metadata.generation, digest));
        status.state = IndexerState::Preparing;
        status.preparing = Some(Progress {
            epoch: metadata.epoch.to_string(),
            generation: metadata.generation.to_string(),
            state_digest: digest.to_owned(),
            completed_units,
            total_units,
            unit,
        });
        status.error_code = None;
        status.retry = None;
    }

    async fn set_idle(&self, metadata: &SnapshotMetadata, digest: &str) {
        let published = identity(metadata.epoch, metadata.generation, digest);
        let mut status = self.status.write().await;
        status.observed = Some(published.clone());
        status.published = Some(published);
        status.state = IndexerState::Idle;
        status.preparing = None;
        status.error_code = None;
        status.retry = None;
    }
}

pub fn initial_status() -> LifeStatus {
    LifeStatus {
        schema_version: crate::schema::SCHEMA_VERSION,
        state: IndexerState::Idle,
        observed: None,
        preparing: None,
        published: None,
        retry: None,
        error_code: None,
        heartbeat_at: now(),
    }
}
fn identity(epoch: u64, generation: u64, digest: &str) -> PublishedIdentity {
    PublishedIdentity {
        epoch: epoch.to_string(),
        generation: generation.to_string(),
        state_digest: digest.into(),
    }
}
fn error_code(error: &ServiceError) -> &'static str {
    match error {
        ServiceError::Source(_) => "SOURCE_ERROR",
        ServiceError::Storage(_) => "PUBLICATION_ERROR",
        ServiceError::Snapshot(crate::Error::Digest { .. }) => "DIGEST_MISMATCH",
        ServiceError::Snapshot(_) => "SNAPSHOT_INVALID",
    }
}
