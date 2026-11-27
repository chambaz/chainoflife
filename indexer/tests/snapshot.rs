use game_of_life_core::digest::WorldDigest;
use game_of_life_core::prng::SplitMix64;
use game_of_life_indexer::{
    CHUNK_BYTES, ChunkResponse, Error, LifeManifest, LifeProvenance, SnapshotMetadata,
    build_snapshot, reconstruct_canonical_world,
};
use sha2::{Digest, Sha256};

const NETWORK_ID: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const CONTRACT: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const BLOCK_HASH: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
const WORLD_WIDTH: u32 = 10_000;
const WORLD_HEIGHT: u32 = 10_000;
const CHUNKS_PER_ROW: u32 = 2;

#[test]
fn small_padded_world_has_exact_tiles_and_distinct_reset_identity() {
    let mut chunks = Vec::new();
    let mut world = Vec::new();
    for row in 0..100 {
        let mut bytes = vec![255; 13];
        bytes[12] = 15;
        world.extend_from_slice(&bytes);
        chunks.push(ChunkResponse {
            row,
            part: 0,
            bytes,
        });
    }
    let metadata = SnapshotMetadata {
        epoch: 2,
        size: 100,
        generation: 0,
        seed: 0,
        population: 10_000,
        state_digest: WorldDigest::of_world(100, 100, 2, 0, &world),
    };
    let snapshot = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks.clone(),
        provenance(&metadata),
    )
    .unwrap();
    assert_eq!(snapshot.manifest.width, 100);
    assert_eq!(snapshot.manifest.epoch, "2");
    assert_eq!(snapshot.artifacts.len(), 9); // One tile per zoom, manifest, provenance.
    let cells = artifact(&snapshot, "tiles/6/0/0.bin");
    assert_eq!(cells[12], 15);
    assert!(cells[13..32].iter().all(|byte| *byte == 0));
    let mut other_epoch = metadata.clone();
    other_epoch.epoch += 1;
    assert!(matches!(
        reconstruct_canonical_world(&other_epoch, chunks.clone()),
        Err(Error::Digest { .. })
    ));
    let mut padded = chunks.clone();
    padded[0].bytes[12] |= 128;
    assert!(matches!(
        reconstruct_canonical_world(&metadata, padded),
        Err(Error::Schema { .. })
    ));
    chunks[0].bytes.resize(1000, 1);
    assert!(matches!(
        reconstruct_canonical_world(&metadata, chunks),
        Err(Error::Schema { .. })
    ));
}

#[test]
fn reconstruction_trims_tail_padding_and_accepts_unordered_chunks() {
    let (metadata, mut chunks) = dead_fixture();
    chunks[1].bytes.resize(CHUNK_BYTES, 0);
    chunks.reverse();

    let canonical = reconstruct_canonical_world(&metadata, chunks).expect("valid fixture");

    assert_eq!(canonical.len(), 12_500_000);
}

#[test]
fn reconstruction_accepts_canonical_tail_length() {
    let (metadata, chunks) = dead_fixture();

    let canonical = reconstruct_canonical_world(&metadata, chunks).expect("canonical tails");

    assert_eq!(canonical.len(), 12_500_000);
}

#[test]
fn reconstruction_rejects_short_and_long_chunk_payloads() {
    let (metadata, mut chunks) = dead_fixture();
    chunks[0].bytes.pop();
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("short head must fail"),
        Error::ChunkLength {
            row: 0,
            part: 0,
            actual: 999,
            expected: "canonical chunk length or 1000 bytes with zero padding",
        }
    );

    let (_, mut chunks) = dead_fixture();
    chunks[1].bytes.resize(251, 0);
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("long canonical tail must fail"),
        Error::ChunkLength {
            row: 0,
            part: 1,
            actual: 251,
            expected: "canonical chunk length or 1000 bytes with zero padding",
        }
    );

    let (_, mut chunks) = dead_fixture();
    chunks[0].bytes.push(0);
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("long head must fail"),
        Error::ChunkLength {
            row: 0,
            part: 0,
            actual: 1001,
            expected: "canonical chunk length or 1000 bytes with zero padding",
        }
    );
}

#[test]
fn reconstruction_rejects_missing_and_out_of_range_chunks() {
    let (metadata, mut chunks) = dead_fixture();
    chunks.pop();
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("missing chunk must fail"),
        Error::ChunkCount {
            expected: 20_000,
            actual: 19_999,
        }
    );

    let (_, mut chunks) = dead_fixture();
    chunks[0].row = WORLD_HEIGHT;
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("row must be bounded"),
        Error::ChunkCoordinate {
            row: WORLD_HEIGHT,
            part: 0,
        }
    );

    let (_, mut chunks) = dead_fixture();
    chunks[0].part = CHUNKS_PER_ROW;
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("part must be bounded"),
        Error::ChunkCoordinate {
            row: 0,
            part: CHUNKS_PER_ROW,
        }
    );
}

#[test]
fn reconstruction_rejects_duplicate_coordinates() {
    let (metadata, mut chunks) = dead_fixture();
    chunks[2].row = 0;
    chunks[2].part = 0;

    let error = reconstruct_canonical_world(&metadata, chunks).expect_err("duplicate must fail");

    assert_eq!(error, Error::DuplicateChunk { row: 0, part: 0 });
}

#[test]
fn reconstruction_rejects_wrong_population_before_digest() {
    let (mut metadata, chunks) = dead_fixture();
    metadata.population = 1;

    let error = reconstruct_canonical_world(&metadata, chunks).expect_err("population must fail");

    assert_eq!(
        error,
        Error::Population {
            expected: 1,
            actual: 0
        }
    );
}

#[test]
fn reconstruction_rejects_wrong_digest() {
    let (mut metadata, chunks) = dead_fixture();
    metadata.state_digest[0] ^= 1;

    let error = reconstruct_canonical_world(&metadata, chunks).expect_err("digest must fail");

    assert!(matches!(error, Error::Digest { .. }));
}

#[test]
fn metadata_rejects_unsupported_sizes_and_derives_layout() {
    let (metadata, _) = dead_fixture();
    assert_eq!(metadata.chunks_per_row(), CHUNKS_PER_ROW);
    for size in [0, 99, 150, 17_500] {
        let mut candidate = metadata.clone();
        candidate.size = size;
        assert!(matches!(
            candidate.validate(),
            Err(Error::Schema { field: "size", .. })
        ));
    }
    let mut small = metadata.clone();
    small.size = 100;
    assert_eq!(small.chunks_per_row(), 1);
    assert_eq!(small.chunk_count(), 100);
    // The largest world: 1,425-byte rows, read in two parts.
    let mut largest = metadata;
    largest.size = 11_400;
    assert!(largest.validate().is_ok());
    assert_eq!(largest.row_bytes(), 1_425);
    assert_eq!(largest.chunks_per_row(), 2);
    assert_eq!(largest.chunk_count(), 22_800);
}

#[test]
fn full_dead_fixture_builds_exact_edge_tiles_and_deterministic_artifacts() {
    let (metadata, chunks) = dead_fixture();
    let first = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("first snapshot");
    let first_hashes = artifact_hashes(&first);
    drop(first);

    let (_, chunks) = dead_fixture();
    let second = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("second snapshot");

    assert_eq!(second.artifacts.len(), 2_141);
    assert_eq!(
        second.artifacts.last().unwrap().path.as_str(),
        "manifest.json"
    );
    assert_eq!(
        second.artifacts[second.artifacts.len() - 2].path.as_str(),
        "provenance.json"
    );
    assert_eq!(first_hashes, artifact_hashes(&second));

    let expected_paths: Vec<_> = (0..=6)
        .flat_map(|z| {
            let count = [1, 2, 3, 5, 10, 20, 40][z as usize];
            (0..count).flat_map(move |x| (0..count).map(move |y| format!("tiles/{z}/{x}/{y}.bin")))
        })
        .collect();
    let actual_paths: Vec<_> = second.artifacts[..2_139]
        .iter()
        .map(|artifact| artifact.path.as_str())
        .collect();
    assert_eq!(actual_paths, expected_paths);
    assert_eq!(actual_paths[1], "tiles/1/0/0.bin");
    assert_eq!(actual_paths[2], "tiles/1/0/1.bin");
    assert_eq!(actual_paths[3], "tiles/1/1/0.bin");

    for (z, length) in [(0, 131_072), (2, 131_072), (3, 65_536), (5, 65_536)] {
        let density_edge = artifact(&second, &format!("tiles/{z}/0/0.bin"));
        assert_eq!(density_edge.len(), length, "zoom {z}");
        assert!(density_edge.iter().all(|byte| *byte == 0));
    }
    let total: usize = second.artifacts.iter().map(|a| a.bytes.len()).sum();
    assert!(total < 50_000_000, "{total} bytes");
    let cell_edge = artifact(&second, "tiles/6/39/39.bin");
    assert_eq!(cell_edge.len(), 8_192);
    assert!(cell_edge.iter().all(|byte| *byte == 0));
}

#[test]
fn sparse_world_density_tiles_encode_exact_counts_across_boundaries() {
    let mut cells = vec![
        (0, 0),
        (1, 0),
        (7, 1),
        (8, 1),
        (511, 511),
        (512, 512),
        (9_998, 9_999),
        (9_999, 9_999),
    ];
    cells.extend((1_000..1_020).flat_map(|x| (1_000..1_015).map(move |y| (x, y))));
    let (metadata, chunks) = fixture_from_cells(&cells);
    let snapshot = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("sparse snapshot");

    assert_eq!(density_count(&snapshot, 5, 0, 0), 2);
    assert_eq!(density_count(&snapshot, 5, 7, 1), 1);
    assert_eq!(density_count(&snapshot, 5, 8, 1), 1);
    assert_eq!(density_count(&snapshot, 5, 511, 511), 1);
    assert_eq!(density_count(&snapshot, 5, 512, 512), 1);
    assert_eq!(density_count(&snapshot, 5, 9_999, 9_999), 2);
    assert_eq!(density_count(&snapshot, 0, 1_000, 1_000), 300);
    assert_eq!(density_bytes(&snapshot, 0, 1_000, 1_000), [44, 1]);
    // A full 8x8 block is the largest one-byte count.
    assert_eq!(density_bytes(&snapshot, 3, 1_000, 1_000), [64]);
    assert_eq!(density_count(&snapshot, 4, 1_000, 1_000), 16);
    assert_eq!(density_bytes(&snapshot, 2, 1_000, 1_000), [64, 0]);

    let right_bottom = artifact(&snapshot, "tiles/5/19/19.bin");
    assert_eq!(density_tile_value(right_bottom, 135, 135), 2);
    assert_eq!(density_tile_value(right_bottom, 136, 135), 0);
    assert_eq!(density_tile_value(right_bottom, 135, 136), 0);
}

#[test]
fn manifest_json_is_compact_strict_and_confined() {
    let (metadata, _) = dead_fixture();
    let identity = game_of_life_indexer::SnapshotIdentity {
        epoch: 0,
        width: metadata.size,
        height: metadata.size,
        network_id: NETWORK_ID.into(),
        contract_address: CONTRACT.into(),
        generation: metadata.generation,
        seed: metadata.seed,
        population: metadata.population,
        state_digest: metadata.state_digest,
    };
    let manifest = LifeManifest::new(&identity);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    assert!(!bytes.contains(&b'\n'));
    assert_eq!(LifeManifest::from_json(&bytes).unwrap(), manifest);

    let mut value = serde_json::to_value(&manifest).unwrap();
    value["tilePathTemplate"] = "../tiles/{z}/{x}/{y}.bin".into();
    assert!(LifeManifest::from_json(&serde_json::to_vec(&value).unwrap()).is_err());
    value["tilePathTemplate"] = "tiles/{z}/{x}/{y}.bin".into();
    value["unknown"] = true.into();
    assert!(LifeManifest::from_json(&serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
#[ignore = "full random 100-million-cell fixture; run in release mode"]
fn full_seed_zero_fixture_matches_contract_and_is_deterministic() {
    let (metadata, chunks) = seed_zero_fixture();
    assert_eq!(metadata.population, 49_999_272);
    assert_eq!(
        hex::encode(metadata.state_digest),
        "64a81a157cfb3bd83276eaab7a15b0a44a9ec7d8eac04bc117b78a01212cf4e5"
    );
    let first = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("seed-zero snapshot");
    let hashes = artifact_hashes(&first);
    drop(first);

    let (_, chunks) = seed_zero_fixture();
    let second = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("repeat seed-zero snapshot");
    assert_eq!(hashes, artifact_hashes(&second));

    let edge = artifact(&second, "tiles/6/39/0.bin");
    for row in edge.as_chunks::<32>().0 {
        assert!(row[2..].iter().all(|byte| *byte == 0));
    }
}

fn dead_fixture() -> (SnapshotMetadata, Vec<ChunkResponse>) {
    fixture_with_fill(|_| {})
}

fn seed_zero_fixture() -> (SnapshotMetadata, Vec<ChunkResponse>) {
    let mut rng = SplitMix64::new(0);
    fixture_with_fill(|bytes| rng.fill_bytes(bytes))
}

fn fixture_with_fill(mut fill: impl FnMut(&mut [u8])) -> (SnapshotMetadata, Vec<ChunkResponse>) {
    let mut chunks = Vec::with_capacity((WORLD_HEIGHT * CHUNKS_PER_ROW) as usize);
    let mut world = Vec::new();
    let mut population = 0u64;
    for row in 0..WORLD_HEIGHT {
        for part in 0..CHUNKS_PER_ROW {
            let canonical_length = if part == 0 { CHUNK_BYTES } else { 250 };
            let mut bytes = vec![0u8; canonical_length];
            fill(&mut bytes);
            population += bytes
                .iter()
                .map(|byte| u64::from(byte.count_ones()))
                .sum::<u64>();
            world.extend_from_slice(&bytes);
            chunks.push(ChunkResponse { row, part, bytes });
        }
    }
    (
        SnapshotMetadata {
            epoch: 0,
            size: WORLD_WIDTH,
            generation: 0,
            seed: 0,
            population,
            state_digest: WorldDigest::of_world(WORLD_WIDTH, WORLD_HEIGHT, 0, 0, &world),
        },
        chunks,
    )
}

fn fixture_from_cells(cells: &[(u32, u32)]) -> (SnapshotMetadata, Vec<ChunkResponse>) {
    let (_, mut chunks) = dead_fixture();
    for &(x, y) in cells {
        let byte_in_row = x as usize / 8;
        let part = usize::from(byte_in_row >= CHUNK_BYTES);
        let chunk = &mut chunks[y as usize * CHUNKS_PER_ROW as usize + part];
        chunk.bytes[byte_in_row % CHUNK_BYTES] |= 1 << (x % 8);
    }

    let mut world = Vec::new();
    let mut population = 0;
    for chunk in &chunks {
        population += chunk
            .bytes
            .iter()
            .map(|byte| u64::from(byte.count_ones()))
            .sum::<u64>();
        world.extend_from_slice(&chunk.bytes);
    }
    (
        SnapshotMetadata {
            epoch: 0,
            size: WORLD_WIDTH,
            generation: 0,
            seed: 0,
            population,
            state_digest: WorldDigest::of_world(WORLD_WIDTH, WORLD_HEIGHT, 0, 0, &world),
        },
        chunks,
    )
}

fn provenance(metadata: &SnapshotMetadata) -> LifeProvenance {
    LifeProvenance {
        epoch: metadata.epoch.to_string(),
        schema_version: 2,
        network_id: NETWORK_ID.into(),
        contract_address: CONTRACT.into(),
        generation: metadata.generation.to_string(),
        seed: metadata.seed.to_string(),
        population: metadata.population.to_string(),
        state_digest: format!("0x{}", hex::encode(metadata.state_digest)),
        source_block_height: "42".into(),
        source_block_hash: BLOCK_HASH.into(),
        verified_at: "2026-08-28T12:00:00Z".into(),
    }
}

fn artifact<'a>(snapshot: &'a game_of_life_indexer::Snapshot, path: &str) -> &'a [u8] {
    &snapshot
        .artifacts
        .iter()
        .find(|artifact| artifact.path.as_str() == path)
        .unwrap()
        .bytes
}

fn artifact_hashes(snapshot: &game_of_life_indexer::Snapshot) -> Vec<(String, [u8; 32])> {
    snapshot
        .artifacts
        .iter()
        .map(|artifact| {
            (
                artifact.path.as_str().to_owned(),
                Sha256::digest(&artifact.bytes).into(),
            )
        })
        .collect()
}

fn density_count(snapshot: &game_of_life_indexer::Snapshot, z: u8, x: u32, y: u32) -> u16 {
    let bytes = density_bytes(snapshot, z, x, y);
    u16::from_le_bytes([bytes[0], bytes.get(1).copied().unwrap_or(0)])
}

/// The bytes of the texel covering cell `(x, y)`: one at zoom 3 and above, two below.
fn density_bytes(snapshot: &game_of_life_indexer::Snapshot, z: u8, x: u32, y: u32) -> Vec<u8> {
    let cells_per_texel = 1u32 << (6 - z);
    let texel_x = x / cells_per_texel;
    let texel_y = y / cells_per_texel;
    let tile_x = texel_x / 256;
    let tile_y = texel_y / 256;
    let bytes = artifact(snapshot, &format!("tiles/{z}/{tile_x}/{tile_y}.bin"));
    let width = if z >= 3 { 1 } else { 2 };
    let offset = ((texel_y % 256) * 256 + texel_x % 256) as usize * width;
    bytes[offset..offset + width].to_vec()
}

/// A texel of a one-byte (zoom 3 to 5) density tile.
fn density_tile_value(bytes: &[u8], x: u32, y: u32) -> u8 {
    bytes[(y * 256 + x) as usize]
}
