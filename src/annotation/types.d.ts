import { BaseAnnotateArgs } from '../base'

/**
 * Arguments for annotation.
 */
export interface AnnotateArgs extends BaseAnnotateArgs {
    /**
     * Whether fields and functions in the generated stubs should be alphabetized.
     */
    alphabetize: boolean

    /**
     * Whether to include the kahlua stub in generated output.
     */
    includeKahlua: boolean

    /**
     * Whether fields should be treated as strict.
     */
    strictFields: boolean

    /**
     * Whether ambiguous analyzed types are allowed.
     */
    ambiguity: boolean
}
