import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isClosureSensitiveFunctionSource } from '../../../src/capabilities/model/schema-dsl-function-source';

describe('schema extension lexical block identity', () => {
    const cases: Array<[string, boolean]> = [
        ['() => { const tools = { async*factory() { yield 1; } }; void tools; return { type: "string" }; }', false],
        ['() => { const tools = { async*factory() { yield factory; } }; void tools; return { type: "string" }; }', true],
        ['factory() { return { type: "string", const: factory }; }', true],
        ['factory() { const apply = () => factory; return { type: "string", const: apply() }; }', true],
        ['factory() { const held = factory; const apply = () => held; return { type: "string", const: apply() }; }', true],
        ['factory() { const apply = value => value; return { type: "string", const: apply("stable") }; }', false],
        ['factory() { return { type: "string" }; }', false],
        ['function factory() { const again = factory; void again; return { type: "string" }; }', false],
        ['async(value = factory) => ({ type: "string", const: value })', true],
        ['({ make = () => factory } = {}) => ({ type: "string", const: make() })', true],
        ['({ make = () => 1 } = {}) => ({ type: "string", minLength: make() })', false],
        ['𐐀 => ({ type: "string", const: 𐐀 })', false],
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
    it('does not treat an inferred display name as an arrow lexical binding', () => {
        assert.equal(isClosureSensitiveFunctionSource('() => ({ type: "string", const: factory })', 'factory'), true);
    });
});
