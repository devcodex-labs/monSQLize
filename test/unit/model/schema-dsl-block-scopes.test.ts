import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isClosureSensitiveFunctionSource } from '../../../src/capabilities/model/schema-dsl-function-source';

describe('schema extension lexical block identity', () => {
    const cases: Array<[string, boolean]> = [
        ['() => { let n = 0; n++\n function local() { return n; }\n return { type: "string", minLength: local() }; }', false],
        ['() => { let n = 2; n--\n function local() { return n; }\n return { type: "string", minLength: local() }; }', false],
        ['() => { const async = 1; const f = async\n function local() { return f; }\n return { type: "string", minLength: local() }; }', false],
        ['() => { const pattern = "stable"\n function local() { return pattern; }\n return { type: "string", pattern: local() }; }', false],
        ['() => { const 𐐀 = 1; return { type: "string", minLength: 𐐀 }; }', false],
        ['() => { const f = // comment\n function pattern() { return 1; }; void f; return { type: "string", pattern }; }', true],
        ['() => ({ type: "string", const: pattern })', true],
        ['() => { const f = function pattern() { return 1; }; void f; return { type: "string", pattern }; }', true],
        ['() => { const f =\n function pattern() { return 1; }; void f; return { type: "string", pattern }; }', true],
        ['() => { { function pattern() { return 1; } void pattern; } return { type: "string", pattern }; }', true],
        ['() => { for (; function pattern() { return 1; };) { break; } return { type: "string", pattern }; }', true],
        ['() => { const f = function recursive() { return recursive; }; void f; return { type: "string" }; }', false],
        ['() => { function local() { return 1; } void local; return { type: "string" }; }', false],
        ['() => { { const x = 1; function local() { return x; } void local; } return { type: "string" }; }', false],
        ['value => { { const pattern = /inside/; void pattern; } return pattern.test(value); }', true],
        ['value => { { let pattern = /inside/; void pattern; } return pattern.test(value); }', true],
        ['value => { try { throw 1; } catch (pattern) { void pattern; } return pattern.test(value); }', true],
        ['value => { for (let pattern of [1]) { void pattern; } return pattern.test(value); }', true],
        ['value => { { class Pattern {} void Pattern; } return new Pattern(value); }', true],
        ['value => { function check() { { const pattern = 1; void pattern; } return pattern.test(value); } return check(); }', true],
        ['value => { const pattern = /inside/; return pattern.test(value); }', false],
        ['pattern => { { const pattern = 1; void pattern; } return pattern; }', false],
        ['value => { { var pattern = /inside/; } return pattern.test(value); }', false],
        ['value => { { const pattern = /inside/; return pattern.test(value); } }', false],
        ['value => { try { throw value; } catch (pattern) { return !!pattern; } }', false],
        ['value => { for (const pattern of [value]) { if (pattern) return true; } return false; }', false],
        ['value => { { class Pattern {} return new Pattern(); } }', false],
        // Unproven single-statement loop and relocated template ranges stay conservative.
        ['value => { for (let pattern of [value]) if (pattern) return true; return false; }', true],
        ['value => { { const pattern = value; return `${pattern}`; } }', true],
    ];
    for (const [source, expected] of cases) {
        it(`${expected ? 'retains reference identity' : 'permits stable source identity'}: ${source}`, () => {
            assert.equal(isClosureSensitiveFunctionSource(source), expected);
        });
    }
});
