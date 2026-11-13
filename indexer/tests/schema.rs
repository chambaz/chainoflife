use game_of_life_indexer::{LatestPointer, LifeManifest, LifeProvenance, SnapshotIdentity};

const NETWORK: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const CONTRACT: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const DIGEST: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BLOCK: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn latest_pointer_context_validation_requires_exact_canonical_scope() {
    let canonical = format!("/v1/worlds/{NETWORK}/{CONTRACT}/{DIGEST}/manifest.json");
    let valid = latest(canonical.clone());
    assert!(valid.validate_for(NETWORK, CONTRACT).is_ok());
    let bytes = serde_json::to_vec(&valid).unwrap();
    assert_eq!(
        LatestPointer::from_json_for(&bytes, NETWORK, CONTRACT).unwrap(),
        valid
    );

    let other_network = "9999999999999999999999999999999999999999999999999999999999999999";
    let other_contract = "0x9999999999999999999999999999999999999999999999999999999999999999";
    assert!(valid.validate_for(other_network, CONTRACT).is_err());
    assert!(valid.validate_for(NETWORK, other_contract).is_err());

    for path in [
        canonical.replace("/v1/", "/v2/"),
        canonical.replace(NETWORK, &format!("{NETWORK}%2f..")),
        canonical.replace(CONTRACT, &format!("{CONTRACT}\\..")),
        canonical.replace("/worlds/", "//worlds/"),
        format!("https://host{canonical}"),
        format!("//host{canonical}"),
        format!("{canonical}?x=1"),
        format!("{canonical}#x"),
        format!("{canonical}/.."),
    ] {
        let invalid = latest(path.clone());
        assert!(
            invalid.validate_for(NETWORK, CONTRACT).is_err(),
            "accepted {path}"
        );
    }
}

#[test]
fn provenance_has_exact_fields_and_rejects_noncanonical_values() {
    let valid = provenance();
    let bytes = serde_json::to_vec(&valid).unwrap();
    assert_eq!(LifeProvenance::from_json(&bytes).unwrap(), valid);
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let mut keys = value
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        [
            "contractAddress",
            "epoch",
            "generation",
            "networkId",
            "population",
            "schemaVersion",
            "seed",
            "sourceBlockHash",
            "sourceBlockHeight",
            "stateDigest",
            "verifiedAt",
        ]
    );

    for (field, invalid) in [
        ("schemaVersion", serde_json::json!(1)),
        ("generation", serde_json::json!("01")),
        ("stateDigest", serde_json::json!(DIGEST.to_uppercase())),
        ("sourceBlockHash", serde_json::json!("0x01")),
        ("verifiedAt", serde_json::json!("2026-08-28")),
        ("transactionHash", serde_json::json!(DIGEST)),
    ] {
        let mut candidate = value.clone();
        candidate[field] = invalid;
        assert!(
            LifeProvenance::from_json(&serde_json::to_vec(&candidate).unwrap()).is_err(),
            "accepted {field}"
        );
    }
}

#[test]
fn manifest_rejects_population_above_world_capacity() {
    let manifest = LifeManifest::new(&SnapshotIdentity {
        epoch: 0,
        width: 10_000,
        height: 10_000,
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        generation: 0,
        seed: 0,
        population: 100_000_001,
        state_digest: [0xaa; 32],
    });
    assert!(manifest.validate().is_err());
}

#[test]
fn latest_pointer_rejects_noncanonical_decimal_unknown_fields_and_invalid_dates() {
    let canonical = format!("/v1/worlds/{NETWORK}/{CONTRACT}/{DIGEST}/manifest.json");
    let valid = serde_json::to_value(latest(canonical)).unwrap();
    let parse = |value: &serde_json::Value| {
        LatestPointer::from_json_for(&serde_json::to_vec(value).unwrap(), NETWORK, CONTRACT)
    };
    assert!(parse(&valid).is_ok());

    for (field, value) in [
        ("generation", "01"),
        ("publishedAt", "2026-02-30T01:02:03Z"),
        ("publishedAt", "2026-08-28T01:02:03+00:00"),
        ("publishedAt", "2026-08-28"),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value.into();
        assert!(parse(&invalid).is_err(), "accepted {field}={value}");
    }
    let mut invalid = valid;
    invalid["extra"] = true.into();
    assert!(parse(&invalid).is_err());
}

fn latest(manifest_url: String) -> LatestPointer {
    LatestPointer {
        epoch: "0".into(),
        schema_version: 2,
        generation: "7".into(),
        state_digest: DIGEST.into(),
        manifest_url,
        source_block_height: "9".into(),
        source_block_hash: BLOCK.into(),
        published_at: "2026-08-28T01:02:03.456Z".into(),
    }
}

fn provenance() -> LifeProvenance {
    LifeProvenance {
        schema_version: 2,
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        epoch: "0".into(),
        generation: "1".into(),
        seed: "0".into(),
        population: "1".into(),
        state_digest: DIGEST.into(),
        source_block_height: "9".into(),
        source_block_hash: BLOCK.into(),
        verified_at: "2026-08-28T01:02:03Z".into(),
    }
}
