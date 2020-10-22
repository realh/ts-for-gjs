import TemplateProcessor from './template-processor'
import { Transformation, C_TYPE_MAP, FULL_TYPE_MAP, POD_TYPE_MAP, POD_TYPE_MAP_ARRAY } from './transformation'
import { Logger } from './logger'
import { Utils } from './utils'

import {
    GirRepository,
    GirNamespace,
    GirAlias,
    GirEnumeration,
    GirFunction,
    GirClass,
    GirVariable,
    GirArray,
    GirType,
    GirInclude,
    GirParameter,
    TypeArraySuffix,
    TypeNullableSuffix,
    TypeSuffix,
    SymTable,
    GirConstruct,
    InheritanceTable,
    ParsedGir,
    GenerateConfig,
    FunctionDescription,
    FunctionMap,
    LocalNames,
    ClassDetails,
} from './types'

const signalMethods = ['connect', 'connect_after', 'disconnect', 'emit']

/**
 * In gjs all classes have a static name property but the classes listed below already have a static name property
 */
export const STATIC_NAME_ALREADY_EXISTS = ['GMime.Charset', 'Camel.StoreInfo']

export const MAXIMUM_RECUSION_DEPTH = 100

export class GirModule {
    /**
     * E.g. 'Gtk'
     */
    name: string
    /**
     * E.g. '3.0'
     */
    version = '0.0'
    /**
     * E.g. 'Gtk-3.0'
     */
    packageName: string
    /**
     * E.g. 'Gtk30'
     * Is used in the generated index.d.ts, for example: `import * as Gtk30 from "./Gtk-3.0";`
     */
    importName: string
    dependencies: string[] = []
    transitiveDependencies: string[] = []
    repo: GirRepository
    ns: GirNamespace = { $: { name: '', version: '' } }
    /**
     * Used to find namespaces that are used in other modules
     */
    symTable: SymTable = {}
    patch: { [key: string]: string[] } = {}
    transformation: Transformation
    extends?: string
    log: Logger

    /**
     * To prevent constants from being exported twice, the names already exported are saved here for comparison.
     * Please note: Such a case is only known for Zeitgeist-2.0 with the constant "ATTACHMENT"
     */
    constNames: { [varName: string]: 1 } = {}

    private commentRegExp = /\/\*.*\*\//g
    private paramRegExp = /[0-9a-zA-Z_]*:/g
    private optParamRegExp = /[0-9a-zA-Z_]*\?:/g

    constructor(xml: ParsedGir, private readonly config: GenerateConfig) {
        this.repo = xml.repository

        if (!this.repo.namespace || !this.repo.namespace.length) {
            throw new Error(`Namespace not found!`)
        }
        if (this.repo.include) {
            this.dependencies = this.loadDependencies(this.repo.include)
        }
        this.ns = this.repo.namespace[0]
        this.name = this.ns.$.name
        this.version = this.ns.$.version
        this.packageName = `${this.name}-${this.version}`
        this.transformation = new Transformation(this.packageName, config)
        this.log = new Logger(config.environment, config.verbose, this.packageName || 'GirModule')
        this.importName = this.transformation.transformModuleNamespaceName(this.packageName)
    }

    private loadDependencies(girInclude: GirInclude[]): string[] {
        const dependencies: string[] = []
        for (const i of girInclude) {
            dependencies.unshift(`${i.$.name}-${i.$.version}`)
        }
        return dependencies
    }

    private annotateFunctionArguments(girFunc: GirFunction): void {
        const funcName = girFunc._fullSymName
        if (girFunc.parameters) {
            for (const girParam of girFunc.parameters) {
                if (girParam.parameter) {
                    for (const girVar of girParam.parameter) {
                        girVar._module = this
                        if (girVar.$ && girVar.$.name) {
                            girVar._fullSymName = `${funcName}.${girVar.$.name}`
                        }
                    }
                }
            }
        }
    }

    private annotateFunctionReturn(girFunc: GirFunction): void {
        const retVals: GirVariable[] | undefined = girFunc['return-value']
        if (retVals)
            for (const retVal of retVals) {
                retVal._module = this
                if (retVal.$ && retVal.$.name) {
                    retVal._fullSymName = `${girFunc._fullSymName}.${retVal.$.name}`
                }
            }
    }

    private annotateFunctions(girClass: GirClass | null, funcs: GirFunction[]): void {
        if (funcs)
            for (const func of funcs) {
                if (func.$ && func.$.name) {
                    const nsName = girClass ? girClass._fullSymName : this.name
                    func._fullSymName = `${nsName}.${func.$.name}`
                    this.annotateFunctionArguments(func)
                    this.annotateFunctionReturn(func)
                }
            }
    }

    private annotateVariables(girClass: GirClass | null, girVars?: GirVariable[]): void {
        if (girVars)
            for (const girVar of girVars) {
                const nsName = girClass ? girClass._fullSymName : this.name
                girVar._module = this
                if (girVar.$ && girVar.$.name) {
                    girVar._fullSymName = `${nsName}.${girVar.$.name}`
                }
            }
    }

    private loadTypesInternal(dict: SymTable, girConstructs?: GirConstruct[]): void {
        if (girConstructs) {
            for (const girConstruct of girConstructs) {
                if (girConstruct?.$) {
                    if ((girConstruct as GirVariable | GirFunction).$.introspectable) {
                        if (!this.girBool((girConstruct as GirVariable | GirFunction).$.introspectable, true)) continue
                    }
                    const symName = `${this.name}.${girConstruct.$.name}`
                    if (dict[symName]) {
                        this.log.warn(`Duplicate symbol: ${symName}`)
                        debugger
                    }

                    girConstruct._module = this
                    girConstruct._fullSymName = symName
                    dict[symName] = girConstruct
                }
            }
        }
    }

    public loadTypes(dict: SymTable): void {
        this.loadTypesInternal(dict, this.ns.bitfield)
        this.loadTypesInternal(dict, this.ns.callback)
        this.loadTypesInternal(dict, this.ns.class)
        this.loadTypesInternal(dict, this.ns.constant)
        this.loadTypesInternal(dict, this.ns.enumeration)
        this.loadTypesInternal(dict, this.ns.function)
        this.loadTypesInternal(dict, this.ns.interface)
        this.loadTypesInternal(dict, this.ns.record)
        this.loadTypesInternal(dict, this.ns.union)
        this.loadTypesInternal(dict, this.ns.alias)

        if (this.ns.callback) for (const func of this.ns.callback) this.annotateFunctionArguments(func)

        const girClasses = (this.ns.class ? this.ns.class : [])
            .concat(this.ns.record ? this.ns.record : [])
            .concat(this.ns.interface ? this.ns.interface : [])

        for (const girClass of girClasses) {
            girClass._module = this
            girClass._fullSymName = `${this.name}.${girClass.$.name}`
            const cons = girClass.constructor instanceof Array ? girClass.constructor : []
            this.annotateFunctions(girClass, cons)
            this.annotateFunctions(girClass, girClass.function || [])
            this.annotateFunctions(girClass, girClass.method || [])
            this.annotateFunctions(girClass, girClass['virtual-method'] || [])
            this.annotateFunctions(girClass, girClass['glib:signal'] || [])
            this.annotateVariables(girClass, girClass.property)
            this.annotateVariables(girClass, girClass.field)
        }

        if (this.ns.function) this.annotateFunctions(null, this.ns.function)

        if (this.ns.constant) this.annotateVariables(null, this.ns.constant)

        // if (this.ns.)
        // props

        this.symTable = dict
    }

    public loadInheritance(inheritanceTable: InheritanceTable): void {
        // Class hierarchy
        for (const cls of this.ns.class ? this.ns.class : []) {
            let parent: string | null = null
            if (cls.$ && cls.$.parent) parent = cls.$.parent
            if (!parent) continue
            if (!cls._fullSymName) continue

            if (parent.indexOf('.') < 0) {
                parent = this.name + '.' + parent
            }
            const clsName = cls._fullSymName

            const arr: string[] = inheritanceTable[clsName] || []
            arr.push(parent)
            inheritanceTable[clsName] = arr
        }

        // Class interface implementations
        for (const cls of this.ns.class ? this.ns.class : []) {
            if (!cls._fullSymName) continue

            const names: string[] = []

            for (const i of cls.implements ? cls.implements : []) {
                if (i.$.name) {
                    let name: string = i.$.name
                    if (name.indexOf('.') < 0) {
                        name = cls._fullSymName.substring(0, cls._fullSymName.indexOf('.') + 1) + name
                    }
                    names.push(name)
                }
            }

            if (names.length > 0) {
                const clsName = cls._fullSymName
                const arr: string[] = inheritanceTable[clsName] || []
                inheritanceTable[clsName] = arr.concat(names)
            }
        }
    }

    private typeLookup(girVar: GirVariable): string {
        let type: GirType | null
        let arr: TypeArraySuffix = ''
        let arrCType: string | undefined
        let nul: TypeNullableSuffix = ''

        const collection = girVar.array
            ? girVar.array
            : girVar.type && /^GLib.S?List$/.test(girVar.type[0].$?.name)
            ? (girVar.type as GirArray[])
            : undefined

        if (collection && collection.length > 0) {
            const typeArray = collection[0].type
            if (!typeArray || typeArray.length === 0) return 'any'
            if (collection[0].$) {
                const ea = collection[0].$
                arrCType = ea['c:type']
            }
            type = typeArray[0]
            arr = '[]'
        } else if (girVar.type) {
            type = girVar.type[0]
        } else if (girVar.callback?.length) {
            type = null
        } else {
            return 'any'
        }

        if (girVar.$) {
            const nullable = this.paramIsNullable(girVar)
            if (nullable) {
                nul = ' | null'
            }
        }

        const suffix: TypeSuffix = (arr + nul) as TypeSuffix
        let fullTypeName: string | null

        if (girVar.callback?.length) {
            fullTypeName = this.getFunction(girVar.callback[0], '', '', undefined, true)[0][0]
            if (suffix.length)
                fullTypeName = '(' + fullTypeName + ')'
        } else {
            if (!type?.$) return 'any'

            if (arr) {
                if (POD_TYPE_MAP_ARRAY(this.config.environment)[type.$.name]) {
                    return POD_TYPE_MAP_ARRAY(this.config.environment)[type.$.name] + nul
                }
            }

            if (POD_TYPE_MAP[type.$.name]) {
                return POD_TYPE_MAP[type.$.name] + suffix
            }

            if (!this.name) return 'any'

            let cType = type.$['c:type']
            if (!cType && arrCType) cType = arrCType

            if (cType) {
                if (C_TYPE_MAP(this.packageName, suffix)[cType]) {
                    return C_TYPE_MAP(this.packageName, suffix)[cType]
                }
            }

            fullTypeName = type.$.name

            if (typeof fullTypeName === 'string') {
                if (FULL_TYPE_MAP(this.config.environment)[fullTypeName]) {
                    return FULL_TYPE_MAP(this.config.environment)[fullTypeName]
                }

                // Fully qualify our type name if need be
                if (!fullTypeName.includes('.')) {
                    // eslint-disable-next-line @typescript-eslint/no-this-alias
                    let mod: GirModule = this
                    if (girVar._module) mod = girVar._module
                    fullTypeName = `${mod.name}.${type.$.name}`
                }
            }

            if (!fullTypeName || !this.symTable[fullTypeName]) {
                this.log.warn(`Could not find type '${fullTypeName}' for '${girVar.$.name}'`)
                return ('any' + arr) as 'any' | 'any[]'
            }

            if (fullTypeName.indexOf(this.name + '.') === 0) {
                const ret = fullTypeName.substring(this.name.length + 1)
                // this.log.warn(`Rewriting ${fullTypeName} to ${ret} + ${suffix} -- ${this.name} -- ${girVar._module}`)
                const result = ret + suffix
                return result
            }
        }

        return fullTypeName + suffix
    }

    /**
     * E.g. replaces something like `NetworkManager.80211ApFlags` with `NetworkManager.TODO_80211ApFlags`
     * @param girVar
     */
    private typeLookupTransformed(girVar: GirVariable): string {
        let names = this.typeLookup(girVar).split('.')
        names = names.map((name) => this.transformation.transformTypeName(name))
        return names.join('.')
    }

    private girBool(e: string | undefined, defaultVal = false): boolean {
        if (e) {
            if (parseInt(e) === 0) return false
            return true
        }
        return defaultVal
    }

    private getReturnType(func: GirFunction): [string, number] {
        let returnType = 'void'
        let outArrayLengthIndex = -1

        const returnVal = func['return-value'] ? func['return-value'][0] : null
        if (returnVal) {
            returnType = this.typeLookupTransformed(returnVal)
            outArrayLengthIndex =
                returnVal.array && returnVal.array[0].$?.length ? Number(returnVal.array[0].$.length) : -1
        }

        return [returnType, outArrayLengthIndex] as [string, number]
    }

    private arrayLengthIndexLookup(param: GirVariable): number {
        if (!param.array) return -1

        const arr: GirArray = param.array[0]
        if (!arr.$) return -1

        if (arr.$.length) {
            return parseInt(arr.$.length)
        }

        return -1
    }

    private closureDataIndexLookup(param: GirVariable): number {
        if (!param.$.closure) return -1

        return parseInt(param.$.closure)
    }

    private destroyDataIndexLookup(param: GirVariable): number {
        if (!param.$.destroy) return -1

        return parseInt(param.$.destroy)
    }

    private processParams(
        parametersArray: GirVariable[],
        skip: GirVariable[],
        getIndex: (param: GirVariable) => number,
    ): void {
        for (const param of parametersArray as GirVariable[]) {
            const index = getIndex(param)
            if (index < 0) continue
            if (index >= parametersArray.length) continue
            skip.push(parametersArray[index])
        }
    }

    /**
     * Checks if the parameter is nullable or optional.
     * TODO Check if it makes sence to split this in `paramIsNullable` and `paramIsOptional`
     *
     * @param param Param to test
     *
     * @author realh
     * @see https://github.com/realh/ts-for-gjs/commit/e4bdba8d4ca279dfa4abbca413eaae6ecc6a81f8
     */
    private paramIsNullable(param: GirVariable): boolean {
        const a = param.$
        return a && (this.girBool(a.nullable) || this.girBool(a['allow-none']) || this.girBool(a.optional))
    }

    private getParameters(outArrayLengthIndex: number, parameters?: GirParameter[]): [string, string[]] {
        const def: string[] = []
        const outParams: string[] = []

        if (parameters && parameters.length > 0) {
            const parametersArray = parameters[0].parameter || []
            // Instance parameter needs to be exposed for class methods (see comment above getClassMethods())
            const instanceParameter = parameters[0]["instance-parameter"]
            if (instanceParameter && instanceParameter[0])
            {
                const typeName = instanceParameter[0].type ? instanceParameter[0].type[0].$.name : undefined
                const rec = typeName ? this.ns.record?.find((r) => r.$.name == typeName) : undefined
                const structFor = rec?.$['glib:is-gtype-struct-for']
                const gobject = (this.name === "GObject" || this.name === "GLib") ? '' : 'GObject.'
                if (structFor) {
                    // TODO: Should use of a constructor, and even of an instance, be discouraged?
                    def.push(`${instanceParameter[0].$.name}: ${structFor} | Function | ${gobject}Type`)
                }
            }
            if (parametersArray.length) {
                const skip = outArrayLengthIndex === -1 ? [] : [parametersArray[outArrayLengthIndex]]

                this.processParams(parametersArray, skip, this.arrayLengthIndexLookup)
                this.processParams(parametersArray, skip, this.closureDataIndexLookup)
                this.processParams(parametersArray, skip, this.destroyDataIndexLookup)

                for (const param of parametersArray as GirVariable[]) {
                    const paramName = this.transformation.transformParameterName(param.$.name || '-', false)
                    const paramType = this.typeLookupTransformed(param)

                    if (skip.indexOf(param) !== -1) {
                        continue
                    }

                    const optDirection = param.$.direction
                    if (optDirection) {
                        if (optDirection === 'out' || optDirection == 'inout') {
                            outParams.push(`/* ${paramName} */ ${paramType}`)
                            if (optDirection == 'out') continue
                        }
                    }

                    let isOptional = this.paramIsNullable(param) ? '?' : ''

                    if (isOptional === '?') {
                        const index = parametersArray.indexOf(param)
                        const following = (parametersArray as GirVariable[])
                            .slice(index)
                            .filter(() => skip.indexOf(param) === -1)
                            .filter((p) => p.$.direction !== 'out')

                        if (following.some((p) => !this.paramIsNullable(p))) {
                            isOptional = ''
                        }
                    }

                    const paramDesc = `${paramName}${isOptional}: ${paramType}`
                    def.push(paramDesc)
                }
            }
        }

        return [def.join(', '), outParams]
    }

    private getVariable(
        v: GirVariable,
        optional = false,
        allowQuotes = false,
        type: 'property' | 'constant' | 'field',
    ): FunctionDescription {
        if (!v.$.name) return [[], null]
        if (!v || !v.$ || !this.girBool(v.$.introspectable, true) || this.girBool(v.$.private)) return [[], null]

        let name = v.$.name

        switch (type) {
            case 'property':
                name = this.transformation.transformPropertyName(v.$.name, allowQuotes)
                break
            case 'constant':
                name = this.transformation.transformConstantName(v.$.name, allowQuotes)
                break
            case 'field':
                name = this.transformation.transformFieldName(v.$.name, allowQuotes)
                break
        }
        let typeName = this.typeLookupTransformed(v)
        const nameSuffix = optional ? '?' : ''

        typeName = this.transformation.transformTypeName(typeName)

        return [[`${name}${nameSuffix}: ${typeName}`], name]
    }

    /**
     *
     * @param v
     * @param construct construct means include the property even if it's construct-only,
     * @param optional optional means if it's construct-only it will also be marked optional (?)
     */
    private getProperty(v: GirVariable, construct = false, optional = true): [string[], string | null, string | null] {
        if (this.girBool(v.$['construct-only']) && !construct) return [[], null, null]
        if (!this.girBool(v.$.writable) && construct) return [[], null, null]
        if (this.girBool(v.$.private)) return [[], null, null]

        const propPrefix = this.girBool(v.$.writable) ? '' : 'readonly '
        const [propDesc, propName] = this.getVariable(v, construct && optional, true, 'property')
        let origName: string | null = null

        if (!propName) return [[], null, null]

        if (v.$.name) {
            // TODO does that make sense here? This also changes the signal names
            origName = this.transformation.transformTypeName(v.$.name)
        }

        return [[`    ${propPrefix}${propDesc}`], propName, origName]
    }

    private getFunction(
        e: GirFunction,
        prefix: string,
        funcNamePrefix = '',
        overrideReturnType?: string,
        arrowType = false,
    ): FunctionDescription {
        if (!e || !e.$ || !this.girBool(e.$.introspectable, true) || e.$['shadowed-by']) return [[], null]

        const patch = e._fullSymName ? this.patch[e._fullSymName] : []
        let name = e.$.name
        // eslint-disable-next-line prefer-const
        let [retType, outArrayLengthIndex] = this.getReturnType(e)

        const [params, outParams] = this.getParameters(outArrayLengthIndex, e.parameters)

        if (e.$['shadows']) {
            name = e.$['shadows']
        }

        if (funcNamePrefix) name = funcNamePrefix + name

        if (patch && patch.length === 1) return [patch, null]

        // Function name transformation by environment
        name = this.transformation.transformFunctionName(name)

        if (patch && patch.length === 2) return [[`${prefix}${funcNamePrefix}${patch[patch.length - 1]}`], name]

        const retTypeIsVoid = retType === 'void'

        if (overrideReturnType) {
            retType = overrideReturnType
        } else if (outParams.length + (retTypeIsVoid ? 0 : 1) > 1) {
            if (!retTypeIsVoid) {
                outParams.unshift(`/* returnType */ ${retType}`)
            }
            const retDesc = outParams.join(', ')
            retType = `[ ${retDesc} ]`
        } else if (outParams.length === 1 && retTypeIsVoid) {
            retType = outParams[0]
        }

        let retSep: string
        if (arrowType) {
            prefix = ''
            name = ''
            retSep = ' =>'
        } else {
            retSep = ':'
        }

        return [[`${prefix}${name}(${params})${retSep} ${retType}`], name]
    }

    private getConstructorFunction(
        name: string,
        e: GirFunction,
        prefix: string,
        funcNamePrefix = '',
    ): FunctionDescription {
        // eslint-disable-next-line prefer-const
        let [desc, funcName] = this.getFunction(e, prefix, funcNamePrefix, name)

        if (!funcName) return [[], null]

        return [desc, funcName]
    }

    private getSignalFunc(e: GirFunction, clsName: string): string[] {
        const sigName = this.transformation.transform('signalName', e.$.name)
        const [retType, outArrayLengthIndex] = this.getReturnType(e)
        const [params] = this.getParameters(outArrayLengthIndex, e.parameters)
        const paramComma = params.length > 0 ? ', ' : ''

        return TemplateProcessor.generateSignalMethods(
            this.config.environment,
            sigName,
            clsName,
            paramComma,
            params,
            retType,
        )
    }

    private traverseInheritanceTree(
        girClass: GirClass,
        callback: (girClass: GirClass) => void,
        depth = 0,
        recursive = true,
    ): void {
        const details = this.getClassDetails(girClass)
        if (!details) return
        const { parentName, qualifiedParentName } = details

        let parentPtr: GirClass | null = null
        let name = girClass.$.name

        if (name.indexOf('.') < 0) {
            name = this.name + '.' + name
        }

        if (parentName && qualifiedParentName) {
            if (this.symTable[qualifiedParentName]) {
                parentPtr = (this.symTable[qualifiedParentName] as GirClass | null) || null
            }

            if (!parentPtr && parentName == 'Object') {
                parentPtr = (this.symTable['GObject.Object'] as GirClass) || null
            }

            // check circular dependency
            if (typeof parentPtr?.$?.parent === 'string') {
                let parentName = parentPtr.$.parent
                if (parentName.indexOf('.') < 0 && parentPtr._module?.name)
                    parentName = parentPtr._module.name + '.' + parentName
                if (parentName === girClass._fullSymName) {
                    this.log.warn(`Circular dependency found! Ignore next parent "${parentName}".`)
                    recursive = false
                }
            }

            // this.log.log(
            //     `[traverseInheritanceTree] (depth: ${depth}) ${girClass.$.name} : ${parentName} : ${parent?.$?.parent}`,
            // )
        }

        callback(girClass)

        if (depth >= MAXIMUM_RECUSION_DEPTH) {
            this.log.warn(`Maximum recursion depth of ${MAXIMUM_RECUSION_DEPTH} reached for "${girClass.$.name}"`)
        } else {
            if (parentPtr && recursive && depth <= MAXIMUM_RECUSION_DEPTH) {
                this.traverseInheritanceTree(parentPtr, callback, ++depth, recursive)
            }
        }
    }

    private forEachInterface(
        girClass: GirClass,
        callback: (cls: GirClass) => void,
        recurseObjects = false,
        dups = {},
    ): void {
        for (const { $ } of girClass.implements || []) {
            let name = $.name as string

            if (name.indexOf('.') < 0) {
                name = this.name + '.' + name
            }
            if (Object.prototype.hasOwnProperty.call(dups, name)) {
                continue
            }
            dups[name] = true
            const iface: GirClass | null = this.symTable[name] as GirClass | null

            if (iface) {
                callback(iface)
                this.forEachInterface(iface, callback, recurseObjects, dups)
            }
        }
        if (girClass.prerequisite) {
            let parentName = girClass.prerequisite[0].$.name
            if (!parentName) {
                return
            }
            if (parentName.indexOf('.') < 0) {
                parentName = this.name + '.' + parentName
            }
            if (Object.prototype.hasOwnProperty.call(dups, parentName)) return
            const parentPtr = this.symTable[parentName]
            if (parentPtr && ((parentPtr as GirClass).prerequisite || recurseObjects)) {
                // iface's prerequisite is also an interface, or it's
                // a class and we also want to recurse classes
                callback(parentPtr as GirClass)
                this.forEachInterface(parentPtr as GirClass, callback, recurseObjects, dups)
            }
        }
    }

    private forEachInterfaceAndSelf(e: GirClass, callback: (cls: GirClass) => void) {
        callback(e)
        this.forEachInterface(e, callback)
    }

    private isDerivedFromGObject(girClass: GirClass): boolean {
        let ret = false
        this.traverseInheritanceTree(girClass, (cls) => {
            if (cls._fullSymName === 'GObject.Object') {
                ret = true
            }
        })
        return ret
    }

    private checkName(desc: string[], name: string | null, localNames: LocalNames): [string[], boolean] {
        if (!desc || desc.length === 0) return [[], false]

        if (!name) {
            // this.log.error(`No name for ${desc}`)
            return [[], false]
        }

        if (localNames[name]) {
            // this.log.warn(`Name ${name} already defined (${desc})`)
            return [desc, false]
        }

        localNames[name] = true
        return [desc, true]
    }

    private processFields(cls: GirClass, localNames: LocalNames): string[] {
        const def: string[] = []
        if (cls.field) {
            for (const f of cls.field) {
                const [desc, name] = this.getVariable(f, false, false, 'field')

                const [aDesc, added] = this.checkName(desc, name, localNames)
                if (added) {
                    def.push(`    ${aDesc[0]}`)
                }
            }
        }
        if (def.length) {
            def.unshift(`    /* Fields of ${cls._fullSymName} */`)
        }
        return def
    }

    private processProperties(cls: GirClass, localNames: LocalNames, propertyNames: string[]): string[] {
        const def: string[] = []
        if (cls.property) {
            for (const p of cls.property) {
                const [desc, name, origName] = this.getProperty(p)
                const [aDesc, added] = this.checkName(desc, name, localNames)
                if (added) {
                    if (origName) propertyNames.push(origName)
                    def.push(...aDesc)
                } else if (name && !propertyNames.includes(name)) {
                    const warn = `${name} property clashes with an inherited method`
                    this.log.warn(`${cls._fullSymName}.${warn}`)
                    def.push(`${TemplateProcessor.generateIndent(1)}// ${warn}`)
                }
            }
        }
        if (def.length) {
            def.unshift(`    /* Properties of ${cls._fullSymName} */`)
        }
        return def
    }

    /**
     * Instance methods
     * @param cls
     * @param localNames
     */
    private processMethods(cls: GirClass, localNames: LocalNames): string[] {
        const def: string[] = []
        if (cls.method) {
            for (const func of cls.method) {
                const [desc, name] = this.getFunction(func, '    ')
                def.push(...this.checkName(desc, name, localNames)[0])
            }
        }
        if (def.length) {
            def.unshift(`    /* Methods of ${cls._fullSymName} */`)
        }
        return def
    }

    private exportOverloadableMethods(fnMap: FunctionMap) {
        const def: string[] = []
        for (const f of fnMap.values()) {
            if (f) def.push(...f)
        }
        return def
    }

    /**
     * Instance methods, vfunc_ prefix
     * @param cls
     */
    private processVirtualMethods(cls: GirClass): string[] {
        const fnMap = this.processOverloadableMethods(cls, (e) => {
            let methods = (e['virtual-method'] || []).map((f) => {
                const desc = this.getFunction(f, '    ', 'vfunc_')
                return desc
            })
            methods = methods.filter((f) => f[1] != null)
            return methods
        })
        const def = this.exportOverloadableMethods(fnMap)
        if (def.length) {
            def.unshift(`    /* Virtual methods of ${cls._fullSymName} */`)
        }
        return def
    }

    private processSignals(cls: GirClass, clsName: string): string[] {
        const def: string[] = []
        const signals = cls['glib:signal']
        if (signals) {
            for (const s of signals) def.push(...this.getSignalFunc(s, clsName))
        }
        if (def.length) {
            def.unshift(`    /* Signals of ${cls._fullSymName} */`)
        }
        return def
    }

    /**
     * Some classes implement interfaces which are also implemented by a superclass
     * and we need to exclude those in some circumstances
     * @param cls
     * @param iface
     */
    private interfaceIsDuplicate(cls: GirClass, iface: GirClass | string): boolean {
        if (typeof iface !== 'string') {
            if (!iface._fullSymName) return false
            iface = iface._fullSymName
        }
        let rpt = false
        let bottom = true
        this.traverseInheritanceTree(cls, (sub) => {
            if (rpt) return
            if (bottom) {
                bottom = false
                return
            }
            this.forEachInterface(
                sub,
                (e) => {
                    if (rpt) return
                    if (e._fullSymName === iface) {
                        rpt = true
                    }
                },
                true,
            )
        })
        return rpt
    }

    private getStaticConstructors(
        e: GirClass,
        name: string,
        filter?: (funcName: string) => boolean,
    ): FunctionDescription[] {
        const funcs = e['constructor']
        if (!Array.isArray(funcs)) return [[[], null]]
        let ctors = funcs.map((f) => {
            return this.getConstructorFunction(name, f, '    static ', undefined)
        })
        if (filter) ctors = ctors.filter(([, funcName]) => funcName && filter(funcName))
        return ctors
    }

    private isGtypeStructFor(e: GirClass, rec: GirClass) {
        const isFor = rec.$['glib:is-gtype-struct-for']
        return isFor && isFor == e.$.name
    }

    /**
     * Some class/static methods are defined in a separate record which is not
     * exported, but the methods are available as members of the JS constructor.
     * In gjs one can use an instance of the object, a JS constructor or a GType
     * as the methods' instance-parameter.
     * @see https://discourse.gnome.org/t/using-class-methods-like-gtk-widget-class-get-css-name-from-gjs/4001
     * @param girClass
     */
    private getClassMethods(girClass: GirClass): FunctionDescription[] {
        if (!girClass.$.name) return []
        const fName = girClass.$.name + 'Class'
        let rec = this.ns.record?.find((r) => r.$.name == fName)
        if (!rec || !this.isGtypeStructFor(girClass, rec)) {
            rec = this.ns.record?.find((r) => this.isGtypeStructFor(girClass, r))
            fName == rec?.$.name
        }
        if (!rec) return []
        const methods = rec.method || []
        return methods.map((m) => this.getFunction(m, '    static '))
    }

    private getOtherStaticFunctions(girClass: GirClass, stat = true): FunctionDescription[] {
        const fns: FunctionDescription[] = []
        if (girClass.function) {
            for (const func of girClass.function) {
                const [desc, funcName] = this.getFunction(func, stat ? '    static ' : '    ', undefined, undefined)
                if (funcName && funcName !== 'new') fns.push([desc, funcName])
            }
        }
        return fns
    }

    private localName(name: string | GirClass) {
        let mod: GirModule
        if (typeof name !== "string") {
            mod = name._module ? name._module : this
            name = this.transformation.transformClassName(name.$.name)
            if (mod === this)
                return name
            else
                name = mod.name + '.' + name
        }
        if (name.indexOf('.') < 0)
            return name
        let modName
        [modName, name] = name.split('.')
        if (modName != this.name)
            name = modName + '.' + name
        return name
    }

    private getClassDetails(girClass: GirClass): ClassDetails | null {
        if (!girClass || !girClass.$) return null
        const mod: GirModule = girClass._module ? girClass._module : this
        let name = this.transformation.transformClassName(girClass.$.name)
        let qualifiedName: string
        if (name.indexOf('.') < 0) {
            qualifiedName = mod.name + '.' + name
        } else {
            qualifiedName = name
            const split = name.split('.')
            name = split[split.length - 1]
        }

        let parentName: string | undefined = undefined
        let qualifiedParentName: string | undefined = undefined
        let localParentName: string | undefined = undefined

        if (girClass.prerequisite) {
            parentName = girClass.prerequisite[0].$.name
        } else if (girClass.$.parent) {
            parentName = girClass.$.parent
        }

        let parentModName: string
        if (parentName) {
            if (parentName.indexOf('.') < 0) {
                qualifiedParentName = mod.name + '.' + parentName
                parentModName = mod.name
            } else {
                qualifiedParentName = parentName
                const split = parentName.split('.')
                parentName = split[split.length - 1]
                parentModName = split.slice(0, split.length - 1).join('.')
            }
            localParentName = parentModName == mod.name ? parentName : qualifiedParentName
        }
        return { name, qualifiedName, parentName, qualifiedParentName, localParentName }
    }

    /**
     * See comment for addOverloadableFunctions.
     * Returns true if (a definition from) func is added to map to satisfy
     * an overload, or if it was forced
     * @param map
     * @param func
     * @param force
     * @param supName Name of superclass/interface whose methods may be hidden
     * @param subName Name of subclass potentially hiding methods
     * @param statics Whether these are static methods
     */
    private mergeOverloadableFunctions(map: FunctionMap,
            func: FunctionDescription,
            force = true,
            supName?: string,
            subName?: string,
            statics = false,
            ) {
        if (!func[1]) return false
        const defs = map.get(func[1])
        if (!defs) {
            if (force) map.set(func[1], func[0])
            return false
        }
        let result = false
        for (const newDef of func[0]) {
            let match = false
            for (const oldDef of defs) {
                if (this.functionSignaturesMatch(newDef, oldDef)) {
                    match = true
                    break
                }
            }
            if (!match) {
                if (!statics) {
                    if (signalMethods.includes(func[1]))
                        supName = 'GObject.Object'
                    this.log.warn(`${subName}.${func[1]}() clashes with ${supName}.${func[1]}()`)
                    supName += '.prototype'
                }
                const indent = TemplateProcessor.generateIndent(1)
                if (statics)
                    defs.push(`${indent}// WARN: False overload forced by TS rules, do not use`)
                else
                    defs.push(`${indent}// WARN: Name clash, use ${supName}.${func[1]}.call(this, ...)`)
                defs.push(newDef)
                result = true
            }
        }
        return result
    }

    /**
     * fnMap values are equivalent to the second element of a FunctionDescription.
     * If force is true, every function of funcs is added to fnMap even
     * if it doesn't already contain a function of the same name.
     * @param fnMap
     * @param funcs
     * @param force
     */
    private addOverloadableFunctions(
        fnMap: FunctionMap,
        funcs: FunctionDescription[],
        force = false,
        supName?: string,
        subName?: string,
        statics = false,
    ) {
        for (const func of funcs) {
            if (!func[1]) continue
            this.mergeOverloadableFunctions(fnMap, func, force, supName, subName, statics)
        }
    }

    /**
     * Used for <method> and <virtual-method>
     * @param cls
     * @param getMethods
     * @param statics
     * @return [FunctionMap, localNames]; localNames is a set of names
     *         which need to be checked for clashes/overloads
     */
    private processOverloadableMethods(
        girClass: GirClass,
        getMethods: (e: GirClass) => FunctionDescription[],
        statics = false,
    ): FunctionMap {
        const fnMap: FunctionMap = new Map()
        // Make sure explicit methods don't clash with signal methods
        if (!statics && girClass._fullSymName != 'GObject.Object') {
            for (const fn of signalMethods) {
                fnMap.set(fn, [])
            }
        }
        const funcs = getMethods(girClass)
        const subName = girClass._fullSymName
        this.addOverloadableFunctions(fnMap, funcs, true, subName, subName, statics)
        // Have to implement methods from cls' interfaces and overload the ones it inherits
        this.traverseInheritanceTree(girClass, (cls) => {
            if (statics) {
                const funcs = getMethods(cls)
                this.addOverloadableFunctions(fnMap, funcs, false, cls._fullSymName, subName, statics)
            } else {
                this.forEachInterfaceAndSelf(cls, (e) => {
                    const funcs = getMethods(e)
                    if (e == cls || !this.interfaceIsDuplicate(cls, e)) {
                        this.addOverloadableFunctions(fnMap, funcs, e != cls, e._fullSymName, subName, statics)
                    }
                })
            }
        })
        // If there were no clashes with the signal methods they should be removed from fnMap
        if (!statics && girClass._fullSymName != 'GObject.Object') {
            for (const fn of signalMethods) {
                if ((fnMap.get(fn)?.length || 0) <= 1) {
                    fnMap.delete(fn)
                }
            }
        }
        return fnMap
    }

    private processStaticFunctions(cls: GirClass, getter: (e: GirClass) => FunctionDescription[]): string[] {
        const fnMap = this.processOverloadableMethods(cls, getter, true)
        return this.exportOverloadableMethods(fnMap)
    }

    private generateNotifyMethods(cls: GirClass, propertyNames: string[], callbackObjectName: string): string[] {
        const def: string[] = []
        const isDerivedFromGObject = this.isDerivedFromGObject(cls)
        if (isDerivedFromGObject) {
            let prefix = 'GObject.'
            if (this.name === 'GObject') prefix = ''
            for (const prop of propertyNames) {
                def.push(
                    ...TemplateProcessor.generateGObjectSignalMethods(
                        this.config.environment,
                        prop,
                        callbackObjectName,
                        prefix,
                    ),
                )
            }
        }
        return def
    }

    private generateGeneralSignalMethods(girClass: GirClass, disconnect = false): string[] {
        return TemplateProcessor.generateGeneralSignalMethods(this.config.environment,
                1, disconnect || (this.name === "GObject" && girClass.$.name === "Object"))
    }

    /**
     * Static methods, <constructor> and <function>
     * @param girClass
     * @param name
     */
    private getAllStaticFunctions(girClass: GirClass, name: string) {
        const stc: string[] = []

        stc.push(
            ...this.processStaticFunctions(girClass, (cls) => {
                return this.getStaticConstructors(cls, name)
            }),
        )
        stc.push(
            ...this.processStaticFunctions(girClass, (cls) => {
                return this.getOtherStaticFunctions(cls)
            }),
        )
        stc.push(
            ...this.processStaticFunctions(girClass, (cls) => {
                return this.getClassMethods(cls)
            }),
        )

        if (stc.length > 0) {
            stc.unshift('    /* Static methods and pseudo-constructors */')
        }
        return stc
    }

    private generateConstructorAndStaticMethods(girClass: GirClass, name: string): string[] {
        const def: string[] = []
        const isDerivedFromGObject = this.isDerivedFromGObject(girClass)
        if (girClass._fullSymName && !STATIC_NAME_ALREADY_EXISTS.includes(girClass._fullSymName)) {
            // Records, classes and interfaces all have a static name
            def.push(`    static name: string`)
        }

        // JS constructor(s)
        if (isDerivedFromGObject) {
            def.push(
                `    constructor (config?: ${name}_ConstructProps)`,
                `    _init (config?: ${name}_ConstructProps): void`,
            )
        } else {
            const constructor_: GirFunction[] = (girClass['constructor'] || []) as GirFunction[]
            if (constructor_) {
                if (Array.isArray(constructor_)) {
                    for (const f of constructor_) {
                        const [desc, funcName] = this.getConstructorFunction(name, f, '    static ')
                        if (!funcName) continue
                        if (funcName !== 'new') continue

                        def.push(...desc)

                        const jsStyleCtor = desc[0].replace('static new', 'constructor').replace(/:[^:]+$/, '')

                        def.push(jsStyleCtor)
                    }
                }
            }
        }

        def.push(...this.getAllStaticFunctions(girClass, name))

        if (isDerivedFromGObject) {
            def.push(`    static $gtype: ${this.packageName === 'GObject-2.0' ? '' : 'GObject.'}Type`)
        }

        return def
    }

    private generateConstructPropsInterface(
        girClass: GirClass,
        name: string,
        qualifiedParentName?: string,
        localParentName?: string,
    ): string[] {
        const def: string[] = []
        const isDerivedFromGObject = this.isDerivedFromGObject(girClass)
        if (isDerivedFromGObject) {
            let ext = ' '

            if (qualifiedParentName) {
                ext = `extends ${localParentName}_ConstructProps `
            }

            def.push(`export interface ${name}_ConstructProps ${ext}{`)
            const constructPropNames = {}
            if (girClass.property) {
                for (const p of girClass.property) {
                    const [desc, name] = this.getProperty(p, true, true)
                    def.push(...this.checkName(desc, name, constructPropNames)[0])
                }
            }
            // Include props of implemented interfaces
            if (girClass.implements) {
                this.forEachInterface(girClass, (iface) => {
                    if (iface.property) {
                        for (const p of iface.property) {
                            const [desc, name] = this.getProperty(p, true, true)
                            const [props, added] = this.checkName(desc, name, constructPropNames)
                            if (added)
                                def.push(...props)
                        }
                    }
                })
            }
            def.push('}')
        }
        return def
    }

    private forEachImplementedLocalName(girClass: GirClass, callback: (name: string) => void) {
        if (girClass.implements) {
            for (const i of girClass.implements) {
                let name = i.$.name
                if (!name) continue
                let fullName
                if (name.indexOf('.') >= 0) {
                    fullName = name
                    const [mod, local] = name.split('.')
                    if (mod == this.name)
                        name = local
                } else {
                    fullName = (this.name || '') + '.' + name
                }
                if (!this.interfaceIsDuplicate(girClass, fullName))
                    callback(name)
            }
        }
    }

    // TS classes implicitly have an interface with the same name so we can use
    // them in implements etc even though they're declared as classes
    private getInheritance(girClass: GirClass, localParentName?: string) {
        let inherits = localParentName ? `extends ${localParentName} ` : ''
        if (girClass.implements) {
            const impl: string[] = []
            this.forEachImplementedLocalName(girClass, n => impl.push(n))
            if (impl.length)
                inherits += `implements ${impl.join(',')} `
        }
        return inherits
    }

    private addSignalMethod(methods: FunctionDescription[], name: string, desc: string[]) {
        const old = methods.find((e) => e[1] === name)
        if (old) {
            for (const ln of desc) {
                if (!old[0].find((e) => e === ln)) {
                    old[0].push(ln)
                }
            }
        } else {
            methods.push([desc, name])
        }
    }

    private getInstanceMethods(cls: GirClass): FunctionDescription[] {
        // Some methods have the same name as properties, give priority to properties
        // by filtering out those names
        const dash = /-/g
        const propNames = new Set<string>()
        this.traverseInheritanceTree(cls, (e) => {
            this.forEachInterfaceAndSelf(e, (propSrc) => {
                for (const p of propSrc.property || []) {
                    if (p.$.name) propNames.add(p.$.name.replace(dash, '_'))
                }
            })
        })
        const methodNames = (cls.method || []).filter((m) => {
            if (propNames.has(m.$.name)) {
                return false
            }
            return m.$.name != null
        })
        const methods = methodNames.map((f) => this.getFunction(f, '    ', '')).filter((f) => f[1] != null)

        return methods
    }

    private stripParamNames(f: string, ignoreTail = false) {
        const g = f
        f = f.replace(this.commentRegExp, '')
        const lb = f.split('(', 2)
        if (lb.length < 2) console.log(`Bad function definition ${g}`)
        const rb = lb[1].split(')')
        const tail = ignoreTail ? '' : rb[rb.length - 1]
        let params = rb.slice(0, rb.length - 1).join(')')
        params = params.replace(this.paramRegExp, ':')
        params = params.replace(this.optParamRegExp, '?:')
        return `${lb[0]}(${params})${tail}`
    }

    // Returns true if the function definitions in f1 and f2 have equivalent
    // signatures
    private functionSignaturesMatch(f1: string, f2: string) {
        const comment = /^\s*\//
        if (comment.test(f1))
            return comment.test(f2)
        else if (comment.test(f2))
            return false
        return this.stripParamNames(f1) == this.stripParamNames(f2)
    }

    private getSignals(cls: GirClass): FunctionDescription[] {
        const signals = cls['glib:signal'] || []
        const descs: FunctionDescription[] = []
        for (const s of signals) {
            const [retType, outArrayLengthIndex] = this.getReturnType(s)
            let [params] = this.getParameters(outArrayLengthIndex, s.parameters)
            if (params.length > 0) params = ', ' + params
            const callback = `(obj: ${cls.$.name}${params}) => ${retType}`
            const signature = `(sigName: "${s.$.name}", callback: ${callback}): number`
            descs.push([[`    connect${signature}`], 'connect'])
            descs.push([[`    connect_after${signature}`], 'connect_after'])
            descs.push([[`    emit(sigName: "${s.$.name}"${params}): void`], 'emit'])
        }
        return descs
    }

    private descriptionsFromFunctions(funcs: string[]): FunctionDescription[] {
        const extractName = /^\s*(.*)\(/
        return funcs.map(f => {
            const m = f.match(extractName)
            return [[f], m ? m[1] : null]
        })
    }

    private processSelfAndInterfaceSignals(cls: GirClass, propertyNames: string[]): string[] {
        const signals: string[] = []
        this.forEachInterfaceAndSelf(cls, (e) => {
            const clsName = this.localName(e)
            signals.push(...this.processSignals(e, clsName))
            signals.push(...this.generateNotifyMethods(e, propertyNames, clsName))
        })
        return signals
    }

    // These have to be processed together, because signals add overloads
    // for connect() etc (including property notifications) and prop names may
    // clash with method names, meaning one or the other has to be removed
    private processInstanceMethodsSignalsProperties(cls: GirClass, localNames: LocalNames, className: string): string[] {
        // First get inherited property names, because subclass methods that clash with them can't be declared
        const inheritedProps = new Set<string>()
        this.traverseInheritanceTree(cls, e => {
            if (e.property?.length) {
                for (const p of e.property) {
                    if (p.$.name) inheritedProps.add(p.$.name)
                }
            }
        });
        // Methods
        const fnMap = this.processOverloadableMethods(cls, (e) => {
            return this.getInstanceMethods(e)
        })
        // localNames has to include all methods even if they're implicitly
        // inherited and not declared in this class
        this.traverseInheritanceTree(cls, e => {
            this.forEachInterfaceAndSelf(e, iface => {
                for (const f of iface.method || []) {
                    if (f.$.name)
                        localNames[f.$.name] = true
                }
            })
        })
        for (const fn of fnMap) {
            if (inheritedProps.has(fn[0])) {
                const warn = `${fn[0]} method(s) clash with an inherited property`
                this.log.warn(`${cls._fullSymName}.${warn}`)
                const indent = TemplateProcessor.generateIndent(1)
                fn[1] = [`${indent}// WARN: ${warn}`]
            }
        }
        const def: string[] = this.exportOverloadableMethods(fnMap)
        let sigClash = false
        let disconnect = false
        for (const fn of signalMethods) {
            if (localNames[fn]) {
                sigClash = true
                if (fn === 'disconnect') {
                    disconnect = true
                    break
                }
            }
        }
        // Properties
        const propertyNames: string[] = []
        this.forEachInterfaceAndSelf(cls, (e) => {
            def.push(...this.processProperties(e, localNames, propertyNames))
        })
        // Signals
        const signals = this.processSelfAndInterfaceSignals(cls, propertyNames)
        if (signals.length || sigClash) {
            const locals: LocalNames = {}
            this.traverseInheritanceTree(cls, (parent: GirClass) => {
                if (parent == cls) return
                const propNames = new Set<string>()
                this.forEachInterfaceAndSelf(parent, (e) => {
                    // Here we don't want the definitions, just the names for
                    // notify signals
                    for (const p of e.property || []) {
                        if (p.$.name)
                            propNames.add(p.$.name)
                    }
                })
                signals.push(...this.processSelfAndInterfaceSignals(parent, Array.from(propNames.keys())))
            })
            signals.push('    /* Generic signal methods */')
            signals.push(...this.generateGeneralSignalMethods(cls, disconnect))
        }
        def.push(...signals)
        return def
    }

    public exportEnumeration(e: GirEnumeration): string[] {
        const def: string[] = []

        if (!e || !e.$ || !this.girBool(e.$.introspectable, true)) return []

        let name = e.$.name
        // E.g. the NetworkManager-1.0 has enum names starting with 80211
        name = this.transformation.transformEnumName(name)

        def.push(`export enum ${name} {`)
        if (e.member) {
            for (const member of e.member) {
                const _name = member.$.name || member.$['glib:nick'] || member.$['c:identifier']
                if (!_name) {
                    continue
                }
                const name = this.transformation.transform('enumValue', _name)
                if (/\d/.test(name[0])) def.push(`    /* ${name} (invalid, starts with a number) */`)
                else def.push(`    ${name},`)
            }
        }
        def.push('}')
        return def
    }

    public exportConstant(girVar: GirVariable): string[] {
        const [varDesc, varName] = this.getVariable(girVar, false, false, 'constant')
        if (varName) {
            if (!this.constNames[varName]) {
                this.constNames[varName] = 1
                return [`export const ${varDesc}`]
            } else {
                this.log.warn(`The constant '${varDesc}' has already been exported`)
            }
        }
        return []
    }

    /**
     * Represents a record or GObject class or interface as a Typescript class
     * @param girClass
     * @param isAbstract
     * @param record
     */
    public exportClassInternal(girClass: GirClass, record = false, isAbstract = false): string[] {
        const def: string[] = []

        // Is this a abstract class? E.g GObject.ObjectClass is a such abstract class and required by UPowerGlib-1.0, UDisks-2.0 and others
        if (girClass.$ && girClass.$['glib:is-gtype-struct-for']) {
            isAbstract = true
        }

        const details = this.getClassDetails(girClass)
        if (!details) return []

        // eslint-disable-next-line prefer-const
        let { name, qualifiedParentName, localParentName } = details

        // Properties for construction
        def.push(...this.generateConstructPropsInterface(girClass, name, qualifiedParentName, localParentName))

        // Superclass and interfaces
        let inherits = this.config.inheritance ? this.getInheritance(girClass, localParentName) : ""

        // START CLASS
        if (isAbstract) {
            def.push(`export abstract class ${name} ${inherits}{`)
        } else {
            def.push(`export class ${name} ${inherits}{`)
        }

        const localNames: LocalNames = {}

        const inheritance = this.config.inheritance
        if (inheritance) {
            def.push(...this.processInstanceMethodsSignalsProperties(girClass,
                        localNames, name))
            def.push(...this.processVirtualMethods(girClass))
        } else {
            const propertyNames: string[] = []
            // Copy properties from inheritance tree
            this.traverseInheritanceTree(girClass, (cls) =>
                def.push(...this.processProperties(cls, localNames, propertyNames)),
            )
            // Copy properties from implemented interfaces
            this.forEachInterface(girClass, (cls) => def.push(...this.processProperties(cls, localNames, propertyNames)))
            def.push(...this.generateNotifyMethods(girClass, propertyNames, name))
            this.traverseInheritanceTree(girClass, (cls) => def.push(...this.processFields(cls, localNames)))
            // Copy methods from inheritance tree
            this.traverseInheritanceTree(girClass, (cls) => def.push(...this.processMethods(cls, localNames)))
            // Copy methods from implemented interfaces
            this.forEachInterface(girClass, (cls) => def.push(...this.processMethods(cls, localNames)))
            // Copy virtual methods from inheritance tree
            this.traverseInheritanceTree(girClass, (cls) => def.push(...this.processVirtualMethods(cls)))
            // Copy signals from inheritance tree
            this.traverseInheritanceTree(girClass, (cls) => def.push(...this.processSignals(cls, name)))
            // Copy signals from implemented interfaces
            this.forEachInterface(girClass, (cls) => def.push(...this.processSignals(cls, name)))
        }

        // Static side: default constructor
        def.push(...this.generateConstructorAndStaticMethods(girClass, name))

        // END CLASS
        def.push('}')

        return def
    }

    public exportFunction(e: GirFunction): string[] {
        return this.getFunction(e, 'export function ')[0]
    }

    public exportCallback(e: GirFunction): string[] {
        if (!e || !e.$ || !this.girBool(e.$.introspectable, true)) return []

        const name = e.$.name
        const [retType, outArrayLengthIndex] = this.getReturnType(e)
        const [params] = this.getParameters(outArrayLengthIndex, e.parameters)

        const def: string[] = []
        def.push(`export interface ${name} {`)
        def.push(`    (${params}): ${retType}`)
        def.push('}')
        return def
    }

    public exportAlias(girAlias: GirAlias): string[] {
        if (!girAlias || !girAlias.$ || !this.girBool(girAlias.$.introspectable, true)) return []

        const typeName = this.typeLookupTransformed(girAlias)
        const name = girAlias.$.name
        return [`type ${name} = ${typeName}`]
    }

    public exportInterface(girClass: GirClass): string[] {
        return this.exportClassInternal(girClass, true)
    }

    public exportClass(girClass: GirClass): string[] {
        return this.exportClassInternal(girClass, false)
    }

    public exportJs(): void {
        const templateProcessor = new TemplateProcessor(
            {
                name: this.name,
                version: this.version,
                importName: this.importName,
            },
            this.packageName || undefined,
            this.config,
        )
        if (this.config.outdir) {
            templateProcessor.create('module.js', this.config.outdir, `${this.packageName}.js`)
        } else {
            const moduleContent = templateProcessor.load('module.js')
            this.log.log(moduleContent)
        }
    }

    public export(outStream: NodeJS.WritableStream, outputPath: string | null): void {
        const out: string[] = []

        out.push(...TemplateProcessor.generateTSDocComment(`${this.packageName}`))

        out.push('')

        const deps: string[] = this.transitiveDependencies

        // Always pull in GObject-2.0, as we may need it for e.g. GObject-2.0.type
        if (this.packageName !== 'GObject-2.0') {
            if (!Utils.find(deps, (x) => x === 'GObject-2.0')) {
                deps.push('GObject-2.0')
            }
        }

        // Add missing dependencies
        if (this.packageName === 'UnityExtras-7.0') {
            if (!Utils.find(deps, (x) => x === 'Unity-7.0')) {
                deps.push('Unity-7.0')
            }
        }
        if (this.packageName === 'UnityExtras-6.0') {
            if (!Utils.find(deps, (x) => x === 'Unity-6.0')) {
                deps.push('Unity-6.0')
            }
        }
        if (this.packageName === 'GTop-2.0') {
            if (!Utils.find(deps, (x) => x === 'GLib-2.0')) {
                deps.push('GLib-2.0')
            }
        }

        // Module dependencies as type references or imports
        if (this.config.environment === 'gjs') {
            out.push(...TemplateProcessor.generateModuleDependenciesImport('Gjs', 'Gjs', false, this.config))
        } else {
            out.push(...TemplateProcessor.generateModuleDependenciesImport('node', 'node', true, this.config))
        }
        for (const dep of deps) {
            // Don't reference yourself as a dependency
            if (this.packageName !== dep) {
                const girFilename = `${dep}.gir`
                const { name } = Utils.splitModuleName(dep)
                const depFile = Utils.findFileInDirs(this.config.girDirectories, girFilename)
                if (depFile.exists) {
                    out.push(...TemplateProcessor.generateModuleDependenciesImport(name, dep, false, this.config))
                } else {
                    out.push(`// WARN: Dependency not found: '${dep}'`)
                    this.log.error(`Dependency gir file not found: '${girFilename}'`)
                }
            }
        }

        // START Namespace
        if (this.config.buildType === 'types') {
            out.push('')
            out.push(`declare namespace ${this.name} {`)
        }

        // Newline
        out.push('')

        if (this.ns.enumeration) for (const e of this.ns.enumeration) out.push(...this.exportEnumeration(e))

        if (this.ns.bitfield) for (const e of this.ns.bitfield) out.push(...this.exportEnumeration(e))

        if (this.ns.constant) for (const e of this.ns.constant) out.push(...this.exportConstant(e))

        if (this.ns.function) for (const e of this.ns.function) out.push(...this.exportFunction(e))

        if (this.ns.callback) for (const e of this.ns.callback) out.push(...this.exportCallback(e))

        if (this.ns.interface) for (const e of this.ns.interface) out.push(...this.exportClassInternal(e))

        const templateProcessor = new TemplateProcessor(
            { name: this.name, version: this.version },
            this.packageName,
            this.config,
        )

        // Extra interfaces if a template with the module name  (e.g. '../templates/GObject-2.0.d.ts') is found
        // E.g. used for GObject-2.0 to help define GObject classes in js;
        // these aren't part of gi.
        if (templateProcessor.exists(`${this.packageName}.d.ts`)) {
            const patches = templateProcessor.load(`${this.packageName}.d.ts`)
            out.push(patches)
        }

        if (this.ns.class) for (const e of this.ns.class) out.push(...this.exportClassInternal(e, false))

        if (this.ns.record) for (const e of this.ns.record) out.push(...this.exportClassInternal(e, true))

        if (this.ns.union) for (const e of this.ns.union) out.push(...this.exportClassInternal(e, true))

        if (this.ns.alias)
            // GType is not a number in GJS
            for (const e of this.ns.alias)
                if (this.packageName !== 'GObject-2.0' || e.$.name !== 'Type') out.push(...this.exportAlias(e))

        if (this.packageName === 'GObject-2.0') out.push('export interface Type {', '    name: string', '}')

        // END Namespace
        if (this.config.buildType === 'types') {
            out.push(`}`)
        }

        // End of file
        outStream.write(out.join('\n'))

        if (outputPath) {
            templateProcessor.prettify(outputPath)
        }
    }
}
