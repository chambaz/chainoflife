use game_of_life_indexer::{
    EventKind, EvidenceKind, LatestPointer, LifeManifest, LifeProvenance, SnapshotIdentity,
};

const NETWORK: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const CONTRACT: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const DIGEST: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BLOCK: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRANSACTION: &str = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const REQUEST: &str = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const REQUESTER: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

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
fn provenance_parser_enforces_event_generation_and_cross_fields() {
    let initialized = initialized_provenance();
    let bytes = serde_json::to_vec(&initialized).unwrap();
    assert_eq!(LifeProvenance::from_json(&bytes).unwrap(), initialized);

    let mut invalid = initialized.clone();
    invalid.generation = "1".into();
    assert!(invalid.validate().is_err());
    invalid = initialized.clone();
    invalid.event_kind = Some(EventKind::GenerationAdvanced);
    assert!(invalid.validate().is_err());
    invalid = initialized.clone();
    invalid.request_id = Some(REQUEST.into());
    assert!(invalid.validate().is_err());

    let advanced = advanced_provenance();
    let bytes = serde_json::to_vec(&advanced).unwrap();
    assert_eq!(LifeProvenance::from_json(&bytes).unwrap(), advanced);
    let mut invalid = advanced.clone();
    invalid.generation = "0".into();
    assert!(invalid.validate().is_err());
    invalid = advanced.clone();
    invalid.requester = None;
    assert!(invalid.validate().is_err());

    let mut value = serde_json::to_value(advanced).unwrap();
    value["unknown"] = true.into();
    assert!(LifeProvenance::from_json(&serde_json::to_vec(&value).unwrap()).is_err());
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

fn initialized_provenance() -> LifeProvenance {
    LifeProvenance {
        epoch: "0".into(),
        schema_version: 2,
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        generation: "0".into(),
        seed: "0".into(),
        population: "1".into(),
        state_digest: DIGEST.into(),
        source_block_height: "9".into(),
        source_block_hash: BLOCK.into(),
        evidence_kind: EvidenceKind::WorldInitializedEvent,
        transaction_hash: Some(TRANSACTION.into()),
        event_index: Some(0),
        event_kind: Some(EventKind::WorldInitialized),
        request_id: None,
        requester: None,
        verified_at: "2026-08-28T01:02:03Z".into(),
    }
}

fn advanced_provenance() -> LifeProvenance {
    LifeProvenance {
        generation: "1".into(),
        evidence_kind: EvidenceKind::GenerationAdvancedEvent,
        event_kind: Some(EventKind::GenerationAdvanced),
        request_id: Some(REQUEST.into()),
        requester: Some(REQUESTER.into()),
        ..initialized_provenance()
    }
}
