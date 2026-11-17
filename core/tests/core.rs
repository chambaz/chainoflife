use game_of_life_core::digest::{CHUNK_BYTES, WorldDigest};
use game_of_life_core::kernel::{compute_next_row, compute_next_row_width, count_cells};

#[test]
fn epoch_digest_matches_independent_sha256_vectors() {
    // Python hashlib + struct.pack('>IIQQ') reference, with two length-tagged leaves.
    for (epoch, expected) in [
        (
            0,
            "517d74c452c185937306cbcfccf9af0535fecc34a10ea60e8e85a92576e1c63e",
        ),
        (
            1,
            "fad7aa53de3e6b509b7222b6b2065c128b859efea47788e49040949cb07d5bbc",
        ),
        (
            0x0102_0304_0506_0708,
            "a0b7dccb1dae4be8d9c3d9de17e2ccd32f26ddd42517f4a06eebcd8d5b8114eb",
        ),
    ] {
        let mut digest = WorldDigest::for_epoch(100, 100, epoch, 7);
        digest.update(0, &[1, 2, 3]);
        digest.update(1, &[4, 5]);
        assert_eq!(hex(digest.finish()), expected);
    }
}

#[test]
fn padded_rows_match_scalar_toroidal_reference() {
    // Every width up to ten words covers each word boundary, tail length,
    // and position in the unrolled loops.
    for width in (1usize..=330).chain([1_000, 2_900]) {
        let height = 7;
        let bytes = width.div_ceil(8);
        let mut rng = SplitMix64::new(42);
        let mut world = vec![vec![0u8; bytes]; height];
        for row in &mut world {
            rng.fill_bytes(row);
        }
        // Deliberately leave padding set. It must never become a neighbor.
        for y in 0..height {
            let mut output = vec![255; bytes];
            let population = compute_next_row_width(
                &world[(y + height - 1) % height],
                &world[y],
                &world[(y + 1) % height],
                &mut output,
                width,
            );
            let mut expected_population = 0;
            for x in 0..width {
                let mut neighbors = 0;
                for dy in [-1isize, 0, 1] {
                    for dx in [-1isize, 0, 1] {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = (x as isize + dx).rem_euclid(width as isize) as usize;
                        let ny = (y as isize + dy).rem_euclid(height as isize) as usize;
                        neighbors += (world[ny][nx / 8] >> (nx % 8)) & 1;
                    }
                }
                let alive = ((world[y][x / 8] >> (x % 8)) & 1) == 1;
                let expected = neighbors == 3 || (alive && neighbors == 2);
                assert_eq!(
                    ((output[x / 8] >> (x % 8)) & 1) == 1,
                    expected,
                    "{width}: {x},{y}"
                );
                expected_population += u32::from(expected);
            }
            assert_eq!(population, expected_population);
            if !width.is_multiple_of(8) {
                assert_eq!(output[bytes - 1] >> (width % 8), 0);
            }
        }
    }
}
use game_of_life_core::prng::SplitMix64;

#[test]
fn splitmix64_matches_canonical_seed_zero_vectors() {
    let mut rng = SplitMix64::new(0);
    assert_eq!(rng.next_u64(), 0xE220_A839_7B1D_CDAF);
    assert_eq!(rng.next_u64(), 0x6E78_9E6A_A1B9_65F4);
    assert_eq!(rng.next_u64(), 0x06C4_5D18_8009_454F);
}

#[test]
fn byte_stream_continues_across_unaligned_chunks() {
    let mut chunked = SplitMix64::new(42);
    let mut first = [0u8; 5];
    let mut second = [0u8; 11];
    chunked.fill_bytes(&mut first);
    chunked.fill_bytes(&mut second);

    let mut contiguous = SplitMix64::new(42);
    let mut expected = [0u8; 16];
    contiguous.fill_bytes(&mut expected);

    assert_eq!([first.as_slice(), second.as_slice()].concat(), expected);
}

#[test]
fn digest_pins_field_widths_byte_order_and_actual_chunk_length() {
    // Python hashlib + struct.pack('>IIQQ') reference.
    let mut digest = WorldDigest::for_epoch(10_000, 10_000, 0, 7);
    digest.update(0, &[1, 2, 3]);
    digest.update(1, &[4, 5]);
    assert_eq!(
        hex(digest.finish()),
        "6b27c40c3785e10e7e935562ae2973a5f7b44e7fcc6b627bd86d235384f8bc50"
    );
}

#[test]
fn world_digest_steps_through_fixed_chunks_and_a_shorter_last_chunk() {
    let world: Vec<u8> = (0..CHUNK_BYTES * 2 + 5).map(|index| index as u8).collect();
    let mut digest = WorldDigest::for_epoch(100, 100, 3, 9);
    digest.update(0, &world[..CHUNK_BYTES]);
    digest.update(1, &world[CHUNK_BYTES..CHUNK_BYTES * 2]);
    digest.update(2, &world[CHUNK_BYTES * 2..]);
    assert_eq!(
        WorldDigest::of_world(100, 100, 3, 9, &world),
        digest.finish()
    );
    assert_eq!(CHUNK_BYTES, 4_096);
}

#[test]
fn full_scale_seed_vectors_are_reproducible() {
    // Independent Python SplitMix64/hashlib reference. Seed 0 also matches the
    // generation-zero digest of a local deployment.
    assert_eq!(
        initialized_world(0),
        (
            49_999_272,
            "64a81a157cfb3bd83276eaab7a15b0a44a9ec7d8eac04bc117b78a01212cf4e5".into()
        )
    );
    assert_eq!(
        initialized_world(1),
        (
            50_010_937,
            "52fa9c5e93e59ece217ba89dd49b35c1024641e9ecd0e56e9eb5b0e6849372b0".into()
        )
    );
}

#[test]
#[ignore = "full 100-million-cell reference pass; run in release mode"]
fn full_scale_generation_one_vector() {
    let mut rng = SplitMix64::new(0);
    let mut world = vec![[0u8; 1_250]; 10_000];
    for row in &mut world {
        rng.fill_bytes(row);
    }

    let mut next = Vec::with_capacity(10_000 * 1_250);
    let mut population = 0u64;
    let mut output = [0u8; 1_250];
    for y in 0..10_000 {
        population += u64::from(compute_next_row(
            &world[(y + 9_999) % 10_000],
            &world[y],
            &world[(y + 1) % 10_000],
            &mut output,
        ));
        next.extend_from_slice(&output);
    }
    // Independent Python numpy/hashlib reference. Also matches the
    // generation-one event of a local deployment.
    assert_eq!(
        (
            population,
            hex(WorldDigest::of_world(10_000, 10_000, 0, 1, &next))
        ),
        (
            27_336_807,
            "1ea48941caa8c1614bbb00c80ed6903855c174778d45725522439cc875ccde71".into()
        )
    );
}

#[test]
fn cell_count_matches_bytewise_count_at_every_length() {
    let mut rng = SplitMix64::new(7);
    let mut row = [0u8; 200];
    rng.fill_bytes(&mut row);
    for length in 0..=row.len() {
        let expected: u32 = row[..length].iter().map(|byte| byte.count_ones()).sum();
        assert_eq!(count_cells(&row[..length]), expected, "{length}");
    }
    assert_eq!(count_cells(&[0xFF; 1_250]), 10_000);
}

#[test]
fn dead_world_remains_dead_and_output_is_cleared() {
    let row = [0u8; 2];
    let mut output = [0xFF; 2];
    let population = compute_next_row(&row, &row, &row, &mut output);
    assert_eq!(population, 0);
    assert_eq!(output, [0; 2]);
}

#[test]
fn row_kernel_population_matches_output_bits() {
    let previous = [0b1000_0001];
    let current = [0b0000_0011];
    let next = [0b0100_0010];
    let mut output = [0];
    let population = compute_next_row(&previous, &current, &next, &mut output);
    assert_eq!(population, output[0].count_ones());
}

#[test]
fn standard_patterns_and_toroidal_edges_match_reference_model() {
    const H: usize = 8;
    const N: usize = 2;
    let patterns = [
        &[(3, 3)][..],
        &[(3, 2), (3, 3), (3, 4)][..],
        &[(5, 2), (6, 2), (5, 3), (6, 3)][..],
        &[(1, 0), (0, 1), (15, 1)][..],
        &[(0, 0), (15, 0), (0, 7)][..],
        &[(2, 1), (3, 2), (1, 3), (2, 3), (3, 3)][..],
    ];

    for pattern in patterns {
        let world = world_from_cells::<H, N>(pattern);
        assert_eq!(kernel_step(world), reference_step(world));
    }
}

#[test]
fn randomized_worlds_match_simple_reference_model() {
    const H: usize = 9;
    const N: usize = 3;
    let mut rng = SplitMix64::new(0xCAFE_BABE);
    for _ in 0..128 {
        let mut world = [[0u8; N]; H];
        for row in &mut world {
            rng.fill_bytes(row);
        }
        assert_eq!(kernel_step(world), reference_step(world));
    }
}

fn world_from_cells<const H: usize, const N: usize>(cells: &[(usize, usize)]) -> [[u8; N]; H] {
    let mut world = [[0u8; N]; H];
    for &(x, y) in cells {
        world[y][x / 8] |= 1 << (x % 8);
    }
    world
}

fn kernel_step<const H: usize, const N: usize>(world: [[u8; N]; H]) -> [[u8; N]; H] {
    let mut output = [[0u8; N]; H];
    for (y, output_row) in output.iter_mut().enumerate() {
        compute_next_row(
            &world[(y + H - 1) % H],
            &world[y],
            &world[(y + 1) % H],
            output_row,
        );
    }
    output
}

fn reference_step<const H: usize, const N: usize>(world: [[u8; N]; H]) -> [[u8; N]; H] {
    let width = N * 8;
    let mut output = [[0u8; N]; H];
    for (y, output_row) in output.iter_mut().enumerate() {
        for x in 0..width {
            let mut neighbors = 0;
            for dy in [H - 1, 0, 1] {
                for dx in [width - 1, 0, 1] {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    neighbors += cell(&world, (x + dx) % width, (y + dy) % H);
                }
            }
            let alive = cell(&world, x, y) != 0;
            if neighbors == 3 || (alive && neighbors == 2) {
                output_row[x / 8] |= 1 << (x % 8);
            }
        }
    }
    output
}

fn cell<const H: usize, const N: usize>(world: &[[u8; N]; H], x: usize, y: usize) -> u8 {
    (world[y][x / 8] >> (x % 8)) & 1
}

fn initialized_world(seed: u64) -> (u64, String) {
    let mut rng = SplitMix64::new(seed);
    let mut world = vec![0u8; 10_000 * 1_250];
    rng.fill_bytes(&mut world);
    let population = world
        .iter()
        .map(|byte| u64::from(byte.count_ones()))
        .sum::<u64>();
    (
        population,
        hex(WorldDigest::of_world(10_000, 10_000, 0, 0, &world)),
    )
}

fn hex(bytes: [u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
