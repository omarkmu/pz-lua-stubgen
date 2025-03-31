export const expect = (
    value: any,
    type: string,
    name?: string,
    optional = false,
): boolean => {
    const given = typeof value
    if (given === type) {
        return true
    }

    if (type === 'array' && Array.isArray(value)) {
        return true
    }

    if (optional && (value === undefined || value === null)) {
        return false
    }

    if (name) {
        throw new Error(`Expected ${type} for ${name} (got ${given})`)
    }

    throw new Error(`Expected ${type} (got ${given})`)
}

export const expectField = (
    value: any,
    name: string,
    type: string,
    optional = true,
): boolean => {
    const fields = name.split('.')

    let expectArray = false
    if (type === 'array') {
        expectArray = true
        type = 'object'
    }

    const names: string[] = []
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        value = value[field]
        names.push(field)

        const given = typeof value
        const isTarget = i === fields.length - 1
        const expected = isTarget ? type : 'object'

        if (given === expected) {
            continue
        }

        if (optional && (value === undefined || value == null)) {
            return false
        }

        const name = names.join('.')
        throw new Error(
            `Expected ${expected} for field '${name}' (got ${given})`,
        )
    }

    if (expectArray && !Array.isArray(value)) {
        throw new Error(
            `Expected array for field '${name}' (got ${typeof value})`,
        )
    }

    return true
}
