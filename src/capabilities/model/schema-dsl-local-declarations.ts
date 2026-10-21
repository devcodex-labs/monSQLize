export const functionIdentifierPattern = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu;
export const functionIdentifierPartPattern = /[$\u200c\u200d\p{ID_Continue}]/u;

export function nonWhitespaceIndex(source: string, start: number, direction = 1): number {
    for (let index = start; index >= 0 && index < source.length; index += direction) {
        if (!/\s/.test(source[index])) return index;
    }
    return -1;
}

/** Indices outside balanced groups in already-masked function source. */
export function* topLevelIndices(source: string): Generator<number> {
    let depth = 0;
    for (let index = 0; index < source.length; index++) {
        if ('{[('.includes(source[index])) depth++;
        else if ('}])'.includes(source[index])) depth = Math.max(0, depth - 1);
        else if (depth === 0) yield index;
    }
}

const localDeclarationBoundaryWords = new Set([
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'do',
    'else',
    'finally',
    'for',
    'function',
    'if',
    'let',
    'return',
    'switch',
    'throw',
    'try',
    'var',
    'while',
    'with',
]);

function isIdentifierPart(char: string | undefined): boolean {
    return char !== undefined && /[A-Za-z_$\d]/.test(char);
}

function nextNonWhitespaceIndex(source: string, start: number): number {
    return nonWhitespaceIndex(source, start);
}

function previousNonWhitespaceIndex(source: string, start: number): number {
    return nonWhitespaceIndex(source, start, -1);
}

function readIdentifierAt(source: string, start: number): string | null {
    if (!/[A-Za-z_$]/.test(source[start] ?? '')) {
        return null;
    }
    let end = start + 1;
    while (end < source.length && isIdentifierPart(source[end])) {
        end += 1;
    }
    return source.slice(start, end);
}

function currentDeclaratorHasInitializer(source: string, start: number, end: number): boolean {
    let initialized = false;
    for (const index of topLevelIndices(source.slice(start, end))) {
        if (source[start + index] === ',') initialized = false;
        else if (source[start + index] === '=') initialized = true;
    }
    return initialized;
}

function shouldEndLocalDeclarationAtLineBreak(source: string, start: number, index: number): boolean {
    const next = nextNonWhitespaceIndex(source, index + 1);
    if (next < 0) {
        return true;
    }
    const previous = previousNonWhitespaceIndex(source, index - 1);
    if (source[next] === ',' || source[previous] === ',') {
        return false;
    }
    if (!currentDeclaratorHasInitializer(source, start, index)) {
        return true;
    }
    const nextIdentifier = readIdentifierAt(source, next);
    if (nextIdentifier === null) {
        return false;
    }
    const afterIdentifier = nextNonWhitespaceIndex(source, next + nextIdentifier.length);
    if (source[afterIdentifier] === ':') {
        return true;
    }
    return localDeclarationBoundaryWords.has(nextIdentifier);
}

export function findLocalDeclarationEnd(source: string, start: number): number {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (char === '{' || char === '[' || char === '(') {
            depth += 1;
        } else if (char === '}' || char === ']' || char === ')') {
            depth = Math.max(0, depth - 1);
        } else if (char === ';' && depth === 0) {
            return index;
        } else if ((char === '\n' || char === '\r') && depth === 0 && shouldEndLocalDeclarationAtLineBreak(source, start, index)) {
            return index;
        }
    }
    return source.length;
}

type LocalBindingScope = { start: number; end: number };
type LocalDeclarationBinding = {
    kind: string;
    pattern: string;
    index: number;
    // Undefined denotes a function binding; null means the scope could not be proven.
    scope: LocalBindingScope | null | undefined;
};

export function findClosingPair(source: string, start: number, open: string, close: string, direction = 1): number {
    let depth = 0;
    for (let index = start; index >= 0 && index < source.length; index += direction) {
        if (source[index] === open) depth++;
        else if (source[index] === close && --depth === 0) return index;
    }
    return -1;
}

/** Resolves only proven lexical ranges; uncertain syntax stays closure-sensitive. */
export function resolveLocalBindingScope(source: string, start: number, index: number): LocalBindingScope | null | undefined {
    const braces: number[] = [];
    const parens: number[] = [];
    for (let at = start; at < index; at++) {
        if (source[at] === '{') braces.push(at);
        else if (source[at] === '}') braces.pop();
        else if (source[at] === '(') parens.push(at);
        else if (source[at] === ')') parens.pop();
    }
    for (const paren of [...parens].reverse()) {
        const header = /\bfor(?:\s+await)?\s*$/.exec(source.slice(start, paren));
        if (!header) continue;
        const close = findClosingPair(source, paren, '(', ')');
        const body = nextNonWhitespaceIndex(source, close + 1);
        if (close < 0 || source[body] !== '{') return null;
        const end = findClosingPair(source, body, '{', '}');
        return end < 0 ? null : { start: start + header.index, end };
    }
    if (braces.length <= 1) return undefined;
    const block = braces[braces.length - 1];
    const end = findClosingPair(source, block, '{', '}');
    return end < 0 ? null : { start: block, end };
}

/** Collects declarations from masked source without hoisting block bindings into the function. */
export function collectLocalDeclarationBindings(
    source: string, start: number, end: number,
    excluded: ReadonlyArray<{ start: number; end: number }>,
): LocalDeclarationBinding[] {
    const result: LocalDeclarationBinding[] = [];
    const text = source.slice(start, end + 1);
    const excludedAt = (index: number) => excluded.some((range) => index >= range.start && index <= range.end);
    const declarations = /\b(const|let|var)\b/g;
    let match: RegExpExecArray | null;
    while ((match = declarations.exec(text)) !== null) {
        const index = start + match.index;
        if (excludedAt(index)) continue;
        const from = nextNonWhitespaceIndex(text, match.index + match[0].length);
        if (from < 0) continue;
        const previous = previousNonWhitespaceIndex(text, match.index - 1);
        if (text[previous] === '.' || (!/^[$_\p{ID_Start}]/u.test(text.slice(from)) && text[from] !== '{' && text[from] !== '[')) continue;
        const to = findLocalDeclarationEnd(text, from);
        result.push({ kind: match[1], pattern: text.slice(from, to), index,
            scope: match[1] === 'var' ? undefined : resolveLocalBindingScope(source, start, index) });
        declarations.lastIndex = Math.max(declarations.lastIndex, to);
    }
    for (const item of text.matchAll(/\bclass\s+([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)/gu)) {
        const index = start + (item.index ?? 0);
        if (!excludedAt(index)) result.push({ kind: 'class', pattern: item[1], index,
            scope: resolveLocalBindingScope(source, start, index) });
    }
    for (const item of text.matchAll(/\bcatch\s*\(([^)]*)\)/g)) {
        const index = start + (item.index ?? 0);
        if (excludedAt(index)) continue;
        const body = nextNonWhitespaceIndex(source, index + item[0].length);
        const last = source[body] === '{' ? findClosingPair(source, body, '{', '}') : -1;
        result.push({ kind: 'catch', pattern: item[1], index,
            scope: last < 0 ? null : { start: index, end: last } });
    }
    return result;
}
