import { findArrowParameterStart } from './schema-dsl-function-scopes';
import { findClosingPair, functionIdentifierPattern, topLevelIndices } from './schema-dsl-local-declarations';

function isMemberBinding(source: string): boolean {
    const root = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/u.exec(source);
    if (!root) return false;
    let index = root[0].length;
    while (index < source.length) {
        if (/\s/.test(source[index])) { index++; continue; }
        if (source[index] === '[') {
            const close = findClosingPair(source, index, '[', ']');
            if (close < 0) return false;
            index = close + 1; continue;
        }
        const property = /^\.\s*[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/u.exec(source.slice(index));
        if (!property) return false;
        index += property[0].length;
    }
    return true;
}

/** Contextual words are syntax only at a proven modifier or loop separator position. */
export function contextualSyntaxPositions(source: string, statementSource: string): Set<number> {
    const positions = new Set<number>();
    const markAsyncBefore = (end: number) => {
        const match = /(?:^|[^$\u200c\u200d\p{ID_Continue}])(async)([^\S\r\n\u2028\u2029]*)$/u.exec(statementSource.slice(0, end));
        if (match) positions.add(end - match[2].length - 5);
    };
    for (const token of source.matchAll(functionIdentifierPattern)) {
        const at = token.index!;
        if (token[0] === 'function') markAsyncBefore(at);
        if (token[0] !== 'for' || /[.#]$/.test(source.slice(0, at).trimEnd())) continue;
        const head = /^\s*(?:await\s*)?\(/.exec(source.slice(at + 3));
        if (!head) continue;
        const open = at + 3 + head[0].lastIndexOf('(');
        const close = findClosingPair(source, open, '(', ')');
        if (close < 0) continue;
        const header = source.slice(open + 1, close);
        const indices = new Set(topLevelIndices(header));
        if ([...indices].some((index) => header[index] === ';')) continue;
        const top = [...header.matchAll(functionIdentifierPattern)]
            .filter((word) => indices.has(word.index!)).map((word) => ({ value: word[0], at: word.index! }));
        for (const word of top) {
            if (word.value !== 'of') continue;
            const left = header.slice(0, word.at).trim().replace(/^(?:const|let|var)\s+/u, '').trim();
            const right = header.slice(word.at + 2).trim();
            if (!left || !right || /^(?:const|let|var)$/.test(left)) continue;
            // A simple binding/member or a complete destructuring pattern proves the LHS.
            const simple = isMemberBinding(left);
            const pattern = (left[0] === '[' && findClosingPair(left, 0, '[', ']') === left.length - 1)
                || (left[0] === '{' && findClosingPair(left, 0, '{', '}') === left.length - 1);
            if (!simple && !pattern) continue;
            positions.add(open + 1 + word.at);
            break;
        }
    }
    for (const arrow of source.matchAll(/=>/g)) {
        const start = findArrowParameterStart(source, arrow.index!);
        if (start < 0) continue;
        if (source[start] === '(') markAsyncBefore(start);
        else if (/^async\s+[$_\p{ID_Start}]/u.test(source.slice(start, arrow.index))) {
            const gap = statementSource.slice(start + 5, arrow.index);
            if (!/[\r\n\u2028\u2029]/.test(gap)) positions.add(start);
        }
    }
    return positions;
}
