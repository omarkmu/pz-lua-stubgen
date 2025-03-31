/**
 * Reads string contents from a raw Lua string literal.
 */
export const readLuaStringLiteral = (raw: string): string | undefined => {
    if (raw.startsWith('"') && raw.endsWith('"')) {
        return raw.slice(1, -1)
    } else if (raw.startsWith("'") && raw.endsWith("'")) {
        return raw.slice(1, -1)
    }

    // read multiline strings
    const start = /^\[(=*)\[/.exec(raw)
    if (!start) {
        return
    }

    const end = raw.indexOf(']' + '='.repeat(start[1].length) + ']')
    if (end === -1) {
        return
    }

    return raw.slice(start[0].length, end)
}
