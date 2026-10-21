import {
    addParameterIdentifiers,
    addScopedLocalIdentifiers,
    findArrowParameterStart,
    findNestedFunctionScopes,
    findParentFunctionScope,
    isBoundByNestedFunctionScope,
    type FunctionScopeInfo,
} from './schema-dsl-function-scopes';
import { addFunctionDeclarationIdentifier, readFunctionHeader } from './schema-dsl-function-declarations';
import { contextualSyntaxPositions } from './schema-dsl-contextual-tokens';
import { findClosingPair, functionIdentifierPattern, functionIdentifierPartPattern, nonWhitespaceIndex } from './schema-dsl-local-declarations';

const trailingFunctionIdentifierPattern = /([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)$/u;
const regexPrefixKeywords = new Set(['return', 'throw', 'case', 'yield', 'typeof', 'delete', 'void', 'new']);
const functionReservedIdentifiers = new Set([
    'arguments',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'default',
    'delete',
    'debugger',
    'do',
    'else',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'globalThis',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'null',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'with',
    'while',
    'yield',
]);

function readQuotedLiteralEnd(source: string, start: number): number {
    const quote = source[start];
    let end = start + 1;
    while (end < source.length) {
        if (source[end] === '\\') {
            end += 2;
            continue;
        }
        if (source[end] === quote) {
            return end + 1;
        }
        end += 1;
    }
    return end;
}

function readTemplateLiteralEnd(source: string, start: number): number {
    let end = start + 1;
    while (end < source.length) {
        if (source[end] === '\\') {
            end += 2;
            continue;
        }
        if (source[end] === '`') {
            return end + 1;
        }
        if (source[end] === '$' && source[end + 1] === '{') {
            const expressionEnd = readTemplateExpressionEnd(source, end + 2);
            if (expressionEnd < 0) {
                return source.length;
            }
            end = expressionEnd + 1;
            continue;
        }
        end += 1;
    }
    return end;
}

/** Shared lexical skipping; templates are handled by each caller's own traversal. */
function readPlainTokenEnd(source: string, start: number): number | null {
    const current = source[start], next = source[start + 1];
    if (current === '\'' || current === '"') return readQuotedLiteralEnd(source, start);
    if (current !== '/') return null;
    if (next === '/') {
        const end = /[\r\n\u2028\u2029]/g;
        end.lastIndex = start + 2;
        return end.exec(source)?.index ?? source.length;
    }
    if (next === '*') {
        const end = source.indexOf('*/', start + 2);
        return end < 0 ? source.length : end + 2;
    }
    return next !== undefined && next !== '=' && canStartRegexLiteral(source, start)
        ? readRegexLiteralEnd(source, start) : null;
}

function maskFunctionLiteralsAndComments(source: string, preserveValueTokens = false): string {
    let masked = '';
    const maskValue = (text: string) => preserveValueTokens
        ? `${text.slice(0, -1).replace(/[^\r\n]/g, ' ')}0`
        : ' '.repeat(text.length);
    for (let index = 0; index < source.length;) {
        const current = source[index];
        const end = readPlainTokenEnd(source, index);
        if (end !== null) {
            const text = source.slice(index, end);
            const comment = current === '/' && (source[index + 1] === '/' || source[index + 1] === '*');
            masked += comment
                ? text.replace(/[^\r\n\u2028\u2029]/g, ' ')
                : maskValue(text);
            index = end;
            continue;
        }
        if (current === '`') {
            const end = readTemplateLiteralEnd(source, index);
            const raw = (text: string) => preserveValueTokens ? text.replace(/[^\r\n]/g, ' ') : ' '.repeat(text.length);
            let chunkStart = index + 1;
            let cursor = chunkStart;
            masked += '[';
            while (cursor < end - 1) {
                if (source[cursor] === '\\') {
                    cursor += 2;
                } else if (source[cursor] === '$' && source[cursor + 1] === '{') {
                    const expressionStart = cursor + 2;
                    const expressionEnd = readTemplateExpressionEnd(source, expressionStart);
                    if (expressionEnd < 0) break;
                    masked += raw(source.slice(chunkStart, cursor)) + ' ('
                        + maskFunctionLiteralsAndComments(source.slice(expressionStart, expressionEnd), preserveValueTokens) + ')';
                    chunkStart = expressionEnd + 1;
                    cursor = chunkStart;
                } else cursor += 1;
            }
            masked += raw(source.slice(chunkStart, end - 1)) + ']';
            index = end;
            continue;
        }
        masked += current;
        index += 1;
    }
    return masked;
}

function readTemplateExpressionEnd(source: string, start: number): number {
    let depth = 1;
    for (let index = start; index < source.length;) {
        const current = source[index];
        const plainEnd = readPlainTokenEnd(source, index);
        if (plainEnd !== null) {
            index = plainEnd;
            continue;
        }
        if (current === '`') {
            index = readTemplateLiteralEnd(source, index);
            continue;
        }
        if (current === '{') {
            depth += 1;
        } else if (current === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
        index += 1;
    }
    return -1;
}

function canStartRegexLiteral(source: string, index: number): boolean {
    const before = source.slice(0, index).trimEnd();
    if (!before) {
        return true;
    }
    if (before.endsWith('=>')) {
        return true;
    }
    const previous = before[before.length - 1];
    if (previous && '({[=,:;!?&|^~+-*%<>'.includes(previous)) {
        return true;
    }
    const wordMatch = trailingFunctionIdentifierPattern.exec(before);
    if (!wordMatch) {
        return false;
    }
    return regexPrefixKeywords.has(wordMatch[1]);
}

function readRegexLiteralEnd(source: string, start: number): number | null {
    let index = start + 1;
    let inCharacterClass = false;
    while (index < source.length) {
        const char = source[index];
        if (char === '\\') {
            index += 2;
            continue;
        }
        if (char === '[') {
            inCharacterClass = true;
        } else if (char === ']') {
            inCharacterClass = false;
        } else if (char === '/' && !inCharacterClass) {
            index += 1;
            while (index < source.length && /[A-Za-z_$\d]/.test(source[index])) {
                index += 1;
            }
            return index;
        }
        index += 1;
    }
    return null;
}

function isDecimalDigit(char: string | undefined): boolean {
    return char !== undefined && char >= '0' && char <= '9';
}

function isHexDigit(char: string | undefined): boolean {
    return char !== undefined && /[0-9A-Fa-f]/.test(char);
}

function isBinaryDigit(char: string | undefined): boolean {
    return char === '0' || char === '1';
}

function isOctalDigit(char: string | undefined): boolean {
    return char !== undefined && char >= '0' && char <= '7';
}

function readDigitsWithSeparators(source: string, start: number, isDigit: (char: string | undefined) => boolean): number {
    let index = start;
    while (index < source.length) {
        const current = source[index];
        if (isDigit(current) || current === '_') {
            index += 1;
            continue;
        }
        break;
    }
    return index;
}

function readNumericLiteralEnd(source: string, start: number): number | null {
    if (!isDecimalDigit(source[start])) {
        return null;
    }
    const previous = source[start - 1];
    if (previous && functionIdentifierPartPattern.test(previous)) {
        return null;
    }
    if (source[start] === '0') {
        const prefix = source[start + 1];
        const prefixedDigit = prefix === 'x' || prefix === 'X'
            ? isHexDigit
            : prefix === 'b' || prefix === 'B'
                ? isBinaryDigit
                : prefix === 'o' || prefix === 'O'
                    ? isOctalDigit
                    : null;
        if (prefixedDigit) {
            let index = readDigitsWithSeparators(source, start + 2, prefixedDigit);
            if (source[index] === 'n') {
                index += 1;
            }
            return index > start + 2 ? index : null;
        }
    }

    let index = readDigitsWithSeparators(source, start, isDecimalDigit);
    let hasFractionOrExponent = false;
    if (source[index] === '.' && isDecimalDigit(source[index + 1])) {
        hasFractionOrExponent = true;
        index = readDigitsWithSeparators(source, index + 1, isDecimalDigit);
    }
    if ((source[index] === 'e' || source[index] === 'E')) {
        let exponentIndex = index + 1;
        if (source[exponentIndex] === '+' || source[exponentIndex] === '-') {
            exponentIndex += 1;
        }
        const exponentEnd = readDigitsWithSeparators(source, exponentIndex, isDecimalDigit);
        if (exponentEnd > exponentIndex) {
            hasFractionOrExponent = true;
            index = exponentEnd;
        }
    }
    if (!hasFractionOrExponent && source[index] === 'n') {
        index += 1;
    }
    return index;
}

function maskNumericLiterals(source: string): string {
    let masked = '';
    for (let index = 0; index < source.length;) {
        const end = readNumericLiteralEnd(source, index);
        if (end !== null && end > index) {
            masked += ' '.repeat(end - index);
            index = end;
            continue;
        }
        masked += source[index];
        index += 1;
    }
    return masked;
}

function findRootArrowIndex(source: string): number {
    for (const match of source.matchAll(/=>/g)) {
        const index = match.index ?? 0;
        const start = findArrowParameterStart(source, index);
        if (start < 0) continue;
        const prefix = source.slice(0, start).trim();
        if (prefix === '' || prefix === 'async') return index;
    }
    return -1;
}

function extractFunctionBoundIdentifiers(maskedSource: string, blockScopes: FunctionScopeInfo[], statementSource: string): Set<string> {
    const identifiers = new Set<string>();
    const functionMatch = readFunctionHeader(maskedSource);
    const arrowIndex = findRootArrowIndex(maskedSource);
    const methodMatch = readFunctionHeader(maskedSource, true);
    const rootFunctionIndex = functionMatch?.functionIndex ?? -1;
    const nestedFunctionScopes = findNestedFunctionScopes(maskedSource, arrowIndex, rootFunctionIndex, statementSource);

    if (functionMatch) {
        if (functionMatch.name) identifiers.add(functionMatch.name);
        addParameterIdentifiers(functionMatch.parameters, identifiers);
    } else if (arrowIndex >= 0) {
        let params = maskedSource.slice(findArrowParameterStart(maskedSource, arrowIndex), arrowIndex).trim().replace(/^async\s+/, '').trim();
        if (params.startsWith('(')) {
            params = params.slice(1, params.lastIndexOf(')'));
        }
        addParameterIdentifiers(params, identifiers);
    } else if (methodMatch) {
        addParameterIdentifiers(methodMatch.parameters, identifiers);
    }

    const bodyStart = functionMatch?.bodyStart ?? methodMatch?.bodyStart
        ?? (arrowIndex >= 0 ? nonWhitespaceIndex(maskedSource, arrowIndex + 2) : -1);
    if (bodyStart >= 0) {
        const bodyEnd = maskedSource[bodyStart] === '{' ? findClosingPair(maskedSource, bodyStart, '{', '}') : maskedSource.length - 1;
        const bodyIdentifiers = new Set<string>();
        addScopedLocalIdentifiers(maskedSource, bodyStart, bodyEnd, bodyIdentifiers, nestedFunctionScopes, blockScopes);
        for (const nestedScope of nestedFunctionScopes) {
            if (nestedScope.kind === 'function' && nestedScope.name && nestedScope.start >= bodyStart && nestedScope.start <= bodyEnd
                && !findParentFunctionScope(nestedScope, nestedFunctionScopes)) {
                addFunctionDeclarationIdentifier(maskedSource, bodyStart, nestedScope, bodyIdentifiers, blockScopes, statementSource);
            }
        }
        blockScopes.push({ start: bodyStart, end: bodyEnd, bodyStart, bodyEnd, kind: 'block', boundIdentifiers: bodyIdentifiers });
    }
    return identifiers;
}

function previousNonWhitespaceChar(source: string, start: number): string | undefined {
    return source[nonWhitespaceIndex(source, start, -1)];
}

function nextNonWhitespaceChar(source: string, start: number): string | undefined {
    return source[nonWhitespaceIndex(source, start)];
}

function previousIdentifier(source: string, start: number): string | undefined {
    let index = start;
    while (index >= 0 && /\s/.test(source[index])) {
        index -= 1;
    }
    if (index < 0 || !functionIdentifierPartPattern.test(source[index])) {
        return undefined;
    }
    const end = index + 1;
    while (index >= 0 && functionIdentifierPartPattern.test(source[index])) {
        index -= 1;
    }
    return source.slice(index + 1, end);
}

function isObjectLiteralKey(source: string, start: number, end: number): boolean {
    const next = nextNonWhitespaceChar(source, end);
    if (next !== ':') {
        return false;
    }
    const previous = previousNonWhitespaceChar(source, start - 1);
    return previous === '{' || previous === ',';
}

function isStatementLabel(source: string, start: number, end: number): boolean {
    const next = nextNonWhitespaceChar(source, end);
    if (next !== ':') {
        return false;
    }
    const lineStart = Math.max(source.lastIndexOf('\n', start - 1), source.lastIndexOf('\r', start - 1),
        source.lastIndexOf('\u2028', start - 1), source.lastIndexOf('\u2029', start - 1)) + 1;
    if (source.slice(lineStart, start).trim() === '') {
        return true;
    }
    const previous = previousNonWhitespaceChar(source, start - 1);
    return previous === undefined || previous === '{' || previous === '}' || previous === ';';
}

function isBreakOrContinueLabelReference(source: string, start: number): boolean {
    const previous = previousIdentifier(source, start - 1);
    return previous === 'break' || previous === 'continue';
}

export function isClosureSensitiveFunctionSource(source: string, _functionName?: string): boolean {
    const maskedSource = maskNumericLiterals(maskFunctionLiteralsAndComments(source));
    const statementSource = maskFunctionLiteralsAndComments(source, true);
    const blockScopes: FunctionScopeInfo[] = [];
    const boundIdentifiers = extractFunctionBoundIdentifiers(maskedSource, blockScopes, statementSource);
    const functionMatch = readFunctionHeader(maskedSource);
    const rootFunctionIndex = functionMatch?.functionIndex ?? -1;
    const nestedFunctionScopes = [...findNestedFunctionScopes(maskedSource, findRootArrowIndex(maskedSource), rootFunctionIndex, statementSource), ...blockScopes];
    // Display names and method names do not create lexical bindings in their bodies.
    const syntaxPositions = contextualSyntaxPositions(maskedSource, statementSource);

    for (const match of maskedSource.matchAll(functionIdentifierPattern)) {
        const identifier = match[0];
        const start = match.index ?? 0;
        const end = start + identifier.length;
        if (functionReservedIdentifiers.has(identifier) || boundIdentifiers.has(identifier) || syntaxPositions.has(start)) {
            continue;
        }
        if (isBoundByNestedFunctionScope(identifier, start, nestedFunctionScopes)) {
            continue;
        }
        const previous = previousNonWhitespaceChar(maskedSource, start - 1);
        if (previous === '.' || previous === '#') {
            continue;
        }
        if (isStatementLabel(maskedSource, start, end) || isBreakOrContinueLabelReference(maskedSource, start)) {
            continue;
        }
        if (isObjectLiteralKey(maskedSource, start, end)) {
            continue;
        }
        return true;
    }
    return false;
}
