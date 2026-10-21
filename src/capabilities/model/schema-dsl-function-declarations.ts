import type { FunctionScopeInfo } from './schema-dsl-function-scopes';
import { findClosingPair, resolveLocalBindingScope } from './schema-dsl-local-declarations';

/** Reads a complete parameter list, including calls inside destructuring defaults. */
export function readFunctionHeader(source: string, method = false): {
    name?: string; parameters: string; bodyStart: number; functionIndex: number;
} | null {
    const prefix = method
        ? /^\s*(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)?\s*\(/u.exec(source)
        : /^\s*(?:async\s+)?function(?![$\u200c\u200d\p{ID_Continue}])\s*\*?\s*([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)?\s*\(/u.exec(source);
    if (!prefix) return null;
    const open = prefix[0].lastIndexOf('(');
    const close = findClosingPair(source, open, '(', ')');
    if (close < 0) return null;
    const after = /\S/.exec(source.slice(close + 1));
    const bodyStart = close + 1 + (after?.index ?? source.length);
    if (source[bodyStart] !== '{') return null;
    return { name: prefix[1], parameters: source.slice(open + 1, close), bodyStart,
        functionIndex: method ? -1 : source.indexOf('function') };
}

/** Only a proven declaration binds a child function's name outside its own body. */
export function addFunctionDeclarationIdentifier(
    source: string,
    start: number,
    child: FunctionScopeInfo,
    identifiers: Set<string>,
    blockScopes: FunctionScopeInfo[],
    statementSource = source,
): void {
    if (child.kind !== 'function' || !child.name) return;
    const before = statementSource.slice(start, child.start);
    const prefix = before.replace(/\basync[^\S\r\n\u2028\u2029]*$/, '').trimEnd();
    if (prefix.length > 0 && !/[{};]$/.test(prefix)) {
        const tail = before.slice(prefix.length).replace(/\basync[^\S\r\n\u2028\u2029]*$/, '');
        const lastWord = /([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)$/u.exec(prefix)?.[1];
        const expectsOperand = /^(?:const|let|var|new|throw|case|delete|typeof|void|instanceof|in|of|await|yield|extends)$/;
        const endsExpression = /[$\u200c\u200d\p{ID_Continue}\])]$/u.test(prefix) || /(?:\+\+|--)$/.test(prefix);
        if (!/[\r\n\u2028\u2029]/.test(tail) || !endsExpression
            || (lastWord && expectsOperand.test(lastWord))) return;
    }
    let parens = 0;
    let brackets = 0;
    for (const char of prefix) {
        if (char === '(') parens++;
        else if (char === ')') parens--;
        else if (char === '[') brackets++;
        else if (char === ']') brackets--;
    }
    if (parens !== 0 || brackets !== 0) return;
    const scope = resolveLocalBindingScope(source, start, child.start);
    if (scope === undefined) identifiers.add(child.name);
    else if (scope) blockScopes.push({ ...scope, bodyStart: scope.start, bodyEnd: scope.end,
        kind: 'block', boundIdentifiers: new Set([child.name]) });
}
