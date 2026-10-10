import { createError, ErrorCodes } from '../../../core/errors';
import type { RuntimeDefaults, CursorValueType } from '../../../types/internal/query';

export function resolveCursorStrategy(options: Record<string, unknown>, defaults: RuntimeDefaults = {}): {
    cursorTypes: Record<string, CursorValueType>;
    cursorValueNormalizerVersion?: string;
    cacheable: boolean;
} {
    const localNormalizer = typeof options.cursorValueNormalizer === 'function';
    const normalizer = localNormalizer ? options.cursorValueNormalizer : defaults.cursorValueNormalizer;
    const version = options.cursorValueNormalizerVersion ?? (localNormalizer ? undefined : defaults.cursorValueNormalizerVersion);
    if (version !== undefined && (typeof version !== 'string' || !version.trim())) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'cursorValueNormalizerVersion must be a non-empty stable strategy identifier.');
    }
    return {
        cursorTypes: { ...(defaults.cursorTypes ?? {}), ...((options.cursorTypes as Record<string, CursorValueType> | undefined) ?? {}) },
        ...(normalizer && version ? { cursorValueNormalizerVersion: version as string } : {}),
        cacheable: !normalizer || !!version,
    };
}
