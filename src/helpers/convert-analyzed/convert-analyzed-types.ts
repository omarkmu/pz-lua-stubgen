export const convertAnalyzedTypes = (
    types: Set<string>,
): [string | undefined, boolean] => {
    types = new Set(types)
    const nullable = types.delete('nil')

    if (types.size === 0) {
        return [undefined, nullable]
    }

    return [[...types].join(' | '), nullable]
}
