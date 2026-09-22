import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from '../../core/logger';
import { ErrorCodes, createError } from '../../core/errors';

export type WritePathPolicyMode = 'allow-both' | 'model-only';
export type WritePathPolicyRawMode = 'inherit' | 'allow' | 'block';
export type WritePathPolicyManagementMode = 'inherit' | 'allow' | 'block';
export type WritePathPolicyViolationAction = 'throw' | 'warn';

export interface WritePathPolicyRule {
    mode?: WritePathPolicyMode;
    raw?: WritePathPolicyRawMode;
    management?: WritePathPolicyManagementMode;
    onViolation?: WritePathPolicyViolationAction;
}

export interface WritePathPolicyOptions {
    default?: WritePathPolicyMode | WritePathPolicyRule;
    namespaces?: Record<string, WritePathPolicyMode | WritePathPolicyRule>;
}

export type WritePathOperationCategory = 'write' | 'batch' | 'management' | 'raw';
export type WritePathSource = 'collection' | 'model' | 'legacy' | 'db' | 'client';

export interface WritePathNamespace {
    iid?: string;
    pool?: string;
    db?: string;
    collection?: string;
}

export interface NormalizedWritePathRule {
    mode: WritePathPolicyMode;
    raw: WritePathPolicyRawMode;
    management: WritePathPolicyManagementMode;
    onViolation: WritePathPolicyViolationAction;
}

export interface NormalizedWritePathPolicy {
    default: NormalizedWritePathRule;
    namespaces: Record<string, NormalizedWritePathRule>;
    enabled: boolean;
}

type ResolvedWritePathRule = {
    key: string;
    rule: NormalizedWritePathRule;
};

const DEFAULT_RULE: NormalizedWritePathRule = Object.freeze({
    mode: 'allow-both',
    raw: 'inherit',
    management: 'inherit',
    onViolation: 'throw',
});

const ALLOWED_MODES = new Set<WritePathPolicyMode>(['allow-both', 'model-only']);
const ALLOWED_RAW = new Set<WritePathPolicyRawMode>(['inherit', 'allow', 'block']);
const ALLOWED_MANAGEMENT = new Set<WritePathPolicyManagementMode>(['inherit', 'allow', 'block']);
const ALLOWED_VIOLATION_ACTIONS = new Set<WritePathPolicyViolationAction>(['throw', 'warn']);

const modelWriteSourceStorage = new AsyncLocalStorage<WritePathSource>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue<T>(record: object, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(record, key)
        ? (record as Record<string, unknown>)[key] as T
        : undefined;
}

function invalidConfig(path: string, reason: string): never {
    throw createError(
        ErrorCodes.INVALID_OPERATION,
        `Invalid writePathPolicy config at ${path}: ${reason}`,
        [{ path, reason }],
    );
}

function normalizeRule(
    input: WritePathPolicyMode | WritePathPolicyRule | undefined,
    path: string,
): NormalizedWritePathRule {
    if (input === undefined) {
        return { ...DEFAULT_RULE };
    }
    if (typeof input === 'string') {
        if (!ALLOWED_MODES.has(input)) {
            invalidConfig(path, 'mode must be "allow-both" or "model-only"');
        }
        return { ...DEFAULT_RULE, mode: input };
    }
    if (!isPlainObject(input)) {
        invalidConfig(path, 'rule must be a string mode or an object');
    }

    const mode = ownValue<WritePathPolicyMode>(input, 'mode') ?? DEFAULT_RULE.mode;
    if (!ALLOWED_MODES.has(mode as WritePathPolicyMode)) {
        invalidConfig(`${path}.mode`, 'must be "allow-both" or "model-only"');
    }
    const raw = ownValue<WritePathPolicyRawMode>(input, 'raw') ?? DEFAULT_RULE.raw;
    if (!ALLOWED_RAW.has(raw as WritePathPolicyRawMode)) {
        invalidConfig(`${path}.raw`, 'must be "inherit", "allow", or "block"');
    }
    const management = ownValue<WritePathPolicyManagementMode>(input, 'management') ?? DEFAULT_RULE.management;
    if (!ALLOWED_MANAGEMENT.has(management as WritePathPolicyManagementMode)) {
        invalidConfig(`${path}.management`, 'must be "inherit", "allow", or "block"');
    }
    const onViolation = ownValue<WritePathPolicyViolationAction>(input, 'onViolation') ?? DEFAULT_RULE.onViolation;
    if (!ALLOWED_VIOLATION_ACTIONS.has(onViolation as WritePathPolicyViolationAction)) {
        invalidConfig(`${path}.onViolation`, 'must be "throw" or "warn"');
    }

    return {
        mode: mode as WritePathPolicyMode,
        raw: raw as WritePathPolicyRawMode,
        management: management as WritePathPolicyManagementMode,
        onViolation: onViolation as WritePathPolicyViolationAction,
    };
}

export function validateWritePathPolicyConfig(options?: WritePathPolicyOptions): void {
    void normalizeWritePathPolicy(options);
}

export function normalizeWritePathPolicy(options?: WritePathPolicyOptions): NormalizedWritePathPolicy {
    if (options === undefined) {
        return { default: { ...DEFAULT_RULE }, namespaces: Object.create(null) as Record<string, NormalizedWritePathRule>, enabled: false };
    }
    if (!isPlainObject(options)) {
        invalidConfig('writePathPolicy', 'must be an object');
    }

    const typedOptions = options as WritePathPolicyOptions;
    const defaultRule = normalizeRule(ownValue(typedOptions, 'default'), 'writePathPolicy.default');
    const namespacesInput = ownValue<Record<string, WritePathPolicyMode | WritePathPolicyRule>>(options, 'namespaces');
    const namespaces: Record<string, NormalizedWritePathRule> = Object.create(null);
    if (namespacesInput !== undefined) {
        if (!isPlainObject(namespacesInput)) {
            invalidConfig('writePathPolicy.namespaces', 'must be an object');
        }
        for (const [key, rule] of Object.entries(namespacesInput as Record<string, WritePathPolicyMode | WritePathPolicyRule>)) {
            const trimmedKey = key.trim();
            if (!trimmedKey) {
                invalidConfig('writePathPolicy.namespaces', 'namespace key must be a non-empty string');
            }
            if (trimmedKey !== key) {
                invalidConfig(`writePathPolicy.namespaces.${key}`, 'namespace key must not include leading or trailing whitespace');
            }
            if (trimmedKey === 'default') {
                invalidConfig(`writePathPolicy.namespaces.${key}`, 'namespace key "default" is reserved; use writePathPolicy.default instead');
            }
            namespaces[key] = normalizeRule(rule, `writePathPolicy.namespaces.${key}`);
        }
    }

    return {
        default: defaultRule,
        namespaces,
        enabled: true,
    };
}

function buildNamespaceCandidates(namespace: WritePathNamespace): string[] {
    const candidates: string[] = [];
    if (namespace.iid) {
        candidates.push(namespace.iid);
    }
    if (namespace.pool && namespace.db && namespace.collection) {
        candidates.push(`${namespace.pool}:${namespace.db}.${namespace.collection}`);
    }
    if (namespace.db && namespace.collection) {
        candidates.push(`${namespace.db}.${namespace.collection}`);
    }
    if (namespace.collection) {
        candidates.push(namespace.collection);
    }
    candidates.push('default');
    return candidates;
}

export function resolveWritePathRule(
    policy: NormalizedWritePathPolicy | undefined,
    namespace: WritePathNamespace,
): ResolvedWritePathRule {
    const effectivePolicy = policy ?? normalizeWritePathPolicy();
    for (const candidate of buildNamespaceCandidates(namespace)) {
        if (candidate === 'default') {
            return { key: 'default', rule: effectivePolicy.default };
        }
        if (Object.prototype.hasOwnProperty.call(effectivePolicy.namespaces, candidate)) {
            const rule = effectivePolicy.namespaces[candidate];
            return { key: candidate, rule };
        }
    }
    return { key: 'default', rule: effectivePolicy.default };
}

function resolveRaw(rule: NormalizedWritePathRule): 'allow' | 'block' {
    if (rule.raw !== 'inherit') {
        return rule.raw;
    }
    return rule.mode === 'model-only' ? 'block' : 'allow';
}

function resolveManagement(rule: NormalizedWritePathRule): 'allow' | 'block' {
    if (rule.management !== 'inherit') {
        return rule.management;
    }
    return rule.mode === 'allow-both' ? 'allow' : 'block';
}

function isAllowed(rule: NormalizedWritePathRule, source: WritePathSource, category: WritePathOperationCategory): boolean {
    if (category === 'raw') {
        return resolveRaw(rule) === 'allow';
    }
    if (category === 'management') {
        if (rule.management === 'inherit' && rule.mode === 'model-only') {
            return source === 'model';
        }
        return resolveManagement(rule) === 'allow';
    }
    if (rule.mode === 'model-only') {
        return source === 'model';
    }
    return true;
}

function buildViolationMessage(operation: string, category: WritePathOperationCategory, source: WritePathSource): string {
    return `writePathPolicy blocked ${source} ${category} operation "${operation}". Use the model API or adjust writePathPolicy for this namespace.`;
}

export function assertWritePathAllowed(config: {
    policy?: NormalizedWritePathPolicy;
    namespace: WritePathNamespace;
    source: WritePathSource;
    operation: string;
    category: WritePathOperationCategory;
    logger?: Pick<Logger, 'warn'>;
}): void {
    const resolved = resolveWritePathRule(config.policy, config.namespace);
    if (isAllowed(resolved.rule, config.source, config.category)) {
        return;
    }

    const details = {
        operation: config.operation,
        category: config.category,
        source: config.source,
        namespace: config.namespace,
        matchedRule: resolved.key,
        rule: resolved.rule,
    };
    const message = buildViolationMessage(config.operation, config.category, config.source);
    if (resolved.rule.onViolation === 'warn') {
        config.logger?.warn?.(`[WritePathPolicy] ${message}`, details);
        return;
    }
    throw createError(ErrorCodes.INVALID_OPERATION, message, [details]);
}

function namespaceRuleMatchesDb(ruleKey: string, dbName: string): boolean {
    if (ruleKey.includes('.')) {
        const scoped = ruleKey.includes(':') ? ruleKey.slice(ruleKey.lastIndexOf(':') + 1) : ruleKey;
        return scoped.startsWith(`${dbName}.`);
    }
    const parts = ruleKey.split(':');
    if (parts.length >= 3) {
        return parts[parts.length - 2] === dbName;
    }
    if (parts.length === 2) {
        return parts[0] === dbName;
    }
    return true;
}

function blocksDbLevelCategory(rule: NormalizedWritePathRule, category: Extract<WritePathOperationCategory, 'raw' | 'management'>): boolean {
    if (rule.mode !== 'model-only') {
        if (category === 'raw') return rule.raw === 'block';
        return rule.management === 'block';
    }
    if (category === 'raw') return rule.raw !== 'allow';
    return rule.management !== 'allow';
}

function selectBlockedRule(
    matches: Array<{ key: string; rule: NormalizedWritePathRule }>,
    category: Extract<WritePathOperationCategory, 'raw' | 'management'>,
): { key: string; rule: NormalizedWritePathRule } | undefined {
    const blockedRules = matches.filter(({ rule }) => blocksDbLevelCategory(rule, category));
    return blockedRules.find(({ rule }) => rule.onViolation === 'throw') ?? blockedRules[0];
}

export function shouldBlockDbLevelWritePath(
    policy: NormalizedWritePathPolicy | undefined,
    dbName: string,
    category: Extract<WritePathOperationCategory, 'raw' | 'management'>,
): boolean {
    if (!policy) return false;
    if (blocksDbLevelCategory(policy.default, category)) {
        return true;
    }
    for (const [key, rule] of Object.entries(policy.namespaces)) {
        if (namespaceRuleMatchesDb(key, dbName) && blocksDbLevelCategory(rule, category)) {
            return true;
        }
    }
    return false;
}

export function assertDbLevelWritePathAllowed(config: {
    policy?: NormalizedWritePathPolicy;
    dbName: string;
    operation: string;
    category: Extract<WritePathOperationCategory, 'raw' | 'management'>;
    logger?: Pick<Logger, 'warn'>;
}): void {
    const policy = config.policy;
    if (!policy) return;

    const matches: Array<{ key: string; rule: NormalizedWritePathRule }> = [
        { key: 'default', rule: policy.default },
        ...Object.entries(policy.namespaces)
            .filter(([key]) => namespaceRuleMatchesDb(key, config.dbName))
            .map(([key, rule]) => ({ key, rule })),
    ];
    const blocked = selectBlockedRule(matches, config.category);
    if (!blocked) return;

    const details = {
        operation: config.operation,
        category: config.category,
        source: 'db' satisfies WritePathSource,
        namespace: { db: config.dbName },
        matchedRule: blocked.key,
        rule: blocked.rule,
    };
    const message = buildViolationMessage(config.operation, config.category, 'db');
    if (blocked.rule.onViolation === 'warn') {
        config.logger?.warn?.(`[WritePathPolicy] ${message}`, details);
        return;
    }
    throw createError(ErrorCodes.INVALID_OPERATION, message, [details]);
}

export function shouldBlockClientLevelWritePath(
    policy: NormalizedWritePathPolicy | undefined,
): boolean {
    if (!policy) return false;
    if (blocksDbLevelCategory(policy.default, 'raw')) {
        return true;
    }
    return Object.values(policy.namespaces).some((rule) => blocksDbLevelCategory(rule, 'raw'));
}

export function assertClientLevelWritePathAllowed(config: {
    policy?: NormalizedWritePathPolicy;
    operation: string;
    logger?: Pick<Logger, 'warn'>;
}): void {
    const policy = config.policy;
    if (!policy) return;

    const matches: Array<{ key: string; rule: NormalizedWritePathRule }> = [
        { key: 'default', rule: policy.default },
        ...Object.entries(policy.namespaces).map(([key, rule]) => ({ key, rule })),
    ];
    const blocked = selectBlockedRule(matches, 'raw');
    if (!blocked) return;

    const details = {
        operation: config.operation,
        category: 'raw' satisfies WritePathOperationCategory,
        source: 'client' satisfies WritePathSource,
        namespace: {},
        matchedRule: blocked.key,
        rule: blocked.rule,
    };
    const message = buildViolationMessage(config.operation, 'raw', 'client');
    if (blocked.rule.onViolation === 'warn') {
        config.logger?.warn?.(`[WritePathPolicy] ${message}`, details);
        return;
    }
    throw createError(ErrorCodes.INVALID_OPERATION, message, [details]);
}

export function runWithModelWriteSource<T>(fn: () => T): T {
    return modelWriteSourceStorage.run('model', fn);
}

export function getCurrentWritePathSource(): WritePathSource | undefined {
    return modelWriteSourceStorage.getStore();
}
