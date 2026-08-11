import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MonSQLize = require('../../../dist/cjs/index.cjs');

type DslFactory = (definition: Record<string, unknown>) => Record<string, unknown>;

describe('P3-C model registry', () => {
    afterEach(() => {
        MonSQLize.Model._clear();
    });

    it('supports define/get/list/redefine/undefine', () => {
        MonSQLize.Model.define('users', {
            schema: (dsl: DslFactory) => dsl({}),
            defaults: { status: 'active' },
            relations: {
                posts: {
                    from: 'posts',
                    localField: '_id',
                    foreignField: 'authorId',
                },
            },
        });

        assert.equal(MonSQLize.Model.has('users'), true);
        assert.deepEqual(MonSQLize.Model.list(), ['users']);
        assert.deepEqual(MonSQLize.Model.get('users').definition.defaults, { status: 'active' });

        MonSQLize.Model.redefine('users', {
            schema: (dsl: DslFactory) => dsl({}),
            virtuals: {
                displayName: {
                    get(this: { firstName: string; lastName: string }) {
                        return `${this.firstName} ${this.lastName}`;
                    },
                },
            },
        });

        assert.equal(typeof MonSQLize.Model.get('users').definition.virtuals.displayName.get, 'function');
        assert.equal(MonSQLize.Model.undefine('users'), true);
        assert.equal(MonSQLize.Model.has('users'), false);
    });

    it('registers descriptors created by defineModel', () => {
        const User = MonSQLize.defineModel('typed_users', {
            schema: {
                email: 'email!',
                age: 'number?',
            },
        });

        assert.equal(MonSQLize.Model.has('typed_users'), false);
        MonSQLize.Model.define(User);

        const registered = MonSQLize.Model.get('typed_users');
        assert.equal(User.collectionName, 'typed_users');
        assert.strictEqual(registered?.definition, User.definition);
    });

    it('rejects invalid collection names and invalid relation config', () => {
        assert.throws(
            () => MonSQLize.Model.define('bad name', { defaults: {} }),
            (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_COLLECTION_NAME'),
        );

        assert.throws(
            () => MonSQLize.Model.define('users', {
                schema: (dsl: DslFactory) => dsl({}),
                relations: {
                    posts: {
                        from: 'posts',
                        localField: '_id',
                        foreignField: 123,
                    },
                },
            }),
            (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_ARGUMENT'),
        );
    });

    it('keeps the previous definition when redefine validation fails', () => {
        MonSQLize.Model.define('users', {
            schema: (dsl: DslFactory) => dsl({}),
            defaults: { status: 'active' },
        });

        assert.throws(
            () => MonSQLize.Model.redefine('users', { schema: 'bad' }),
            /Schema/,
        );

        assert.equal(MonSQLize.Model.has('users'), true);
        assert.deepEqual(MonSQLize.Model.get('users').definition.defaults, { status: 'active' });
    });

    it('defers schema-dsl compilation to the bound runtime instance', () => {
        assert.doesNotThrow(() => MonSQLize.Model.define('tenantUsers', {
            schema: () => {
                throw new TypeError('[schema] Invalid type: tenant-id');
            },
        }));

        assert.equal(MonSQLize.Model.has('tenantUsers'), true);
    });
});
