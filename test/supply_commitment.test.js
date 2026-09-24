import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canClaimSupplyCommitment, supplyCommitmentKey } from '../src/agent/library/society.js';

test('one recipient need has one shared claim even when donors offer different food', () => {
    const bread = { target: 'Maja', item: 'bread', reason: 'hrana' };
    const apple = { target: 'Maja', item: 'apple', reason: 'hrana' };
    const otherMember = { target: 'Blaz', item: 'bread', reason: 'hrana' };
    assert.equal(supplyCommitmentKey(bread), supplyCommitmentKey(apple));
    assert.notEqual(supplyCommitmentKey(bread), supplyCommitmentKey(otherMember));
});

test('active lease prevents duplicate delivery and expires after a stopped donor', () => {
    const now = 1_000_000;
    const claimed = { status: 'claimed', claimedAt: now, leaseUntil: now + 240_000 };
    assert.equal(canClaimSupplyCommitment(claimed, now + 60_000), false);
    assert.equal(canClaimSupplyCommitment(claimed, now + 240_000), true);
    assert.equal(canClaimSupplyCommitment({ ...claimed, status: 'failed', leaseUntil: now }, now), true);
});

test('verified delivery suppresses repeat offers for five minutes', () => {
    const delivered = { status: 'delivered', deliveredAt: 1_000_000, leaseUntil: 1_000_000 };
    assert.equal(canClaimSupplyCommitment(delivered, 1_000_000 + 299_999), false);
    assert.equal(canClaimSupplyCommitment(delivered, 1_000_000 + 300_000), true);
});
