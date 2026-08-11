/**
 * model-registry.ts
 *
 * Static model registry (global singleton).
 *
 * Design notes:
 * - All model definitions are registered via Model.define() into a module-level Map
 *   scoped to the current process.
 * - Each define / redefine / undefine increments the revision counter; the MonSQLize
 *   runtime uses revisions to detect model changes for hot-reloading.
 * - _clear() and _redefinedNames are for test frameworks only and are not part of the
 *   public API.
 * - redefine semantics: the new definition is validated before replacing the old
 *   entry, so a failed redefine keeps the previous model intact.
 */

import { ErrorCodes, createError } from '../../core/errors';
import type { InferSchema } from 'schema-dsl';
import type { ModelDefinition, ModelDescriptor, RegisteredModel } from '../../../types/model';
import { validateCollectionName, validateDefinition, processTimestamps } from './definition-validator';

/**
 * Build a typed descriptor for a static Model schema.
 *
 * Registration remains explicit so runtime Model lifecycle and TypeScript type
 * inference stay independent from the process-global registry.
 *
 * @since v3.3.0
 */
export function defineModel<
    const TName extends string,
    const TSchema extends Record<string, unknown>,
>(collectionName: TName, definition: Omit<ModelDefinition<InferSchema<TSchema>>, 'schema'> & {
    schema: TSchema;
}): ModelDescriptor<TName, InferSchema<TSchema>> {
    return { collectionName, definition };
}

/**
 * Static model registry.
 *
 * Typical usage:
 *   Model.define('users', { schema: (s) => s({ name: 'string!' }) });
 *   const registered = Model.get('users');
 */
export class Model {
    // collection name → registered model definition
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static registry = new Map<string, RegisteredModel<any>>();

    // collection name → revision number (incremented on each define/redefine/undefine, used for hot-reload detection)
    private static revisions = new Map<string, number>();

    /** Collection names that have been redefined (used by the runtime to trigger hot-reload). */
    static _redefinedNames = new Set<string>();

    /**
     * Register a new model definition.
     * Throws MODEL_ALREADY_EXISTS if a model with the same name already exists.
     * Validates the definition and resolves the timestamps option.
     */
    static define<TName extends string, TDocument>(descriptor: ModelDescriptor<TName, TDocument>): void;
    static define<TDocument = Record<string, unknown>>(collectionName: string, definition: ModelDefinition<TDocument>): void;
    static define<TDocument = Record<string, unknown>>(
        collectionNameOrDescriptor: string | ModelDescriptor<string, TDocument>,
        definition?: ModelDefinition<TDocument>,
    ): void {
        const collectionName = typeof collectionNameOrDescriptor === 'string'
            ? collectionNameOrDescriptor
            : collectionNameOrDescriptor.collectionName;
        const modelDefinition = typeof collectionNameOrDescriptor === 'string'
            ? definition
            : collectionNameOrDescriptor.definition;
        const normalizedName = validateCollectionName(collectionName);
        if (this.registry.has(normalizedName)) {
            throw createError(ErrorCodes.MODEL_ALREADY_EXISTS, `Model '${normalizedName}' is already defined.`);
        }
        validateDefinition<TDocument>(modelDefinition);
        const resolvedDefinition = modelDefinition as ModelDefinition<TDocument>;
        processTimestamps(resolvedDefinition);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.registry.set(normalizedName, {
            collectionName: normalizedName,
            definition: resolvedDefinition,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as RegisteredModel<any>);
        this.bumpRevision(normalizedName);
    }

    /**
     * Look up a registered model definition; returns undefined if not found.
     */
    static get<TDocument = Record<string, unknown>>(collectionName: string): RegisteredModel<TDocument> | undefined {
        return this.registry.get(collectionName) as RegisteredModel<TDocument> | undefined;
    }

    /** Check whether the given collection name has been registered. */
    static has(collectionName: string): boolean {
        return this.registry.has(collectionName);
    }

    /** Return a list of all registered collection names. */
    static list(): string[] {
        return [...this.registry.keys()];
    }

    /**
     * Unregister the model definition for the given collection name.
     * Returns true if the entry existed and was removed; false if it did not exist.
     */
    static undefine(collectionName: string): boolean {
        const existed = this.registry.delete(collectionName);
        this.bumpRevision(collectionName);
        return existed;
    }

    /**
     * Re-register a model atomically.
     * If validation fails, the previous entry is left intact.
     * Used for hot-reload; the runtime is notified via _redefinedNames.
     */
    static redefine<TDocument = Record<string, unknown>>(collectionName: string, definition: ModelDefinition<TDocument>): void {
        const normalizedName = validateCollectionName(collectionName);
        validateDefinition<TDocument>(definition);
        processTimestamps(definition);
        this._redefinedNames.add(normalizedName);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.registry.set(normalizedName, {
            collectionName: normalizedName,
            definition,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as RegisteredModel<any>);
        this.bumpRevision(normalizedName);
    }

    /**
     * Clear the entire registry (for test frameworks only).
     * All registered collection names are added to _redefinedNames and their revisions are incremented.
     */
    static _clear(): void {
        const names = [...this.registry.keys()];
        for (const name of names) {
            this._redefinedNames.add(name);
            this.bumpRevision(name);
        }
        this.registry.clear();
    }

    /**
     * Get the current revision number for a collection name.
     * Incremented on every define / redefine / undefine; used for runtime hot-reload detection.
     */
    static getRevision(collectionName: string): number {
        return this.revisions.get(collectionName) ?? 0;
    }

    private static bumpRevision(collectionName: string): void {
        this.revisions.set(collectionName, (this.revisions.get(collectionName) ?? 0) + 1);
    }
}
