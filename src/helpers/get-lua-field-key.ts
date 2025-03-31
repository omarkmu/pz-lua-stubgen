/**
 * Converts a Lua literal to the key to use as a table field.
 * Strings that are valid Lua identifiers will use the internal string directly.
 */
export const getLuaFieldKey = (literal: string): string => {
    let key = literal
    if (key.startsWith('"') && key.endsWith('"')) {
        key = key.slice(1, -1)
    }

    // match on valid Lua identifier
    if (/^[a-zA-Z_][\w_]*$/.exec(key)) {
        return key
    }

    return `[${literal}]`
}
