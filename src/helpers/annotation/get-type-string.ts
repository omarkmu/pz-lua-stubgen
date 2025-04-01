export const getTypeString = (
    types: Set<string>,
    allowAmbiguous: boolean = true,
): string => {
    types = new Set(types)
    const nullable = types.delete('nil')

    if (!allowAmbiguous && types.size > 1) {
        return nullable ? 'unknown?' : 'unknown'
    }

    const type = types.size > 0 ? [...types].join(' | ') : 'unknown'
    if (nullable) {
        return type.includes('|') || type.startsWith('fun(')
            ? `(${type})?`
            : `${type}?`
    }

    return type
}
