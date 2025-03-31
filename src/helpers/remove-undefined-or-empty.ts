export const removeUndefinedOrEmpty = <T extends Record<string, any>>(
    obj: T,
): T => {
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined) {
            delete obj[key]
        }

        if (typeof value !== 'object') {
            continue
        }

        if (Array.isArray(value)) {
            if (value.length === 0) {
                delete obj[key]
            }

            continue
        }

        if (Object.keys(value).length === 0) {
            delete obj[key]
        }
    }

    return obj
}
