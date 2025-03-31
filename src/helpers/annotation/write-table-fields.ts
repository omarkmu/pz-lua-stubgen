import { TableField } from '../../analysis'
import { RosettaField } from '../../rosetta'
import { getExpressionString } from './get-expression-string'
import { getFunctionPrefixFromExpression } from './get-function-prefix-from-expression'
import { getRosettaTypeString } from './get-rosetta-type-string'
import { getTypeString } from './get-type-string'
import { getValueString } from './get-value-string'
import { isLiteralTable } from './is-literal-table'
import { writeNotes } from './write-notes'

export const writeTableFields = (
    fields: TableField[],
    out: string[],
    allowAmbiguous: boolean,
    depth: number = 1,
    writtenFields?: Set<string>,
    rosettaFields?: Record<string, RosettaField>,
): Set<string> => {
    writtenFields ??= new Set()
    const tab = '    '.repeat(depth)

    let nextAutoKey = 1
    for (const [i, field] of fields.entries()) {
        let skip = false
        let keyString: string | undefined
        const key = field.key
        switch (key.type) {
            case 'string':
                keyString = key.name
                break

            case 'literal':
                keyString = `[${key.literal}]`
                if (key.name) {
                    skip = writtenFields.has(key.name)
                    writtenFields.add(key.name)
                }

                break

            case 'expression':
                const exprString = getExpressionString(
                    key.expression,
                    allowAmbiguous,
                )

                keyString = `[${exprString}]`
                break
        }

        let rosettaField: RosettaField | undefined
        if (skip) {
            continue
        } else if (keyString) {
            if (writtenFields.has(keyString)) {
                continue
            }

            rosettaField = rosettaFields?.[keyString]
            writtenFields.add(keyString)
        } else {
            const autoKey = `[${nextAutoKey}]`
            nextAutoKey++

            if (writtenFields.has(autoKey)) {
                continue
            }

            rosettaField = rosettaFields?.[autoKey]
            writtenFields.add(autoKey)
        }

        const isRef = field.value.type === 'reference'
        let hasRosettaType = false
        let typeString: string | undefined
        if (rosettaField?.type || rosettaField?.nullable !== undefined) {
            typeString = getRosettaTypeString(
                rosettaField.type,
                rosettaField.nullable,
            )

            hasRosettaType = true
        } else if (field.types && field.types.size > 0 && !isRef) {
            typeString = getTypeString(field.types, allowAmbiguous)
        }

        let funcString: string | undefined
        if (!typeString && field.value.type === 'literal') {
            funcString = getFunctionPrefixFromExpression(
                field.value,
                allowAmbiguous,
                depth,
            )
        }

        const isTable = isLiteralTable(field.value)

        let valueString: string
        ;[valueString, typeString] = getValueString(
            field.value,
            rosettaField,
            typeString,
            hasRosettaType,
            isTable,
            allowAmbiguous,
            depth + 1,
        )

        if (isTable && typeString && valueString !== 'nil') {
            if (i > 0) {
                out.push('\n')
            }

            writeNotes(rosettaField?.notes, out, tab)
            out.push(`\n${tab}---@type ${typeString}`)
            typeString = undefined
        } else if (funcString) {
            if (i > 0) {
                out.push('\n')
            }

            writeNotes(rosettaField?.notes, out, tab)
            out.push(funcString)
            typeString = undefined
        } else {
            writeNotes(rosettaField?.notes, out, tab)
        }

        out.push('\n')
        out.push(tab)

        if (keyString) {
            out.push(keyString)
            out.push(' = ')
        }

        out.push(valueString)
        out.push(',')

        if (typeString) {
            out.push(` ---@type ${typeString}`)
        }
    }

    return writtenFields
}
