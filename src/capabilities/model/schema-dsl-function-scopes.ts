import { collectLocalDeclarationBindings } from './schema-dsl-local-declarations';

const functionIdentifierPattern = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu;
const simpleFunctionIdentifierPattern = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
const functionIdentifierPartPattern = /[$\u200c\u200d\p{ID_Continue}]/u;

export type FunctionScopeInfo = {
    start: number;
    end: number;
    bodyStart: number;
    bodyEnd: number;
    name?: string;
    kind: 'arrow' | 'function' | 'class-method' | 'class-field' | 'class-member' | 'object-method' | 'object-member' | 'block';
    boundIdentifiers: Set<string>;
};

function addIdentifiersFromPattern(pattern: string, identifiers: Set<string>): void {
    for (const match of pattern.matchAll(functionIdentifierPattern)) {
        identifiers.add(match[0]);
    }
}

function isIdentifierPart(char: string | undefined): boolean {
    return char !== undefined && functionIdentifierPartPattern.test(char);
}

function splitTopLevel(source: string, delimiter: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '{' || char === '[' || char === '(') {
            depth += 1;
        } else if (char === '}' || char === ']' || char === ')') {
            depth = Math.max(0, depth - 1);
        } else if (char === delimiter && depth === 0) {
            parts.push(source.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(source.slice(start));
    return parts;
}

function indexOfTopLevel(source: string, needle: string): number {
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '{' || char === '[' || char === '(') {
            depth += 1;
        } else if (char === '}' || char === ']' || char === ')') {
            depth = Math.max(0, depth - 1);
        } else if (char === needle && depth === 0) {
            return index;
        }
    }
    return -1;
}

function indexOfTopLevelWord(source: string, word: string): number {
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '{' || char === '[' || char === '(') {
            depth += 1;
        } else if (char === '}' || char === ']' || char === ')') {
            depth = Math.max(0, depth - 1);
        } else if (
            depth === 0
            && source.startsWith(word, index)
            && !isIdentifierPart(source[index - 1])
            && !isIdentifierPart(source[index + word.length])
        ) {
            return index;
        }
    }
    return -1;
}

function stripTopLevelDefault(pattern: string): string {
    const defaultIndex = indexOfTopLevel(pattern, '=');
    return defaultIndex >= 0 ? pattern.slice(0, defaultIndex).trim() : pattern.trim();
}

function stripLocalDeclarationBinding(declaration: string): string {
    const boundaries = [
        indexOfTopLevel(declaration, '='),
        indexOfTopLevelWord(declaration, 'of'),
        indexOfTopLevelWord(declaration, 'in'),
    ].filter((index) => index >= 0);
    const end = boundaries.length > 0 ? Math.min(...boundaries) : declaration.length;
    return declaration.slice(0, end).trim();
}

function findMatchingBrace(source: string, start: number): number {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function addBindingIdentifiers(pattern: string, identifiers: Set<string>): void {
    let binding = stripTopLevelDefault(pattern).replace(/^\s*\.\.\./, '').trim();
    if (!binding) return;
    if (simpleFunctionIdentifierPattern.test(binding)) {
        identifiers.add(binding);
        return;
    }
    if (binding.startsWith('{') && binding.endsWith('}')) {
        const body = binding.slice(1, -1);
        for (const property of splitTopLevel(body, ',')) {
            const propertyBinding = property.trim();
            if (!propertyBinding) continue;
            if (propertyBinding.startsWith('...')) {
                addBindingIdentifiers(propertyBinding, identifiers);
                continue;
            }
            const colonIndex = indexOfTopLevel(propertyBinding, ':');
            if (colonIndex >= 0) {
                addBindingIdentifiers(propertyBinding.slice(colonIndex + 1), identifiers);
            } else {
                addBindingIdentifiers(propertyBinding, identifiers);
            }
        }
        return;
    }
    if (binding.startsWith('[') && binding.endsWith(']')) {
        const body = binding.slice(1, -1);
        for (const element of splitTopLevel(body, ',')) {
            addBindingIdentifiers(element, identifiers);
        }
        return;
    }
    addIdentifiersFromPattern(binding, identifiers);
}

export function addParameterIdentifiers(parameters: string, identifiers: Set<string>): void {
    for (const parameter of splitTopLevel(parameters, ',')) {
        addBindingIdentifiers(parameter, identifiers);
    }
}

function findMatchingParenStart(source: string, start: number): number {
    let depth = 0;
    for (let index = start; index >= 0; index -= 1) {
        const char = source[index];
        if (char === ')') {
            depth += 1;
        } else if (char === '(') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function findMatchingBracketStart(source: string, start: number): number {
    let depth = 0;
    for (let index = start; index >= 0; index -= 1) {
        const char = source[index];
        if (char === ']') {
            depth += 1;
        } else if (char === '[') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function findArrowParameterStart(source: string, arrowIndex: number): number {
    let index = arrowIndex - 1;
    while (index >= 0 && /\s/.test(source[index])) {
        index -= 1;
    }
    if (source[index] === ')') {
        return findMatchingParenStart(source, index);
    }
    while (index >= 0 && isIdentifierPart(source[index])) {
        index -= 1;
    }
    const identifierStart = index + 1;
    const before = source.slice(0, identifierStart).trimEnd();
    if (before.endsWith('async')) {
        const asyncStart = before.length - 'async'.length;
        if (!isIdentifierPart(before[asyncStart - 1])) {
            return asyncStart;
        }
    }
    return identifierStart;
}

function findArrowExpressionEnd(source: string, start: number): number {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (char === '{' || char === '[' || char === '(') {
            depth += 1;
        } else if (char === '}' || char === ']' || char === ')') {
            if (depth === 0) {
                return index - 1;
            }
            depth -= 1;
        } else if ((char === ';' || char === ',') && depth === 0) {
            return index - 1;
        }
    }
    return source.length - 1;
}

function getClassMethodParameters(source: string, headerStart: number, bodyStart: number): string | null {
    const parenEnd = source.lastIndexOf(')', bodyStart);
    if (parenEnd < headerStart) {
        return null;
    }
    const parenStart = findMatchingParenStart(source, parenEnd);
    if (parenStart < headerStart) {
        return null;
    }
    return source.slice(parenStart + 1, parenEnd);
}

function createClassMemberBindingScope(name: string, start: number): FunctionScopeInfo {
    return {
        start,
        end: start + name.length - 1,
        bodyStart: start,
        bodyEnd: start + name.length - 1,
        kind: 'class-member',
        boundIdentifiers: new Set([name]),
    };
}

function createClassFieldInitializerScope(header: string, headerStart: number, className?: string): FunctionScopeInfo | null {
    if (!className) {
        return null;
    }
    const initializerIndex = indexOfTopLevel(header, '=');
    if (initializerIndex < 0) {
        return null;
    }
    const initializerStart = headerStart + initializerIndex + 1;
    const initializerEnd = headerStart + header.length - 1;
    if (initializerEnd < initializerStart) {
        return null;
    }
    return {
        start: initializerStart,
        end: initializerEnd,
        bodyStart: initializerStart,
        bodyEnd: initializerEnd,
        kind: 'class-field',
        boundIdentifiers: new Set([className]),
    };
}

function addClassFieldScopes(scopes: FunctionScopeInfo[], header: string, headerStart: number, className?: string): void {
    const fieldNameScope = getClassFieldNameBinding(header, headerStart);
    if (fieldNameScope) {
        scopes.push(fieldNameScope);
    }
    const initializerScope = createClassFieldInitializerScope(header, headerStart, className);
    if (initializerScope) {
        scopes.push(initializerScope);
    }
}

function addSemicolonlessClassFieldScopes(scopes: FunctionScopeInfo[], header: string, headerStart: number, className?: string): void {
    let lineStart = 0;
    for (const match of header.matchAll(/\r?\n/g)) {
        const lineEnd = match.index ?? 0;
        const line = header.slice(lineStart, lineEnd);
        if (line.trim()) {
            addClassFieldScopes(scopes, line, headerStart + lineStart, className);
        }
        lineStart = lineEnd + match[0].length;
    }
    const line = header.slice(lineStart);
    if (line.trim()) {
        addClassFieldScopes(scopes, line, headerStart + lineStart, className);
    }
}

function getClassMethodNameBinding(header: string, headerStart: number): FunctionScopeInfo | null {
    let remaining = header.trim();
    let offset = header.indexOf(remaining);
    for (;;) {
        const next = remaining.replace(/^(?:static|async|get|set)\s+/, '').trimStart();
        if (next === remaining) {
            break;
        }
        offset += remaining.length - next.length;
        remaining = next;
    }
    const withoutGenerator = remaining.replace(/^\*\s*/, '').trimStart();
    offset += remaining.length - withoutGenerator.length;
    remaining = withoutGenerator;
    if (remaining.startsWith('[')) {
        return null;
    }
    const match = /^#?([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)\s*\(/u.exec(remaining);
    if (!match) {
        return null;
    }
    return createClassMemberBindingScope(match[1], headerStart + offset + match[0].lastIndexOf(match[1]));
}

function stripClassMethodModifiers(header: string): string {
    let remaining = header.trim();
    for (;;) {
        const next = remaining.replace(/^(?:static|async|get|set)\s+/, '').trimStart();
        if (next === remaining) {
            break;
        }
        remaining = next;
    }
    return remaining.replace(/^\*\s*/, '').trimStart();
}

function isClassMethodHeader(header: string): boolean {
    const remaining = stripClassMethodModifiers(header);
    return remaining.startsWith('[') || /^#?[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*\s*\(/u.test(remaining);
}

function getTrailingClassMethodHeader(header: string): { header: string; offset: number } | null {
    const lines = Array.from(header.matchAll(/\r?\n/g));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const lineStart = (lines[index].index ?? 0) + lines[index][0].length;
        const candidate = header.slice(lineStart);
        if (candidate.trim() && isClassMethodHeader(candidate)) {
            return { header: candidate, offset: lineStart };
        }
    }
    return null;
}

function isObjectMethodHeader(header: string): boolean {
    const remaining = stripClassMethodModifiers(header);
    if (/^(?:if|for|while|switch|catch|with)\s*\(/.test(remaining)) {
        return false;
    }
    return remaining.startsWith('(')
        || remaining.startsWith('[')
        || /^(?:\d+(?:\.\d+)?|#?[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)\s*\(/u.test(remaining);
}

function includeMethodModifiers(source: string, start: number): number {
    let methodStart = start;
    for (;;) {
        let previousIndex = previousNonWhitespaceIndex(source, methodStart - 1);
        if (previousIndex >= 0 && source[previousIndex] === '*') {
            methodStart = previousIndex;
            previousIndex = previousNonWhitespaceIndex(source, methodStart - 1);
        }
        if (previousIndex < 0 || !isIdentifierPart(source[previousIndex])) {
            return methodStart;
        }
        let wordStart = previousIndex;
        while (wordStart >= 0 && isIdentifierPart(source[wordStart])) {
            wordStart -= 1;
        }
        const word = source.slice(wordStart + 1, previousIndex + 1);
        if (word !== 'async' && word !== 'get' && word !== 'set') {
            return methodStart;
        }
        methodStart = wordStart + 1;
    }
}

function findObjectMethodHeaderStart(source: string, parenStart: number): number {
    let nameEnd = previousNonWhitespaceIndex(source, parenStart - 1);
    if (nameEnd < 0) {
        return -1;
    }
    if (source[nameEnd] === '{' || source[nameEnd] === ',') {
        return nameEnd + 1;
    }
    let nameStart: number;
    if (source[nameEnd] === ']') {
        nameStart = findMatchingBracketStart(source, nameEnd);
    } else {
        while (nameEnd >= 0 && /\s/.test(source[nameEnd])) {
            nameEnd -= 1;
        }
        nameStart = nameEnd;
        while (nameStart >= 0 && (isIdentifierPart(source[nameStart]) || source[nameStart] === '#')) {
            nameStart -= 1;
        }
        nameStart += 1;
    }
    if (nameStart < 0 || nameStart > nameEnd) {
        return -1;
    }
    const methodStart = includeMethodModifiers(source, nameStart);
    const previousIndex = previousNonWhitespaceIndex(source, methodStart - 1);
    if (previousIndex >= 0 && source[previousIndex] !== '{' && source[previousIndex] !== ',') {
        return -1;
    }
    return methodStart;
}

function getClassFieldNameBinding(header: string, headerStart: number): FunctionScopeInfo | null {
    let remaining = header.trim();
    let offset = header.indexOf(remaining);
    const staticStripped = remaining.replace(/^static\s+/, '').trimStart();
    offset += remaining.length - staticStripped.length;
    remaining = staticStripped;
    if (remaining.startsWith('[')) {
        return null;
    }
    const match = /^#?([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)/u.exec(remaining);
    if (!match) {
        return null;
    }
    return createClassMemberBindingScope(match[1], headerStart + offset + match[0].lastIndexOf(match[1]));
}

function findClassBodyStart(source: string, classIndex: number): number {
    let depth = 0;
    for (let index = classIndex + 'class'.length; index < source.length; index += 1) {
        if (
            depth === 0
            && source.startsWith('class', index)
            && !isIdentifierPart(source[index - 1])
            && !isIdentifierPart(source[index + 'class'.length])
        ) {
            const nestedClassBodyStart = findClassBodyStart(source, index);
            const nestedClassBodyEnd = nestedClassBodyStart > index ? findMatchingBrace(source, nestedClassBodyStart) : -1;
            if (nestedClassBodyEnd > nestedClassBodyStart) {
                index = nestedClassBodyEnd;
                continue;
            }
        }
        const char = source[index];
        if (char === '(' || char === '[') {
            depth += 1;
        } else if (char === ')' || char === ']') {
            depth = Math.max(0, depth - 1);
        } else if (char === '{' && depth === 0) {
            return index;
        }
    }
    return -1;
}

function previousNonWhitespaceIndex(source: string, start: number): number {
    for (let index = start; index >= 0; index -= 1) {
        if (!/\s/.test(source[index])) {
            return index;
        }
    }
    return -1;
}

function isClassDeclarationBinding(source: string, classIndex: number): boolean {
    const previousIndex = previousNonWhitespaceIndex(source, classIndex - 1);
    if (previousIndex < 0) {
        return true;
    }
    return source[previousIndex] === '{' || source[previousIndex] === '}' || source[previousIndex] === ';';
}

function findClassMemberScopes(source: string): FunctionScopeInfo[] {
    const scopes: FunctionScopeInfo[] = [];
    for (const match of source.matchAll(/\bclass(?:\s+([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*))?/gu)) {
        const classIndex = match.index ?? 0;
        const className = match[1];
        if (className) {
            scopes.push(createClassMemberBindingScope(className, classIndex + match[0].lastIndexOf(className)));
        }
        const classBodyStart = findClassBodyStart(source, classIndex);
        if (classBodyStart <= classIndex) {
            continue;
        }
        const classBodyEnd = findMatchingBrace(source, classBodyStart);
        if (classBodyEnd <= classBodyStart) {
            continue;
        }

        let memberIndex = classBodyStart + 1;
        while (memberIndex < classBodyEnd) {
            while (memberIndex < classBodyEnd && (/[\s;]/.test(source[memberIndex]))) {
                memberIndex += 1;
            }
            if (memberIndex >= classBodyEnd) {
                break;
            }
            const memberStart = memberIndex;
            let memberClosed = false;
            let depth = 0;
            for (let index = memberStart; index < classBodyEnd; index += 1) {
                const char = source[index];
                if (char === '(' || char === '[') {
                    depth += 1;
                } else if (char === ')' || char === ']') {
                    depth = Math.max(0, depth - 1);
                } else if (char === '{' && depth === 0) {
                    const header = source.slice(memberStart, index).trim();
                    let parameters = getClassMethodParameters(source, memberStart, index);
                    const isStaticBlock = parameters === null && header === 'static';
                    let methodStart = memberStart;
                    let methodHeader = header;
                    let isMethod = isStaticBlock || (parameters !== null && isClassMethodHeader(header));
                    if (!isMethod && parameters !== null) {
                        const trailingMethodHeader = getTrailingClassMethodHeader(source.slice(memberStart, index));
                        if (trailingMethodHeader) {
                            addSemicolonlessClassFieldScopes(
                                scopes,
                                source.slice(memberStart, memberStart + trailingMethodHeader.offset),
                                memberStart,
                                className,
                            );
                            methodStart = memberStart + trailingMethodHeader.offset;
                            methodHeader = trailingMethodHeader.header;
                            parameters = getClassMethodParameters(source, methodStart, index);
                            isMethod = true;
                        }
                    }
                    const hasFieldInitializer = indexOfTopLevel(header, '=') >= 0;
                    if (!isMethod && hasFieldInitializer) {
                        const bodyEnd = findMatchingBrace(source, index);
                        if (bodyEnd <= index) {
                            memberIndex = index + 1;
                            memberClosed = true;
                            break;
                        }
                        index = bodyEnd;
                        continue;
                    }
                    const bodyEnd = findMatchingBrace(source, index);
                    if (bodyEnd <= index) {
                        memberIndex = index + 1;
                        memberClosed = true;
                        break;
                    }
                    if (isMethod) {
                        const methodNameScope = getClassMethodNameBinding(methodHeader, methodStart);
                        if (methodNameScope) {
                            scopes.push(methodNameScope);
                        }
                        const boundIdentifiers = new Set<string>();
                        if (parameters !== null) {
                            addParameterIdentifiers(parameters, boundIdentifiers);
                        }
                        if (className) {
                            boundIdentifiers.add(className);
                        }
                        scopes.push({
                            start: methodStart,
                            end: bodyEnd,
                            bodyStart: index,
                            bodyEnd,
                            kind: 'class-method',
                            boundIdentifiers,
                        });
                        memberIndex = bodyEnd + 1;
                        memberClosed = true;
                        break;
                    }
                    index = bodyEnd;
                } else if (char === ';' && depth === 0) {
                    const header = source.slice(memberStart, index);
                    addClassFieldScopes(scopes, header, memberStart, className);
                    memberIndex = index + 1;
                    memberClosed = true;
                    break;
                }
            }
            if (!memberClosed) {
                const header = source.slice(memberStart, classBodyEnd);
                addClassFieldScopes(scopes, header, memberStart, className);
                break;
            }
        }
    }
    return scopes;
}

function findObjectMethodScopes(source: string): FunctionScopeInfo[] {
    const scopes: FunctionScopeInfo[] = [];
    for (let bodyStart = 0; bodyStart < source.length; bodyStart += 1) {
        if (source[bodyStart] !== '{') {
            continue;
        }
        const parenEnd = previousNonWhitespaceIndex(source, bodyStart - 1);
        if (parenEnd < 0 || source[parenEnd] !== ')') {
            continue;
        }
        const parenStart = findMatchingParenStart(source, parenEnd);
        if (parenStart < 0) {
            continue;
        }
        const headerStart = findObjectMethodHeaderStart(source, parenStart);
        if (headerStart < 0) {
            continue;
        }
        const header = source.slice(headerStart, bodyStart).trim();
        if (!isObjectMethodHeader(header)) {
            continue;
        }
        const bodyEnd = findMatchingBrace(source, bodyStart);
        if (bodyEnd <= bodyStart) {
            continue;
        }
        const methodNameScope = getClassMethodNameBinding(header, headerStart);
        if (methodNameScope) {
            scopes.push({
                ...methodNameScope,
                kind: 'object-member',
            });
        }
        const boundIdentifiers = new Set<string>();
        addParameterIdentifiers(source.slice(parenStart + 1, parenEnd), boundIdentifiers);
        scopes.push({
            start: headerStart,
            end: bodyEnd,
            bodyStart,
            bodyEnd,
            kind: 'object-method',
            boundIdentifiers,
        });
        bodyStart = bodyEnd;
    }
    return scopes;
}

export function addScopedLocalIdentifiers(
    source: string,
    start: number,
    end: number,
    identifiers: Set<string>,
    excludedRanges: ReadonlyArray<{ start: number; end: number }>,
    blockScopes: FunctionScopeInfo[] = [],
): void {
    for (const binding of collectLocalDeclarationBindings(source, start, end, excludedRanges)) {
        if (binding.kind === 'class' && !isClassDeclarationBinding(source, binding.index)) continue;
        const boundIdentifiers = new Set<string>();
        if (binding.kind === 'class' || binding.kind === 'catch') addBindingIdentifiers(binding.pattern, boundIdentifiers);
        else for (const declaration of splitTopLevel(binding.pattern, ',')) {
            addBindingIdentifiers(stripLocalDeclarationBinding(declaration), boundIdentifiers);
        }
        if (binding.scope === undefined) {
            for (const identifier of boundIdentifiers) identifiers.add(identifier);
        } else if (binding.scope) {
            blockScopes.push({ ...binding.scope, bodyStart: binding.scope.start,
                bodyEnd: binding.scope.end, kind: 'block', boundIdentifiers });
        }
    }
}

export function findParentFunctionScope(scope: FunctionScopeInfo, scopes: readonly FunctionScopeInfo[]): FunctionScopeInfo | null {
    let parent: FunctionScopeInfo | null = null;
    for (const candidate of scopes) {
        if (candidate === scope || candidate.start >= scope.start || candidate.end < scope.end) {
            continue;
        }
        if (!parent || (candidate.end - candidate.start) < (parent.end - parent.start)) {
            parent = candidate;
        }
    }
    return parent;
}

export function findNestedFunctionScopes(source: string, rootArrowIndex: number, rootFunctionIndex: number): FunctionScopeInfo[] {
    const scopes: FunctionScopeInfo[] = [];
    for (const match of source.matchAll(/\bfunction\b/g)) {
        const functionIndex = match.index ?? 0;
        if (functionIndex === rootFunctionIndex) {
            continue;
        }
        const bodyStart = source.indexOf('{', functionIndex);
        if (bodyStart <= 0) {
            continue;
        }
        const bodyEnd = findMatchingBrace(source, bodyStart);
        if (bodyEnd > bodyStart) {
            const header = source.slice(functionIndex, bodyStart);
            const functionMatch = /function(?:\s+([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*))?\s*\(([^)]*)\)/u.exec(header);
            const boundIdentifiers = new Set<string>();
            if (functionMatch?.[1]) {
                boundIdentifiers.add(functionMatch[1]);
            }
            addParameterIdentifiers(functionMatch?.[2] ?? '', boundIdentifiers);
            scopes.push({
                start: functionIndex,
                end: bodyEnd,
                bodyStart,
                bodyEnd,
                name: functionMatch?.[1],
                kind: 'function',
                boundIdentifiers,
            });
        }
    }

    for (const match of source.matchAll(/=>/g)) {
        const arrowIndex = match.index ?? 0;
        if (arrowIndex === rootArrowIndex) {
            continue;
        }
        const paramsStart = findArrowParameterStart(source, arrowIndex);
        if (paramsStart < 0) {
            continue;
        }
        let bodyStart = arrowIndex + 2;
        while (bodyStart < source.length && /\s/.test(source[bodyStart])) {
            bodyStart += 1;
        }
        const bodyEnd = source[bodyStart] === '{'
            ? findMatchingBrace(source, bodyStart)
            : findArrowExpressionEnd(source, bodyStart);
        if (bodyEnd > bodyStart) {
            let params = source.slice(paramsStart, arrowIndex).trim().replace(/^async\s+/, '').trim();
            if (params.startsWith('(')) {
                params = params.slice(1, params.lastIndexOf(')'));
            }
            const boundIdentifiers = new Set<string>();
            addParameterIdentifiers(params, boundIdentifiers);
            scopes.push({
                start: paramsStart,
                end: bodyEnd,
                bodyStart,
                bodyEnd,
                kind: 'arrow',
                boundIdentifiers,
            });
        }
    }
    scopes.push(...findClassMemberScopes(source));
    scopes.push(...findObjectMethodScopes(source));
    scopes.sort((left, right) => left.start - right.start || right.end - left.end);

    const blockScopes: FunctionScopeInfo[] = [];
    for (const scope of scopes) {
        if (scope.kind === 'class-member' || scope.kind === 'object-member') {
            continue;
        }
        const childScopes = scopes.filter((candidate) => candidate !== scope && candidate.start > scope.start && candidate.end <= scope.end);
        addScopedLocalIdentifiers(source, scope.bodyStart, scope.bodyEnd, scope.boundIdentifiers, childScopes, blockScopes);
        for (const childScope of childScopes) {
            if (childScope.kind !== 'function' || !childScope.name) {
                continue;
            }
            const parent = findParentFunctionScope(childScope, scopes);
            if (parent === scope) {
                scope.boundIdentifiers.add(childScope.name);
            }
        }
    }

    return [...scopes, ...blockScopes];
}

export function isBoundByNestedFunctionScope(identifier: string, index: number, scopes: readonly FunctionScopeInfo[]): boolean {
    return scopes.some((scope) => index >= scope.start && index <= scope.end && scope.boundIdentifiers.has(identifier));
}
