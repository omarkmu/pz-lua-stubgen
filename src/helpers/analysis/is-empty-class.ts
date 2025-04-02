import { AnalyzedClass } from '../../analysis'

/**
 * Checks whether an analyzed class has no associated information.
 * @param cls
 */
export const isEmptyClass = (cls: AnalyzedClass): boolean => {
    return (
        cls.fields.length === 0 &&
        cls.literalFields.length === 0 &&
        cls.staticFields.length === 0 &&
        cls.functions.length === 0 &&
        cls.methods.length === 0 &&
        cls.constructors.length === 0 &&
        cls.functionConstructors.length === 0 &&
        cls.overloads.length === 0
    )
}
