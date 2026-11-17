import type { ExecutionContext, MutationOutcome, MutationPort, ReadPort } from '../../src/core/runtime/ports';

type Assert<T extends true> = T;
type Equal<T, U> = [T, U] extends [U, T] ? true : false;

type Read = ReadPort<{ id: string }, { value: number }>;
type Write = MutationPort<{ id: string; value: number }, { modified: number }>;
export type ReadContext = Assert<Equal<Parameters<Read['read']>[0], ExecutionContext>>;
export type WriteContext = Assert<Equal<Parameters<Write['write']>[0], ExecutionContext>>;
type UnknownResult = Extract<MutationOutcome<number>, { outcome: 'unknown' }>;
export type UnknownRequiresEvidence = Assert<Equal<UnknownResult, { readonly outcome: 'unknown'; readonly evidence: unknown }>>;
export type CommitCarriesResult = Assert<Equal<Extract<MutationOutcome<number>, { outcome: 'committed' }>['result'], number>>;
