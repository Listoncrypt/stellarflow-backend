# Security

## Formally Verified Properties

The vesting arithmetic in [`contracts/stream/src/vesting_math.rs`](contracts/stream/src/vesting_math.rs) is formally verified using [Kani](https://model-checking.github.io/kani/), a Rust model checker backed by CBMC. Verification runs automatically in CI and any invariant violation fails the build.

### Verified Invariants

| # | Property | Function | Description |
|---|----------|----------|-------------|
| 1 | **claimable ≤ deposit** | `compute_claimable` | The claimable amount at any point in time never exceeds the original deposit, regardless of when the query occurs. |
| 1b | **claimable ≤ deposit (post-withdrawal)** | `compute_claimable` | After partial withdrawals (last_withdraw_time advanced), the claimable amount still cannot exceed the deposit. |
| 2 | **claimable is non-decreasing** | `compute_claimable` | For any two timestamps t₁ ≤ t₂ with identical stream parameters, claimable(t₂) ≥ claimable(t₁). The recipient's entitlement never decreases over time. |
| 3 | **claimable = 0 before cliff** | `compute_claimable` | For any timestamp strictly before `cliff_time`, the claimable amount is exactly zero. |
| 4 | **balance conservation on cancel** | `compute_total_streamed`, `compute_refund` | total_streamed + refund = deposit. No tokens are created or destroyed during cancellation. |
| 5 | **earned ≥ 0** | `compute_earned` | The earned amount is always non-negative. |
| 6 | **refund ≥ 0** | `compute_refund` | The refund amount is always non-negative. |

### Proof Bounds

Kani proofs use bounded symbolic inputs covering realistic Stellar parameters:
- **Deposit**: 1 to 1,000,000,000,000 stroops (up to 100,000 XLM equivalent)
- **Duration**: 1 to 315,360,000 seconds (up to 10 years)
- **Flow rate**: 1 to 1,000,000,000 stroops/second

### How It Works

The contract's vesting arithmetic is extracted into pure functions in `vesting_math.rs` with zero Soroban dependencies. The contract calls these functions directly, ensuring the verified code is the code that runs on-chain. Kani generates symbolic inputs covering all values within the bounds and uses SAT/SMT solving to exhaustively check each assertion.

## Additional Verification

### Property-Based Testing (proptest)

[`contracts/stream/src/proptest_tests.rs`](contracts/stream/src/proptest_tests.rs) uses the `proptest` crate to verify invariants at the contract level (with full Soroban VM execution) across 10,000+ random inputs per property:

- **Balance conservation**: create, cancel, and top-up preserve total token supply
- **Monotonic withdrawal**: recipient balance only increases
- **State machine validity**: pause/resume transitions are correct
- **Field correctness**: stream parameters match inputs

### Differential Fuzzing

[`contracts/stream/src/differential_fuzz.rs`](contracts/stream/src/differential_fuzz.rs) runs 1,000,000 iterations comparing the contract's vesting math against an independent reference ("SDK") implementation. Any divergence greater than 1 stroop fails the test, along with the seed and parameters for reproducibility.

### Cross-Contract Integration Tests

[`contracts/stream/src/integration_tests.rs`](contracts/stream/src/integration_tests.rs) deploys SoroStream alongside a real SAC token contract and tests the full lifecycle:

- mint → create stream → withdraw → verify balances
- Treasury/fee integration with batch withdrawals
- Auto-renewal with real token transfers
- Partial cancellation balance conservation
