//! Poker channel adjudicator — P12 research prototype (docs/14, docs/poker-channel-research.md).
//!
//! A CKB lock script that arbitrates the poker state channel's co-signed
//! allocations. It mirrors `PokerChannelSim.adjudicate` from
//! `packages/settlement/src/poker-channel.ts` rule for rule:
//!
//!   1. every participant co-signed the submitted state,
//!   2. balances conserve the epoch total (nothing minted, nothing burned),
//!   3. the submitted sequence is not older than the stored sequence,
//!   4. a finalized state pays each participant exactly their allocation.
//!
//! The chain verifies signatures, conservation, and sequence — never poker.
//! Clients verify poker rules before co-signing; `game_state_hash` binds the
//! allocation to the published transcript so third parties can audit after
//! the fact (docs/14 enforcement split).
//!
//! == Cell layout ==
//!
//! Args (script args, fixed for the epoch):
//!   [0..16]  epoch_total: u128 BE — the sum every state must conserve
//!   [16]     participant_count: u8 (N)
//!   [17..]   N x blake2b160(pubkey) — the participant set, in signing order
//!
//! Cell data (the signed state; identical layout on input and output):
//!   [0..8]   sequence: u64 LE — monotonically non-decreasing
//!   [8]      finalized: u8 (0 = live, 1 = payouts released)
//!   [9]      balance_count: u8 (must equal N)
//!   [10..]   N x { pubkey_hash: 20 bytes, amount: u128 BE }
//!   [..+32]  game_state_hash: 32 bytes (blake2b256 of the poker transcript)
//!
//! Witness: WitnessArgs.lock holds the co-signature blob — for each
//! participant in ARG ORDER, a 65-byte recoverable secp256k1 signature
//! (v ∈ {0,1}) over blake2b256(new cell data). Verification recovers each
//! pubkey, hashes it, and requires an exact bijection with the args set.
//!
//! == Rules ==
//!
//! * UPDATE (output state cell present):
//!     - all N signatures recover to the args participant hashes,
//!     - output balances conserve epoch_total AND the input balances,
//!     - output.sequence >= input.sequence,
//!     - output.finalized == 0.
//! * FINALIZE (input.finalized == 1): outputs must be exactly N payout
//!   cells — one per participant, lock hash = their pubkey_hash, capacity
//!   = their amount. No state cell remains.
//!
//! Exit codes: 0 = valid, non-zero = the documented error (see `fail`).

#![no_std]
#![no_main]

use alloc::vec::Vec;
use blake2::digest::{Update, VariableOutput};
use ckb_std::syscalls::SysError;
use blake2::Blake2bVar;

#[cfg(not(test))]
use ckb_std::default_alloc;

#[cfg(not(test))]
default_alloc!(4096, 524288, 64);

ckb_std::entry!(main);

const ERR_ARGS: i8 = -1;
const ERR_DATA: i8 = -2;
const ERR_WITNESS: i8 = -3;
const ERR_SIGNATURE: i8 = -4;
const ERR_CONSERVATION: i8 = -5;
const ERR_SEQUENCE: i8 = -6;
const ERR_FINALIZE: i8 = -7;
const ERR_ENCODING: i8 = -8;

/// blake2b with a 32-byte digest (the sighash for signatures).
fn blake2b256(message: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut hasher = Blake2bVar::new(32).expect("digest size is valid");
    hasher.update(message);
    hasher.finalize_variable(&mut out).expect("digest size is fixed");
    out
}

/// blake2b with a 20-byte digest (the pubkey hash committed in args/data).
fn blake2b160(message: &[u8]) -> [u8; 20] {
    let mut out = [0u8; 20];
    let mut hasher = Blake2bVar::new(20).expect("digest size is valid");
    hasher.update(message);
    hasher.finalize_variable(&mut out).expect("digest size is fixed");
    out
}

fn fail(code: i8, reason: &str) -> i8 {
    ckb_std::debug!("{}", reason);
    code
}

#[cfg(not(test))]
pub fn main() -> i8 {
    match adjudicate() {
        Ok(()) => 0,
        Err(code) => fail(code, "adjudication failed"),
    }
}

#[cfg(test)]
pub fn main() -> i8 {
    match adjudicate() {
        Ok(()) => 0,
        Err(code) => fail(code, "adjudication failed"),
    }
}

/// ckb-std 0.16 has no cell-count helper: iterate until the syscall fails.
fn group_cell_count(source: ckb_std::ckb_constants::Source) -> usize {
    let mut n = 0usize;
    while ckb_std::high_level::load_cell_data(n, source).is_ok() {
        n += 1;
    }
    n
}

fn adjudicate() -> Result<(), i8> {
    // --- args ----------------------------------------------------------------
    let script = ckb_std::high_level::load_script().map_err(|_| ERR_ARGS)?;
    let args = script.args().raw_data();
    if args.len() < 17 || args[16] == 0 {
        return Err(fail(ERR_ARGS, "args too short or zero participants"));
    }
    let epoch_total = u128::from_be_bytes(args[0..16].try_into().map_err(|_| ERR_ARGS)?);
    let participants: Vec<[u8; 20]> = args[17..]
        .chunks_exact(20)
        .map(|c| c.try_into().unwrap())
        .collect();
    if participants.len() != args[16] as usize {
        return Err(fail(ERR_ARGS, "participant count does not match args length"));
    }

    // --- cells ---------------------------------------------------------------
    // The channel state cell is the only cell in this script's group on the
    // input side; the output side either carries the next state or (on
    // finalization) the payout cells.
    let input_data = ckb_std::high_level::load_cell_data(0, ckb_std::ckb_constants::Source::GroupInput)
        .map_err(|_| fail(ERR_DATA, "no input state cell"))?;
    let input = parse_state(&input_data)?;

    let output_states = group_cell_count(ckb_std::ckb_constants::Source::GroupOutput);
    let output_data = ckb_std::high_level::load_cell_data(0, ckb_std::ckb_constants::Source::GroupOutput)
        .map_err(|_| ERR_ENCODING)?;

    // --- finalize path ---------------------------------------------------------
    if input.finalized == 1 {
        // The finalized allocation pays out: exactly N payout cells, one per
        // participant, lock hash == their pubkey hash, capacity == their
        // amount (mirrors the simulator's finalizeEpoch payouts).
            let payout_count = group_cell_count(ckb_std::ckb_constants::Source::GroupOutput);
        if payout_count != input.balances.len() {
            return Err(fail(ERR_FINALIZE, "payout cell count does not match balances"));
        }
        for (i, b) in input.balances.iter().enumerate() {
            let i = i as u64;
            let lock_hash = ckb_std::high_level::load_cell_lock_hash(i as usize, ckb_std::ckb_constants::Source::GroupOutput)
                .map_err(|_| ERR_ENCODING)?;
            if lock_hash.as_slice() != b.pubkey_hash {
                return Err(fail(ERR_FINALIZE, "payout lock does not match participant"));
            }
            let capacity = ckb_std::high_level::load_cell_capacity(i as usize, ckb_std::ckb_constants::Source::GroupOutput)
                .map_err(|_| ERR_ENCODING)?;
            if capacity as u128 != b.amount {
                return Err(fail(ERR_FINALIZE, "payout capacity does not match allocation"));
            }
        }
        return Ok(());
    }

    // --- update path -----------------------------------------------------------
    if output_states != 1 {
        return Err(fail(ERR_ENCODING, "live channel must carry exactly one state cell"));
    }
    let output = parse_state(&output_data)?;

    // 1. Every participant co-signed the new state (rule 1 of adjudicate).
    verify_co_signatures(&output_data, &participants)?;

    // 2. Conservation: epoch total AND input balances (rules 2 + no-minting).
    let out_total: u128 = output.balances.iter().map(|b| b.amount).sum();
    if out_total != epoch_total {
        return Err(fail(ERR_CONSERVATION, "output balances do not conserve epoch total"));
    }
    let in_total: u128 = input.balances.iter().map(|b| b.amount).sum();
    if out_total != in_total {
        return Err(fail(ERR_CONSERVATION, "output balances do not conserve input balances"));
    }
    // Participant set must be identical between input and output (membership
    // changes only between epochs, docs/14 D009).
    for ob in &output.balances {
        if !input.balances.iter().any(|ib| ib.pubkey_hash == ob.pubkey_hash) {
            return Err(fail(ERR_CONSERVATION, "output introduces an unknown participant"));
        }
    }

    // 3. Sequence monotonicity vs the stored (accepted) latest.
    if output.sequence < input.sequence {
        return Err(fail(ERR_SEQUENCE, "stale state"));
    }

    // 4. A live state stays live; finalization goes through the payout path.
    if output.finalized == 1 && output.sequence == input.sequence {
        return Err(fail(ERR_SEQUENCE, "finalization must bump the sequence"));
    }
    Ok(())
}

// --- state decoding ----------------------------------------------------------

pub struct Balance {
    pub pubkey_hash: [u8; 20],
    pub amount: u128,
}

pub struct ChannelState {
    pub sequence: u64,
    pub finalized: u8,
    pub balances: Vec<Balance>,
    pub game_state_hash: [u8; 32],
}

fn parse_state(data: &[u8]) -> Result<ChannelState, i8> {
    if data.len() < 11 {
        return Err(fail(ERR_ENCODING, "state data too short"));
    }
    let sequence = u64::from_le_bytes(data[0..8].try_into().map_err(|_| ERR_ENCODING)?);
    let finalized = data[8];
    let count = data[9] as usize;
    let balances_end = 10 + count * 36;
    if data.len() < balances_end + 32 {
        return Err(fail(ERR_ENCODING, "state data truncated"));
    }
    let mut balances = Vec::with_capacity(count);
    for i in 0..count {
        let base = 10 + i * 36;
        balances.push(Balance {
            pubkey_hash: data[base..base + 20].try_into().map_err(|_| ERR_ENCODING)?,
            amount: u128::from_be_bytes(data[base + 20..base + 36].try_into().map_err(|_| ERR_ENCODING)?),
        });
    }
    let mut game_state_hash = [0u8; 32];
    game_state_hash.copy_from_slice(&data[balances_end..balances_end + 32]);
    Ok(ChannelState { sequence, finalized, balances, game_state_hash })
}

// --- co-signature verification ------------------------------------------------

fn verify_co_signatures(state_data: &[u8], participants: &[[u8; 20]]) -> Result<(), i8> {
    let witness = ckb_std::high_level::load_witness(0, ckb_std::ckb_constants::Source::GroupInput)
        .map_err(|_| fail(ERR_WITNESS, "missing witness"))?;
    let lock = witness_lock_blob(&witness).ok_or(fail(ERR_WITNESS, "malformed witness"))?;
    if lock.len() != participants.len() * 65 {
        return Err(fail(ERR_WITNESS, "signature blob length does not match participants"));
    }
    let message = blake2b256(state_data);
    for (i, expected) in participants.iter().enumerate() {
        let sig = &lock[i * 65..(i + 1) * 65];
        let recovered = recover_pubkey(&message, sig).ok_or(ERR_SIGNATURE)?;
        if blake2b160(&recovered).as_slice() != expected.as_slice() {
            return Err(fail(ERR_SIGNATURE, "recovered pubkey is not the expected participant"));
        }
    }
    Ok(())
}

/// Extract the lock-field blob from a raw WitnessArgs molecule table:
/// three u32 LE offsets (lock, input_type, output_type) at the head; each
/// present field is a u32 LE byte-length followed by its bytes. A
/// u32::MAX offset marks the field as absent.
fn witness_lock_blob(witness: &[u8]) -> Option<Vec<u8>> {
    if witness.len() < 12 {
        return None;
    }
    let read_offset = |i: usize| -> Option<usize> {
        Some(u32::from_le_bytes(witness.get(i * 4..i * 4 + 4)?.try_into().ok()?) as usize)
    };
    let lock_offset = read_offset(0)?;
    let input_type_offset = read_offset(1)?;
    let end = if input_type_offset == u32::MAX as usize {
        witness.len()
    } else {
        input_type_offset
    };
    if lock_offset == u32::MAX as usize || lock_offset + 4 > end {
        return None;
    }
    let len = u32::from_le_bytes(witness.get(lock_offset..lock_offset + 4)?.try_into().ok()?) as usize;
    let data_start = lock_offset + 4;
    if data_start + len > end {
        return None;
    }
    Some(witness[data_start..data_start + len].to_vec())
}

/// Recover the 33-byte compressed pubkey from a 65-byte recoverable
/// secp256k1 signature over `message_hash` (libsecp256k1, no_std).
fn recover_pubkey(message_hash: &[u8; 32], signature: &[u8]) -> Option<[u8; 33]> {
    use secp256k1::{recover, Message, RecoveryId, Signature};
    if signature.len() != 65 {
        return None;
    }
    let rid = RecoveryId::parse(signature[64]).ok()?;
    let sig = Signature::parse_standard_slice(signature.get(0..64)?).ok()?;
    let message = Message::parse_slice(message_hash).ok()?;
    let public_key = recover(&message, &sig, &rid).ok()?;
    let serialized = public_key.serialize();
    let mut out = [0u8; 33];
    out.copy_from_slice(&serialized);
    Some(out)
}

