import {
    addParameterIdentifiers,
    addScopedLocalIdentifiers,
    findArrowParameterStart,
    findNestedFunctionScopes,
    findParentFunctionScope,
    isBoundByNestedFunctionScope,
    type FunctionScopeInfo,
} from './schema-dsl-function-scopes';
import { addFunctionDeclarationIdentifier } from './schema-dsl-function-declarations';

const functionIdentifierPattern = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu;
const functionIdentifierPartPattern = /[$\u200c\u200d\p{ID_Continue}]/u;
const trailingFunctionIdentifierPattern = /([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)$/u;
const regexPrefixKeywords = new Set(['return', 'throw', 'case', 'yield', 'typeof', 'delete', 'void', 'new']);
const functionReservedIdentifiers = new Set([
    'arguments',
    'async',
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
    'get',
    'globalThis',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'null',
    'of',
    'return',
    'set',
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

function maskFunctionLiteralsAndComments(source: string, preserveValueTokens = false): string {
    let masked = '';
    const maskValue = (text: string) => preserveValueTokens
        ? `${text.slice(0, -1).replace(/[^\r\n]/g, ' ')}0`
        : ' '.repeat(text.length);
    for (let index = 0; index < source.length;) {
        const current = source[index];
        const next = source[index + 1];
        if (current === '/' && next === '/') {
            const end = source.indexOf('\n', index + 2);
            const commentEnd = end === -1 ? source.length : end;
            masked += preserveValueTokens ? source.slice(index, commentEnd).replace(/[^\r\n]/g, ' ') : ' '.repeat(commentEnd - index);
            index = commentEnd;
            continue;
        }
        if (current === '/' && next === '*') {
            const end = source.indexOf('*/', index + 2);
            const commentEnd = end === -1 ? source.length : end + 2;
            masked += preserveValueTokens ? source.slice(index, commentEnd).replace(/[^\r\n]/g, ' ') : ' '.repeat(commentEnd - index);
            index = commentEnd;
            continue;
        }
        if (current === '/' && next !== undefined && next !== '=' && canStartRegexLiteral(source, index)) {
            const regexEnd = readRegexLiteralEnd(source, index);
            if (regexEnd !== null) {
                masked += maskValue(source.slice(index, regexEnd));
                index = regexEnd;
                continue;
            }
        }
        if (current === '\'' || current === '"') {
            const end = readQuotedLiteralEnd(source, index);
            masked += maskValue(source.slice(index, end));
            index = end;
            continue;
        }
        if (current === '`') {
            const end = readTemplateLiteralEnd(source, index);
            masked += maskValue(source.slice(index, end));
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
        const next = source[index + 1];
        if (current === '\'' || current === '"') {
            index = readQuotedLiteralEnd(source, index);
            continue;
        }
        if (current === '`') {
            index = readTemplateLiteralEnd(source, index);
            continue;
        }
        if (current === '/' && next === '/') {
            const end = source.indexOf('\n', index + 2);
            index = end === -1 ? source.length : end;
            continue;
        }
        if (current === '/' && next === '*') {
            const end = source.indexOf('*/', index + 2);
            index = end === -1 ? source.length : end + 2;
            continue;
        }
        if (current === '/' && next !== undefined && next !== '=' && canStartRegexLiteral(source, index)) {
            const regexEnd = readRegexLiteralEnd(source, index);
            if (regexEnd !== null) {
                index = regexEnd;
                continue;
            }
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

function collectTemplateExpressionSource(source: string, expressions: string[]): void {
    for (let index = 0; index < source.length;) {
        const current = source[index];
        const next = source[index + 1];
        if (current === '/' && next === '/') {
            const end = source.indexOf('\n', index + 2);
            index = end === -1 ? source.length : end;
            continue;
        }
        if (current === '/' && next === '*') {
            const end = source.indexOf('*/', index + 2);
            index = end === -1 ? source.length : end + 2;
            continue;
        }
        if (current === '/' && next !== undefined && next !== '=' && canStartRegexLiteral(source, index)) {
            const regexEnd = readRegexLiteralEnd(source, index);
            if (regexEnd !== null) {
                index = regexEnd;
                continue;
            }
        }
        if (current === '\'' || current === '"') {
            index = readQuotedLiteralEnd(source, index);
            continue;
        }
        if (current !== '`') {
            index += 1;
            continue;
        }
        index += 1;
        while (index < source.length) {
            if (source[index] === '\\') {
                index += 2;
                continue;
            }
            if (source[index] === '`') {
                index += 1;
                break;
            }
            if (source[index] === '$' && source[index + 1] === '{') {
                const expressionStart = index + 2;
                const expressionEnd = readTemplateExpressionEnd(source, expressionStart);
                if (expressionEnd < 0) {
                    return;
                }
                const expression = source.slice(expressionStart, expressionEnd);
                expressions.push(expression);
                collectTemplateExpressionSource(expression, expressions);
                index = expressionEnd + 1;
                continue;
            }
            index += 1;
        }
    }
}

function extractTemplateExpressionSource(source: string): string {
    const expressions: string[] = [];
    collectTemplateExpressionSource(source, expressions);
    return expressions.join('\n');
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
    const functionMatch = /^\s*(?:async\s+)?function(?:\s+([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*))?\s*\(([^)]*)\)/u.exec(maskedSource);
    const arrowIndex = findRootArrowIndex(maskedSource);
    const methodMatch = /^\s*(?:async\s+)?(?:get\s+|set\s+)?([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)?\s*\(([^)]*)\)/u.exec(maskedSource);
    const rootFunctionIndex = functionMatch ? maskedSource.indexOf('function', functionMatch.index ?? 0) : -1;
    const nestedFunctionScopes = findNestedFunctionScopes(maskedSource, arrowIndex, rootFunctionIndex, statementSource);

    if (functionMatch) {
        if (functionMatch[1]) identifiers.add(functionMatch[1]);
        addParameterIdentifiers(functionMatch[2] ?? '', identifiers);
    } else if (arrowIndex >= 0) {
        let params = maskedSource.slice(findArrowParameterStart(maskedSource, arrowIndex), arrowIndex).trim().replace(/^async\s+/, '').trim();
        if (params.startsWith('(')) {
            params = params.slice(1, params.lastIndexOf(')'));
        }
        addParameterIdentifiers(params, identifiers);
    } else if (methodMatch) {
        addParameterIdentifiers(methodMatch[2] ?? '', identifiers);
    }

    addScopedLocalIdentifiers(maskedSource, 0, maskedSource.length - 1, identifiers, nestedFunctionScopes, blockScopes);
    for (const nestedScope of nestedFunctionScopes) {
        if (nestedScope.kind !== 'function' || !nestedScope.name) {
            continue;
        }
        if (!findParentFunctionScope(nestedScope, nestedFunctionScopes)) {
            addFunctionDeclarationIdentifier(maskedSource, 0, nestedScope, identifiers, blockScopes, statementSource);
        }
    }
    return identifiers;
}

function previousNonWhitespaceChar(source: string, start: number): string | undefined {
    for (let index = start; index >= 0; index -= 1) {
        if (!/\s/.test(source[index])) {
            return source[index];
        }
    }
    return undefined;
}

function nextNonWhitespaceChar(source: string, start: number): string | undefined {
    for (let index = start; index < source.length; index += 1) {
        if (!/\s/.test(source[index])) {
            return source[index];
        }
    }
    return undefined;
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
    const lastLineFeed = source.lastIndexOf('\n', start - 1);
    const lastCarriageReturn = source.lastIndexOf('\r', start - 1);
    const lineStart = Math.max(lastLineFeed, lastCarriageReturn) + 1;
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
    const templateExpressions = extractTemplateExpressionSource(source);
    const sourceWithTemplateExpressions = templateExpressions ? `${source}\n${templateExpressions}` : source;
    const maskedSource = maskNumericLiterals(maskFunctionLiteralsAndComments(sourceWithTemplateExpressions));
    const statementSource = maskFunctionLiteralsAndComments(sourceWithTemplateExpressions, true);
    const blockScopes: FunctionScopeInfo[] = [];
    const boundIdentifiers = extractFunctionBoundIdentifiers(maskedSource, blockScopes, statementSource);
    const functionMatch = /^\s*(?:async\s+)?function(?:\s+([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*))?\s*\(([^)]*)\)/u.exec(maskedSource);
    const rootFunctionIndex = functionMatch ? maskedSource.indexOf('function', functionMatch.index ?? 0) : -1;
    const nestedFunctionScopes = [...findNestedFunctionScopes(maskedSource, findRootArrowIndex(maskedSource), rootFunctionIndex, statementSource), ...blockScopes];
    // Display names and method names do not create lexical bindings in their bodies.

    for (const match of maskedSource.matchAll(functionIdentifierPattern)) {
        const identifier = match[0];
        const start = match.index ?? 0;
        const end = start + identifier.length;
        if (functionReservedIdentifiers.has(identifier) || boundIdentifiers.has(identifier)) {
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
