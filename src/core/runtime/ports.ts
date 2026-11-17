/** Internal B01 draft. Adapter integration will validate these contracts in B02. */
export interface SourceBinding {
    readonly physicalSourceId: string;
    readonly namespace: string;
    readonly proof: 'verified' | 'connection-local';
    readonly generation: number;
    readonly codecVersion: string;
}

export interface ExecutionContext {
    readonly source: SourceBinding;
    readonly runtimeId: string;
    readonly scopeGeneration: number;
    readonly policyFingerprint: string;
    readonly projectionFingerprint: string;
    readonly operationId: string;
    readonly transactionId?: string;
    readonly origin?: string;
    readonly deadlineMs?: number;
    readonly signal?: AbortSignal;
}

export interface Lease {
    readonly source: SourceBinding;
    readonly ownership: 'owned' | 'borrowed';
    release(disposition: 'reusable' | 'discard'): Promise<void>;
}

export interface OperationAdmission {
    // Call once after the admitted operation reaches its actual settlement.
    settle(): void;
}

type UncommittedState = 'not-started' | 'pending' | 'rolled-back' | 'partial' | 'unknown';
type UncommittedOutcome = {
    [State in UncommittedState]: { readonly outcome: State; readonly evidence: unknown };
}[UncommittedState];

export type MutationOutcome<T> =
    | { readonly outcome: 'committed'; readonly result: T }
    | UncommittedOutcome;

export interface ReadPort<TRequest, TResult> {
    read(context: ExecutionContext, request: TRequest): Promise<TResult>;
}

export interface MutationPort<TRequest, TResult> {
    write(context: ExecutionContext, request: TRequest): Promise<MutationOutcome<TResult>>;
}
