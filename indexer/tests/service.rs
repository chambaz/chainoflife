use std::fs::{self, File};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use game_of_life_core::digest::WorldDigest;
use game_of_life_indexer::service::{IndexerService, ServiceConfig, ServiceError, initial_status};
use game_of_life_indexer::source::{ChainSource, CoherentDownload, SourceError};
use game_of_life_indexer::storage::{Publisher, StorageError};
use game_of_life_indexer::web::{HttpService, heartbeat_with_interval};
use game_of_life_indexer::{
    CHUNK_BYTES, ChunkResponse, IndexerState, LatestPointer, LifeManifest, LifeProvenance,
    LifeStatus, MAX_ZOOM, ProgressUnit, SnapshotIdentity, SnapshotMetadata, build_snapshot,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

const NETWORK: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST0: &str = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST1: &str = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST2: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DIGEST3: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const WORLD_SIZE: u32 = 10_000;
const CHUNKS_PER_ROW: u32 = 2;
const TAIL_BYTES: usize = 250;

#[test]
fn second_writer_is_refused() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let _first = Publisher::open(root.clone()).expect("first writer");
    let error = Publisher::open(root)
        .err()
        .expect("second writer must be refused");
    assert!(matches!(error, StorageError::WriterActive));
}

#[tokio::test]
async fn mixed_generation_download_is_rejected_before_publication() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let mut service = service(
        MixedSource,
        Publisher::open(root.clone()).expect("publisher"),
        Duration::from_secs(60),
    );
    let error = service.cycle().await.expect_err("mixed generation");
    assert!(matches!(error, ServiceError::Source(SourceError::Mixed(_))));
    assert!(!scope(&root).join("latest.json").exists());
}

#[test]
fn interrupted_publication_cannot_advance_latest() {
    let fixture = Fixture::new();
    let base = fixture.digest_dir(DIGEST0);
    fs::create_dir_all(&base).expect("create incomplete candidate");
    let error = fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
        .expect_err("incomplete candidate must fail");
    assert!(matches!(error, StorageError::Io { .. }));
    assert!(!fixture.latest().exists());
}

#[test]
fn stale_build_does_not_replace_latest() {
    let fixture = Fixture::new();
    fixture.ready(2, DIGEST2);
    fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(2, DIGEST2))
        .expect("promote generation two");
    fixture.ready(1, DIGEST1);
    let error = fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(1, DIGEST1))
        .expect_err("stale candidate must fail");
    assert!(matches!(
        error,
        StorageError::Stale {
            candidate: 1,
            latest: 2
        }
    ));
}

#[test]
fn reset_generation_zero_supersedes_prior_epoch_and_survives_restart() {
    let fixture = Fixture::new();
    fixture.ready(9, DIGEST0);
    fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(9, DIGEST0))
        .unwrap();
    fixture.ready(0, DIGEST1);
    for file in ["manifest.json", "provenance.json"] {
        let path = fixture.digest_dir(DIGEST1).join(file);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["epoch"] = "1".into();
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    let mut reset = pointer(0, DIGEST1);
    reset.epoch = "1".into();
    fixture
        .publisher
        .promote(NETWORK, CONTRACT, &reset)
        .unwrap();
    assert!(matches!(
        fixture
            .publisher
            .promote(NETWORK, CONTRACT, &pointer(9, DIGEST0)),
        Err(StorageError::Stale { .. })
    ));
    let root = fixture.publisher.root().to_owned();
    drop(fixture.publisher);
    let publisher = Publisher::open(root).unwrap();
    assert_eq!(publisher.latest(NETWORK, CONTRACT).unwrap(), Some(reset));
}

#[test]
fn generation_mismatch_cannot_poison_latest_as_stale() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let error = fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(99, DIGEST0))
        .expect_err("pointer generation must match ready artifacts");
    assert!(matches!(error, StorageError::Collision(_)));
    assert!(!fixture.latest().exists());

    fixture.ready(1, DIGEST1);
    assert!(
        fixture
            .publisher
            .promote(NETWORK, CONTRACT, &pointer(1, DIGEST1))
            .expect("valid generation must not be made stale")
    );
}

#[test]
fn source_block_mismatch_is_rejected_by_promote_and_latest() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let mut mismatched = pointer(0, DIGEST0);
    mismatched.source_block_height = "10".into();
    assert!(matches!(
        fixture.publisher.promote(NETWORK, CONTRACT, &mismatched),
        Err(StorageError::Collision(_))
    ));

    fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
        .expect("promote matching pointer");
    mismatched.source_block_height = "9".into();
    mismatched.source_block_hash = format!("0x{}", "e".repeat(64));
    fs::write(
        fixture.latest(),
        serde_json::to_vec(&mismatched).expect("latest JSON"),
    )
    .expect("poison latest source block");
    assert!(matches!(
        fixture.publisher.latest(NETWORK, CONTRACT),
        Err(StorageError::Collision(_))
    ));
}

#[test]
fn digest_mismatch_cannot_be_promoted() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    fs::rename(fixture.digest_dir(DIGEST0), fixture.digest_dir(DIGEST1))
        .expect("move mismatched candidate");
    let error = fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST1))
        .expect_err("wrong digest path must fail");
    assert!(matches!(error, StorageError::Collision(_)));
}

#[test]
fn manifest_and_provenance_identity_mismatch_cannot_be_promoted() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let path = fixture.digest_dir(DIGEST0).join("provenance.json");
    let mut provenance =
        LifeProvenance::from_json(&fs::read(&path).expect("provenance")).expect("valid provenance");
    provenance.population = "1".into();
    fs::write(&path, serde_json::to_vec(&provenance).expect("JSON")).expect("rewrite provenance");
    assert!(matches!(
        fixture
            .publisher
            .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0)),
        Err(StorageError::Collision(_))
    ));
}

#[test]
fn repeated_promotion_is_idempotent() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    assert!(
        fixture
            .publisher
            .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
            .expect("first promotion")
    );
    assert!(
        !fixture
            .publisher
            .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
            .expect("repeat promotion")
    );
}

#[tokio::test]
async fn publishes_verified_world_with_chain_provenance() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let metadata = dead_metadata(0);
    let digest = hex_digest(&metadata);
    let status = Arc::new(RwLock::new(initial_status()));
    let downloads = Arc::new(AtomicUsize::new(0));
    let source = StatusObservingSource {
        inner: DeadSource::new(metadata),
        status: Arc::clone(&status),
        downloads: Arc::clone(&downloads),
    };
    let mut service = IndexerService::new(
        config(Duration::from_secs(60)),
        source,
        Publisher::open(root.clone()).expect("publisher"),
        Arc::clone(&status),
    );
    service.cycle().await.expect("publish");
    assert_eq!(downloads.load(Ordering::SeqCst), 1);

    let latest = read_latest(&root);
    assert_eq!(latest.generation, "0");
    assert_eq!(latest.state_digest, digest);
    assert_eq!(latest.source_block_height, "1");
    let provenance = LifeProvenance::from_json(
        &fs::read(scope(&root).join(&digest).join("provenance.json")).expect("provenance"),
    )
    .expect("valid provenance");
    assert_eq!(provenance.source_block_height, "1");
    assert_eq!(
        provenance.source_block_hash,
        format!("0x{}", "04".repeat(32))
    );
    assert_eq!(provenance.population, "0");

    let status = status.read().await;
    assert_eq!(status.state, IndexerState::Idle);
    assert_eq!(status.preparing, None);
    assert_eq!(
        status.published.as_ref().expect("published").state_digest,
        digest
    );
}

#[tokio::test]
async fn failed_verification_writes_no_artifacts() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let mut metadata = dead_metadata(0);
    metadata.state_digest = [9; 32];
    let digest = hex_digest(&metadata);
    let mut service = service(
        DeadSource::new(metadata),
        Publisher::open(root.clone()).expect("publisher"),
        Duration::from_secs(60),
    );
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::Snapshot(
            game_of_life_indexer::Error::Digest { .. }
        ))
    ));
    assert!(!scope(&root).join(digest).exists());
    assert!(!scope(&root).join("latest.json").exists());
}

/// A crash after the immutable install but before promotion leaves a complete,
/// unpromoted directory. The restarted indexer reuses its provenance, so it
/// promotes identical bytes even though it downloaded from a later block.
#[tokio::test]
async fn install_interrupted_before_promotion_recovers_identical_bytes() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let metadata = dead_metadata(0);
    let digest = hex_digest(&metadata);
    install_without_promotion(&root, &metadata, 1);
    let directory = scope(&root).join(&digest);
    let manifest_before = fs::read(directory.join("manifest.json")).expect("manifest");
    let provenance_before = fs::read(directory.join("provenance.json")).expect("provenance");

    let mut source = DeadSource::new(metadata);
    source.height = 2;
    let mut service = service(
        source,
        Publisher::open(root.clone()).expect("restarted publisher"),
        Duration::from_secs(60),
    );
    service.cycle().await.expect("recover publication");
    assert_eq!(
        fs::read(directory.join("manifest.json")).unwrap(),
        manifest_before
    );
    assert_eq!(
        fs::read(directory.join("provenance.json")).unwrap(),
        provenance_before
    );
    let latest = read_latest(&root);
    assert_eq!(latest.state_digest, digest);
    assert_eq!(latest.source_block_height, "1");
}

/// A crash during the install can leave provenance and tiles without a manifest.
#[tokio::test]
async fn partial_install_without_manifest_completes_with_saved_provenance() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let metadata = dead_metadata(0);
    let digest = hex_digest(&metadata);
    install_without_promotion(&root, &metadata, 1);
    let directory = scope(&root).join(&digest);
    fs::remove_file(directory.join("manifest.json")).expect("simulate interrupted install");
    fs::remove_file(directory.join("tiles/6/0/0.bin")).expect("simulate missing tile");

    let mut source = DeadSource::new(metadata);
    source.height = 2;
    let mut service = service(
        source,
        Publisher::open(root.clone()).expect("restarted publisher"),
        Duration::from_secs(60),
    );
    service.cycle().await.expect("complete publication");
    assert_eq!(read_latest(&root).source_block_height, "1");
    assert!(directory.join("tiles/6/0/0.bin").exists());
}

#[tokio::test]
async fn retention_keeps_latest_and_previous_after_grace() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let generation = Arc::new(AtomicUsize::new(0));
    let mut service = service(
        SequenceSource {
            generation: Arc::clone(&generation),
        },
        Publisher::open(root.clone()).expect("publisher"),
        Duration::ZERO,
    );
    let digests = (0..3)
        .map(|value| hex_digest(&dead_metadata(value)))
        .collect::<Vec<_>>();
    for value in 0..3 {
        generation.store(value, Ordering::SeqCst);
        service.cycle().await.expect("publish generation");
    }
    assert_eq!(read_latest(&root).generation, "2");
    assert!(!scope(&root).join(&digests[0]).exists());
    assert!(scope(&root).join(&digests[1]).exists());
    assert!(scope(&root).join(&digests[2]).exists());
}

#[tokio::test]
async fn retention_grace_keeps_recent_publications() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let generation = Arc::new(AtomicUsize::new(0));
    let mut service = service(
        SequenceSource {
            generation: Arc::clone(&generation),
        },
        Publisher::open(root.clone()).expect("publisher"),
        Duration::from_secs(60),
    );
    for value in 0..3 {
        generation.store(value, Ordering::SeqCst);
        service.cycle().await.expect("publish generation");
    }
    for value in 0..3 {
        assert!(
            scope(&root)
                .join(hex_digest(&dead_metadata(value as u64)))
                .exists()
        );
    }
}

/// After a crash between promotion and cleanup, a restart keeps the latest
/// publication and the one before it, and removes unpromoted candidates.
#[tokio::test]
async fn restart_after_promotion_keeps_previous_publication() {
    let fixture = Fixture::new();
    for (generation, digest) in [(0, DIGEST0), (1, DIGEST1), (2, DIGEST2), (3, DIGEST3)] {
        fixture.ready(generation, digest);
    }
    let Fixture {
        temp: _temp,
        publisher,
    } = fixture;
    let root = publisher.root().to_owned();
    publisher
        .promote(NETWORK, CONTRACT, &pointer(1, DIGEST1))
        .expect("promote previous");
    publisher
        .promote(NETWORK, CONTRACT, &pointer(2, DIGEST2))
        .expect("promote latest");
    let mut service = service(
        FixedMetadata(fixed_metadata(2, DIGEST2)),
        publisher,
        Duration::ZERO,
    );
    service.cycle().await.expect("unchanged cycle");
    assert!(!scope(&root).join(DIGEST0).exists());
    assert!(scope(&root).join(DIGEST1).exists());
    assert!(scope(&root).join(DIGEST2).exists());
    assert!(!scope(&root).join(DIGEST3).exists());
}

#[tokio::test]
async fn failed_cycles_retry_each_poll_and_preserve_published_status() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let Fixture {
        temp: _temp,
        publisher,
    } = fixture;
    publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
        .expect("promote ready fixture");
    let status = Arc::new(RwLock::new(initial_status()));
    let mut service = IndexerService::new(
        config(Duration::from_secs(60)),
        FailThenMetadata {
            attempts: Arc::new(AtomicUsize::new(0)),
        },
        publisher,
        Arc::clone(&status),
    );
    for attempt in 1..=2 {
        assert_eq!(service.step().await, Duration::from_millis(1));
        let status = status.read().await;
        assert_eq!(status.retry.as_ref().expect("retry").attempt, attempt);
        assert_eq!(status.error_code.as_deref(), Some("SOURCE_ERROR"));
        assert!(status.published.is_some());
    }
    assert_eq!(service.step().await, Duration::from_millis(1));
    assert!(status.read().await.retry.is_none());
}

#[tokio::test]
async fn unchanged_cycles_do_not_repeat_ready_inventory_discovery() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let Fixture {
        temp: _temp,
        publisher,
    } = fixture;
    publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
        .expect("promote ready fixture");
    let missing_after_startup = scope(publisher.root())
        .join(DIGEST0)
        .join(format!("tiles/{MAX_ZOOM}/0/0.bin"));
    let mut service = service(
        FixedMetadata(fixed_metadata(0, DIGEST0)),
        publisher,
        Duration::from_secs(60),
    );
    service.cycle().await.expect("startup reconciliation");
    fs::remove_file(missing_after_startup).expect("remove tile after startup validation");
    service.cycle().await.expect("first unchanged cycle");
    service.cycle().await.expect("second unchanged cycle");
}

#[tokio::test]
async fn http_enforces_paths_headers_etags_cors_and_live_status() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.latest().parent().expect("scope")).expect("scope");
    fs::write(fixture.latest(), b"latest").expect("latest");
    let status = Arc::new(RwLock::new(initial_status()));
    status.write().await.heartbeat_at = "2026-08-28T12:00:00.000Z".into();
    let service = HttpService::new(
        fixture.publisher.root().to_owned(),
        Arc::clone(&status),
        NETWORK.into(),
        CONTRACT.into(),
        ["http://localhost:5173".into()],
    );
    let ok = service.handle(format!("GET /v1/worlds/{NETWORK}/{CONTRACT}/latest.json HTTP/1.1\r\nOrigin: http://localhost:5173\r\n\r\n").as_bytes()).await;
    let text = String::from_utf8(ok).expect("response");
    assert!(
        text.contains("HTTP/1.1 200 OK")
            && text.contains("Cache-Control: no-cache")
            && text.contains("ETag: \"")
            && text.contains("Access-Control-Allow-Origin: http://localhost:5173")
    );
    assert!(text.contains("Vary: Origin"));
    fs::create_dir_all(fixture.digest_dir(DIGEST0)).expect("immutable directory");
    fs::write(
        fixture.digest_dir(DIGEST0).join("manifest.json"),
        b"immutable",
    )
    .expect("immutable file");
    let immutable_path = format!("/v1/worlds/{NETWORK}/{CONTRACT}/{DIGEST0}/manifest.json");
    let immutable = service
        .handle(format!("GET {immutable_path} HTTP/1.1\r\n\r\n").as_bytes())
        .await;
    let immutable = String::from_utf8(immutable).expect("immutable response");
    assert!(immutable.contains("Cache-Control: public, max-age=31536000, immutable"));
    let etag = immutable
        .lines()
        .find_map(|line| line.strip_prefix("ETag: "))
        .expect("etag");
    let not_modified = service
        .handle(
            format!("GET {immutable_path} HTTP/1.1\r\nIf-None-Match: {etag}\r\n\r\n").as_bytes(),
        )
        .await;
    assert!(not_modified.starts_with(b"HTTP/1.1 304"));
    let weak_list = service
        .handle(
            format!("GET {immutable_path} HTTP/1.1\r\nIf-None-Match: \"other\", W/{etag}\r\n\r\n")
                .as_bytes(),
        )
        .await;
    assert!(weak_list.starts_with(b"HTTP/1.1 304"));
    let wildcard = service
        .handle(format!("GET {immutable_path} HTTP/1.1\r\nIf-None-Match: *\r\n\r\n").as_bytes())
        .await;
    assert!(wildcard.starts_with(b"HTTP/1.1 304"));
    let traversal = service
        .handle(b"GET /v1/worlds/../../etc/passwd HTTP/1.1\r\n\r\n")
        .await;
    assert!(traversal.starts_with(b"HTTP/1.1 404"));
    let denied = service.handle(format!("GET /v1/worlds/{NETWORK}/{CONTRACT}/status.json HTTP/1.1\r\nOrigin: https://evil.example\r\n\r\n").as_bytes()).await;
    assert!(denied.starts_with(b"HTTP/1.1 403"));
    let other_scope = service
        .handle(
            format!(
                "GET /v1/worlds/{}/{CONTRACT}/status.json HTTP/1.1\r\n\r\n",
                "f".repeat(64)
            )
            .as_bytes(),
        )
        .await;
    assert!(other_scope.starts_with(b"HTTP/1.1 404"));
    let truncated = service
        .handle(format!("GET {immutable_path} HTTP/1.1\r\nHost: local").as_bytes())
        .await;
    assert!(truncated.starts_with(b"HTTP/1.1 400"));
    let status_response = service
        .handle(
            format!("GET /v1/worlds/{NETWORK}/{CONTRACT}/status.json HTTP/1.1\r\n\r\n").as_bytes(),
        )
        .await;
    let status_body = std::str::from_utf8(&status_response)
        .expect("status response")
        .split("\r\n\r\n")
        .nth(1)
        .expect("status body");
    let served_status: game_of_life_indexer::LifeStatus =
        serde_json::from_str(status_body).expect("status JSON");
    assert_eq!(served_status.heartbeat_at, "2026-08-28T12:00:00.000Z");
    let before = status.read().await.heartbeat_at.clone();
    tokio::spawn(heartbeat_with_interval(
        Arc::clone(&status),
        Duration::from_millis(5),
    ));
    tokio::time::sleep(Duration::from_millis(12)).await;
    assert_ne!(status.read().await.heartbeat_at, before);
}

#[tokio::test]
async fn socket_http_parser_handles_fragmentation_overflow_truncation_and_timeout() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let latest = root
        .join("v1/worlds")
        .join(NETWORK)
        .join(CONTRACT)
        .join("latest.json");
    fs::create_dir_all(latest.parent().expect("scope")).expect("scope");
    fs::write(&latest, b"latest").expect("latest");
    let service = Arc::new(
        HttpService::new(
            root,
            Arc::new(RwLock::new(initial_status())),
            NETWORK.into(),
            CONTRACT.into(),
            Vec::<String>::new(),
        )
        .with_read_timeout_for_test(Duration::from_millis(30)),
    );
    let path = format!("/v1/worlds/{NETWORK}/{CONTRACT}/latest.json");

    let fragmented = socket_response(
        Arc::clone(&service),
        vec![
            format!("GET {path} HTTP/1.1\r\nHo").into_bytes(),
            b"st: localhost\r\n".to_vec(),
            b"\r\n".to_vec(),
        ],
        false,
    )
    .await;
    assert!(fragmented.starts_with(b"HTTP/1.1 200"));

    let oversized = socket_response(
        Arc::clone(&service),
        vec![
            format!("GET {path} HTTP/1.1\r\nX-Fill: ").into_bytes(),
            vec![b'a'; 8 * 1024],
            vec![b'b'; 8 * 1024],
            b"\r\n\r\n".to_vec(),
        ],
        false,
    )
    .await;
    assert!(oversized.starts_with(b"HTTP/1.1 431"));

    let incomplete = socket_response(
        Arc::clone(&service),
        vec![format!("GET {path} HTTP/1.1\r\nHost: local").into_bytes()],
        true,
    )
    .await;
    assert!(incomplete.starts_with(b"HTTP/1.1 400"));

    let timeout = socket_response(service, Vec::new(), false).await;
    assert!(timeout.starts_with(b"HTTP/1.1 408"));
}

async fn socket_response(
    service: Arc<HttpService>,
    fragments: Vec<Vec<u8>>,
    shutdown_write: bool,
) -> Vec<u8> {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("listener address");
    let client = TcpStream::connect(address);
    let server = listener.accept();
    let (client, server) = tokio::join!(client, server);
    let mut client = client.expect("client");
    let (server, _) = server.expect("server");
    let task = tokio::spawn(async move {
        service
            .serve_connection_for_test(server)
            .await
            .expect("serve connection");
    });
    for fragment in fragments {
        if client.write_all(&fragment).await.is_err() {
            break;
        }
        tokio::task::yield_now().await;
    }
    if shutdown_write {
        client.shutdown().await.expect("shutdown request");
    }
    let mut response = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(1), client.read_to_end(&mut response))
        .await
        .expect("response timeout");
    if let Err(error) = read {
        assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
        assert!(!response.is_empty(), "connection reset before response");
    }
    task.await.expect("server task");
    response
}

struct Fixture {
    temp: tempfile::TempDir,
    publisher: Publisher,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("tempdir");
        let publisher = Publisher::open(temp.path().join("artifacts")).expect("publisher");
        Self { temp, publisher }
    }
    fn scope(&self) -> std::path::PathBuf {
        self.publisher
            .root()
            .join("v1/worlds")
            .join(NETWORK)
            .join(CONTRACT)
    }
    fn latest(&self) -> std::path::PathBuf {
        self.scope().join("latest.json")
    }
    fn digest_dir(&self, digest: &str) -> std::path::PathBuf {
        self.scope().join(digest)
    }
    fn ready(&self, generation: u64, digest: &str) {
        let base = self.digest_dir(digest);
        fs::create_dir_all(base.join("tiles")).expect("tiles");
        let identity = SnapshotIdentity {
            epoch: 0,
            width: 10_000,
            height: 10_000,
            network_id: NETWORK.into(),
            contract_address: CONTRACT.into(),
            generation,
            seed: 7,
            population: 0,
            state_digest: decode_digest(digest),
        };
        fs::write(
            base.join("manifest.json"),
            serde_json::to_vec(&LifeManifest::new(&identity)).expect("manifest json"),
        )
        .expect("manifest");
        fs::write(
            base.join("provenance.json"),
            serde_json::to_vec(&provenance(generation, digest)).expect("provenance json"),
        )
        .expect("provenance");
        for z in 0..=MAX_ZOOM {
            let count = 10_000u32.div_ceil(256 * (1u32 << (MAX_ZOOM - z)));
            let length = if z == MAX_ZOOM { 8_192 } else { 131_072 };
            for x in 0..count {
                fs::create_dir_all(base.join(format!("tiles/{z}/{x}"))).expect("tile parent");
                for y in 0..count {
                    File::create(base.join(format!("tiles/{z}/{x}/{y}.bin")))
                        .and_then(|file| file.set_len(length))
                        .expect("sparse tile");
                }
            }
        }
    }
}

fn pointer(generation: u64, digest: &str) -> LatestPointer {
    LatestPointer {
        epoch: "0".into(),
        schema_version: 1,
        generation: generation.to_string(),
        state_digest: digest.into(),
        manifest_url: format!("/v1/worlds/{NETWORK}/{CONTRACT}/{digest}/manifest.json"),
        source_block_height: "9".into(),
        source_block_hash: format!("0x{}", "f".repeat(64)),
        published_at: "2026-08-28T12:00:00.000Z".into(),
    }
}
fn provenance(generation: u64, digest: &str) -> LifeProvenance {
    LifeProvenance {
        schema_version: 1,
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        epoch: "0".into(),
        generation: generation.to_string(),
        seed: "7".into(),
        population: "0".into(),
        state_digest: digest.into(),
        source_block_height: "9".into(),
        source_block_hash: format!("0x{}", "f".repeat(64)),
        verified_at: "2026-08-28T12:00:00.000Z".into(),
    }
}
fn decode_digest(value: &str) -> [u8; 32] {
    hex::decode(&value[2..])
        .expect("hex")
        .try_into()
        .expect("digest")
}
fn hex_digest(metadata: &SnapshotMetadata) -> String {
    format!("0x{}", hex::encode(metadata.state_digest))
}
fn scope(root: &std::path::Path) -> PathBuf {
    root.join("v1/worlds").join(NETWORK).join(CONTRACT)
}
fn read_latest(root: &std::path::Path) -> LatestPointer {
    LatestPointer::from_json_for(
        &fs::read(scope(root).join("latest.json")).expect("latest"),
        NETWORK,
        CONTRACT,
    )
    .expect("valid latest")
}

fn config(retention_grace: Duration) -> ServiceConfig {
    ServiceConfig {
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        poll_interval: Duration::from_millis(1),
        retention_grace,
    }
}

fn service<S: ChainSource>(
    source: S,
    publisher: Publisher,
    retention_grace: Duration,
) -> IndexerService<S> {
    IndexerService::new(
        config(retention_grace),
        source,
        publisher,
        Arc::new(RwLock::new(initial_status())),
    )
}

/// Installs a verified snapshot without promoting it, as a crash would leave it.
fn install_without_promotion(root: &std::path::Path, metadata: &SnapshotMetadata, height: u64) {
    let provenance = LifeProvenance {
        schema_version: 1,
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        epoch: metadata.epoch.to_string(),
        generation: metadata.generation.to_string(),
        seed: metadata.seed.to_string(),
        population: metadata.population.to_string(),
        state_digest: hex_digest(metadata),
        source_block_height: height.to_string(),
        source_block_hash: format!("0x{}", "01".repeat(32)),
        verified_at: "2026-08-28T12:00:00.000Z".into(),
    };
    let snapshot = build_snapshot(
        metadata,
        NETWORK.into(),
        CONTRACT.into(),
        dead_chunks(),
        provenance,
    )
    .expect("snapshot");
    let publisher = Publisher::open(root.to_owned()).expect("first publisher");
    publisher
        .publish_snapshot(
            NETWORK,
            CONTRACT,
            &hex_digest(metadata),
            &snapshot.artifacts,
        )
        .expect("install");
}

fn fixed_metadata(generation: u64, digest: &str) -> SnapshotMetadata {
    SnapshotMetadata {
        epoch: 0,
        size: WORLD_SIZE,
        generation,
        seed: 7,
        population: 0,
        state_digest: decode_digest(digest),
    }
}

fn dead_metadata(generation: u64) -> SnapshotMetadata {
    let world = vec![0; WORLD_SIZE as usize * (CHUNK_BYTES + TAIL_BYTES)];
    SnapshotMetadata {
        epoch: 0,
        size: WORLD_SIZE,
        generation,
        seed: 0,
        population: 0,
        state_digest: WorldDigest::of_world(WORLD_SIZE, WORLD_SIZE, 0, generation, &world),
    }
}

fn dead_chunks() -> Vec<ChunkResponse> {
    let mut chunks = Vec::with_capacity((WORLD_SIZE * CHUNKS_PER_ROW) as usize);
    for row in 0..WORLD_SIZE {
        for part in 0..CHUNKS_PER_ROW {
            chunks.push(ChunkResponse {
                row,
                part,
                bytes: vec![0; if part == 0 { CHUNK_BYTES } else { TAIL_BYTES }],
            });
        }
    }
    chunks
}

struct MixedSource;

#[async_trait]
impl ChainSource for MixedSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        Ok(dead_metadata(0))
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        Ok(CoherentDownload {
            metadata: dead_metadata(1),
            chunks: Vec::new(),
            source_block_height: 1,
            source_block_hash: [1; 32],
        })
    }
}

struct DeadSource {
    metadata: SnapshotMetadata,
    height: u64,
}

impl DeadSource {
    fn new(metadata: SnapshotMetadata) -> Self {
        Self {
            metadata,
            height: 1,
        }
    }
}

#[async_trait]
impl ChainSource for DeadSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        Ok(self.metadata.clone())
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        Ok(CoherentDownload {
            metadata: self.metadata.clone(),
            chunks: dead_chunks(),
            source_block_height: self.height,
            source_block_hash: [self.height as u8 * 4; 32],
        })
    }
}

/// Serves a dead world whose generation the test controls.
struct SequenceSource {
    generation: Arc<AtomicUsize>,
}

#[async_trait]
impl ChainSource for SequenceSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        Ok(dead_metadata(self.generation.load(Ordering::SeqCst) as u64))
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        let generation = self.generation.load(Ordering::SeqCst) as u64;
        Ok(CoherentDownload {
            metadata: dead_metadata(generation),
            chunks: dead_chunks(),
            source_block_height: generation + 1,
            source_block_hash: [generation as u8 + 1; 32],
        })
    }
}

struct StatusObservingSource {
    inner: DeadSource,
    status: Arc<RwLock<LifeStatus>>,
    downloads: Arc<AtomicUsize>,
}

#[async_trait]
impl ChainSource for StatusObservingSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        self.inner.metadata().await
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        let status = self.status.read().await;
        let progress = status.preparing.as_ref().expect("download progress");
        assert_eq!(status.state, IndexerState::Preparing);
        assert_eq!(progress.unit, ProgressUnit::Chunks);
        assert_eq!(progress.completed_units, 0);
        assert_eq!(progress.total_units, 20_000);
        drop(status);
        self.downloads.fetch_add(1, Ordering::SeqCst);
        self.inner.download().await
    }
}

/// Reports fixed metadata. Downloads fail, so only unchanged cycles succeed.
struct FixedMetadata(SnapshotMetadata);

#[async_trait]
impl ChainSource for FixedMetadata {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        Ok(self.0.clone())
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        Err(SourceError::Mixed("download should not run".into()))
    }
}

struct FailThenMetadata {
    attempts: Arc<AtomicUsize>,
}

#[async_trait]
impl ChainSource for FailThenMetadata {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        if self.attempts.fetch_add(1, Ordering::SeqCst) < 2 {
            Err(SourceError::Rpc {
                operation: "metadata",
                message: "injected".into(),
            })
        } else {
            Ok(fixed_metadata(0, DIGEST0))
        }
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        Err(SourceError::Mixed("download should not run".into()))
    }
}
