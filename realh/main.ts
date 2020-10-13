// TODO:
// * If an interface inherits the same method from more than one other interface
//   it needs to be overloaded in the new interface even if the signatures are
//   identical

import * as xml2js from 'xml2js'
import * as lodash from 'lodash'
import * as commander from 'commander'
import fs = require('fs')

const doLog = false
function deblog(s: any) {
    if (doLog) console.log('* ' + s)
}
const debLog = deblog

interface TsForGjsExtended {
    _module?: GirModule
    _fullSymName?: string
}

interface ClassDetails {
    name: string
    qualifiedName: string
    parentName?: string
    qualifiedParentName?: string
    localParentName?: string // qualified if its module != qualifiedName's module
}

interface GirInclude {
    $: {
        name: string
        version: string
    }
}
interface GirDoc {
    _: string
    $: {
        'xml:space'?: string
    }
}
interface GirImplements {
    $: {
        name?: string
    }
}
interface GirPrerequisite {
    $: {
        name?: string
    }
}
interface GirType {
    $: {
        name: string
        'c:type'?: string
    }
}
interface GirArray {
    $?: {
        length?: string
        'zero-terminated'?: string
        'c:type'?: string
    }
    type?: GirType[]
}
interface GirVariable extends TsForGjsExtended {
    $: {
        name?: string
        'transfer-ownership'?: string
        nullable?: string
        'allow-none'?: string
        writable?: string
        readable?: string
        private?: string
        'construct-only'?: string
        direction?: string
        introspectable?: string
        closure?: string
        destroy?: string
    }
    doc?: GirDoc[]
    type?: GirType[]
    array?: GirArray[]
}
interface GirParameter {
    parameter?: GirVariable[]
    'instance-parameter'?: GirVariable[]
}
interface GirFunction extends TsForGjsExtended {
    $: {
        name: string
        version?: string
        'c-identifier'?: string
        introspectable?: string
        'moved-to'?: string
        'shadowed-by'?: string
    }
    doc?: GirDoc[]
    parameters?: GirParameter[]
    'return-value'?: GirVariable[]
}
interface GirSignal extends TsForGjsExtended {
    $: {
        name: string
        when: string
    }
    doc?: GirDoc[]
    'return-value'?: GirParameter[]
}
interface GirClass extends TsForGjsExtended {
    $: {
        name: string
        parent?: string
        version?: string
        // Not sure what this means
        disguised?: string
        // c:symbol-prefix, c:type, glib:get-type, glib:type-name
        'glib:is-gtype-struct-for'?: string
    }
    doc?: GirDoc[]
    function?: GirFunction[]
    'glib:signal'?: GirFunction[]
    method?: GirFunction[]
    property?: GirVariable[]
    field?: GirVariable[]
    'virtual-method'?: GirFunction[]
    constructor?: GirFunction[] | Function
    implements?: GirImplements[]
    prerequisite?: GirPrerequisite[]

    _module?: GirModule
}
interface GirEnumerationMember {
    $: {
        name: string
        value: string
        // c:identifier, glib:nick
    }
    doc?: GirDoc[]
}
export interface GirEnumeration extends TsForGjsExtended {
    $: {
        name: string
        version?: string
        'c:type'?: string
        introspectable?: string
        // glib:get-type, glib:type-name
    }
    doc?: GirDoc[]
    member?: GirEnumerationMember[]
}
interface GirAlias extends TsForGjsExtended {
    $: {
        name: string
        'c:type'?: string
        introspectable?: string
    }
    type?: GirType[]
}
interface GirNamespace {
    $: {
        name: string
        version: string
    }
    alias?: GirAlias[]
    bitfield?: GirEnumeration[]
    callback?: GirFunction[]
    class?: GirClass[]
    constant?: GirVariable[]
    enumeration?: GirEnumeration[]
    function?: GirFunction[]
    interface?: GirClass[]
    record?: GirClass[]
    union?: GirClass[]
}

interface GirRepository {
    include?: GirInclude[]
    namespace?: GirNamespace[]
}

type FunctionDescription = [string[], string | null]
type FunctionMap = Map<string, string[]>

export class GirModule {
    name: string | null = null
    version = '0.0'
    dependencies: string[] = []
    transitiveDependencies: string[] = []
    repo: GirRepository
    ns: GirNamespace = { $: { name: '', version: '' } }
    symTable: { [key: string]: any } = {}

    constructor(xml) {
        this.repo = xml.repository

        if (this.repo.include) {
            for (const i of this.repo.include) {
                this.dependencies.unshift(`${i.$.name}-${i.$.version}`)
            }
        }

        if (this.repo.namespace && this.repo.namespace.length) {
            this.ns = this.repo.namespace[0]
            this.name = this.ns.$.name
            this.version = this.ns.$.version
        }
    }

    loadTypes(dict) {
        const loadTypesInternal = (arr) => {
            if (arr) {
                for (const x of arr) {
                    if (x.$) {
                        if (x.$.introspectable) {
                            if (!this.girBool(x.$.introspectable, true)) continue
                        }
                    }

                    const symName = `${this.name}.${x.$.name}`
                    if (dict[symName]) {
                        console.warn(`Warn: duplicate symbol: ${symName}`)
                    }

                    x._module = this
                    x._fullSymName = symName
                    dict[symName] = x
                }
            }
        }
        loadTypesInternal(this.ns.bitfield)
        loadTypesInternal(this.ns.callback)
        loadTypesInternal(this.ns.class)
        loadTypesInternal(this.ns.constant)
        loadTypesInternal(this.ns.enumeration)
        loadTypesInternal(this.ns.function)
        loadTypesInternal(this.ns.interface)
        loadTypesInternal(this.ns.record)
        loadTypesInternal(this.ns.union)
        loadTypesInternal(this.ns.alias)

        const annotateFunctionArguments = (f: GirFunction) => {
            const funcName = f._fullSymName
            if (f.parameters)
                for (const p of f.parameters)
                    if (p.parameter)
                        for (const x of p.parameter) {
                            x._module = this
                            if (x.$ && x.$.name) {
                                x._fullSymName = `${funcName}.${x.$.name}`
                            }
                        }
        }
        const annotateFunctionReturn = (f: GirFunction) => {
            const retVal: GirVariable[] | undefined = f['return-value']
            if (retVal)
                for (const x of retVal) {
                    x._module = this
                    if (x.$ && x.$.name) {
                        x._fullSymName = `${f._fullSymName}.${x.$.name}`
                    }
                }
        }
        const annotateFunctions = (obj: GirClass | null, funcs: GirFunction[]) => {
            try {
                if (funcs) {
                    for (const f of funcs) {
                        if (!f || !f.$) continue
                        const nsName = obj ? obj._fullSymName : this.name
                        f._fullSymName = `${nsName}.${f.$.name}`
                        f._module = this
                        annotateFunctionArguments(f)
                        annotateFunctionReturn(f)
                    }
                }
            } catch (error) {
                console.log(error)
                console.log(`funcs has type ${typeof funcs}:`)
                console.dir(funcs)
                throw error
            }
        }
        const annotateVariables = (obj: GirClass | null, vars) => {
            if (vars)
                for (const x of vars) {
                    const nsName = obj ? obj._fullSymName : this.name
                    x._module = this
                    if (x.$ && x.$.name) {
                        x._fullSymName = `${nsName}.${x.$.name}`
                    }
                }
        }

        if (this.ns.callback) for (const f of this.ns.callback) annotateFunctionArguments(f)

        const objs = (this.ns.class ? this.ns.class : [])
            .concat(this.ns.record ? this.ns.record : [])
            .concat(this.ns.interface ? this.ns.interface : [])

        for (const c of objs) {
            c._module = this
            c._fullSymName = `${this.name}.${c.$.name}`
            const cons = c.constructor instanceof Array ? c.constructor : []
            annotateFunctions(c, cons)
            annotateFunctions(c, c.function || [])
            annotateFunctions(c, c.method || [])
            annotateFunctions(c, c['virtual-method'] || [])
            annotateFunctions(c, c['glib:signal'] || [])
            annotateVariables(c, c.property)
            annotateVariables(c, c.field)
        }

        if (this.ns.function) annotateFunctions(null, this.ns.function)

        if (this.ns.constant) annotateVariables(null, this.ns.constant)

        // if (this.ns.)
        // props

        this.symTable = dict
    }

    private loadHierarchy(classes, inheritanceTable) {
        if (!classes) return
        for (const cls of classes) {
            let parent: string | null = null
            if (cls.prerequisite) parent = cls.prerequisite[0].$.name
            else if (cls.$ && cls.$.parent) parent = cls.$.parent
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
    }

    loadInheritance(inheritanceTable) {
        // Class and interface hierarchies
        this.loadHierarchy(this.ns.class, inheritanceTable)
        this.loadHierarchy(this.ns.interface, inheritanceTable)

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

    // targetMod is the module the typename is going to be used in, which may
    // be different from the module that defines the type
    private typeLookup(e: GirVariable, targetMod?: GirModule) {
        if (!targetMod) targetMod = this
        let type: GirType
        let arr = ''
        let arrCType
        let nul = ''
        const collection = e.array
            ? e.array
            : e.type && /^GLib.S?List$/.test(e.type[0].$.name)
            ? (e.type as GirArray[])
            : undefined

        if (collection && collection.length > 0) {
            const typeArray = collection[0].type
            if (typeArray == null || typeArray.length == 0) return 'any'
            if (collection[0].$) {
                const ea: any = collection[0].$
                arrCType = ea['c:type']
            }
            type = typeArray[0]
            arr = '[]'
        } else if (e.type) type = e.type[0]
        else return 'any'

        if (e.$) {
            const nullable = this.paramIsNullable(e)
            if (nullable) {
                nul = ' | null'
            }
        }

        if (!type.$) return 'any'

        const suffix = arr + nul

        if (arr) {
            const podTypeMapArray = {
                guint8: 'Gjs.byteArray.ByteArray',
                gint8: 'Gjs.byteArray.ByteArray',
                gunichar: 'string',
            }
            if (podTypeMapArray[type.$.name] != null) return podTypeMapArray[type.$.name] + nul
        }

        const podTypeMap = {
            utf8: 'string',
            none: 'void',
            double: 'number',
            guint32: 'number',
            guint16: 'number',
            gint16: 'number',
            gunichar: 'number',
            gint8: 'number',
            gint32: 'number',
            gushort: 'number',
            gfloat: 'number',
            gboolean: 'boolean',
            gpointer: 'object',
            gchar: 'number',
            guint: 'number',
            glong: 'number',
            gulong: 'number',
            gint: 'number',
            guint8: 'number',
            guint64: 'number',
            gint64: 'number',
            gdouble: 'number',
            gssize: 'number',
            gsize: 'number',
            long: 'number',
            object: 'any',
            va_list: 'any',
            gshort: 'number',
            filename: 'string',
        }

        if (podTypeMap[type.$.name] != null) return podTypeMap[type.$.name] + suffix

        if (!this.name) return 'any'

        let cType = type.$['c:type']
        if (!cType) cType = arrCType

        if (cType) {
            const cTypeMap = {
                'char*': 'string',
                'gchar*': 'string',
                'gchar**': 'any', // FIXME
                GType: (targetMod.name == 'GObject' ? 'Type' : 'GObject.Type') + suffix,
            }
            if (cTypeMap[cType]) {
                return cTypeMap[cType]
            }
        }

        let fullTypeName: string | null = type.$.name
        // Fully qualify our type name if need be
        if (fullTypeName && fullTypeName.indexOf('.') < 0) {
            let mod: GirModule = this
            if (e._module) mod = e._module
            fullTypeName = `${mod.name}.${type.$.name}`
        }

        const fullTypeMap = {
            'GObject.Value': 'any',
            'GObject.VaClosureMarshal': 'Function',
            'GObject.Closure': 'Function',
            'GLib.ByteArray': 'Gjs.byteArray.ByteArray',
            'GLib.Bytes': 'Gjs.byteArray.ByteArray',
        }

        if (fullTypeName && fullTypeMap[fullTypeName]) {
            return fullTypeMap[fullTypeName]
        }

        if (!fullTypeName || this.symTable[fullTypeName] == null) {
            console.warn(`Could not find type ${fullTypeName} for ${e.$.name}`)
            return 'any' + arr
        }

        if (targetMod.name && fullTypeName.indexOf(targetMod.name + '.') == 0) {
            const ret = fullTypeName.substring(targetMod.name.length + 1)
            // console.warn(`Rewriting ${fullTypeName} to ${ret} + ${suffix} -- ${this.name} -- ${e._module}`)
            if (fullTypeName == 'Gio.ApplicationFlags') {
                debugger
            }
            return ret + suffix
        }

        return fullTypeName + suffix
    }

    private girBool(e: string | undefined, defaultVal = false): boolean {
        if (e) {
            if (parseInt(e) == 0) return false
            return true
        }
        return defaultVal
    }

    private getReturnType(e: GirFunction, targetMod?: GirModule) {
        let returnType

        const returnVal = e['return-value'] ? e['return-value'][0] : undefined
        if (returnVal) returnType = this.typeLookup(returnVal, targetMod)
        else returnType = 'void'

        const outArrayLengthIndex =
            returnVal && returnVal.array && returnVal.array[0].$ && returnVal.array[0].$.length
                ? Number(returnVal.array[0].$.length)
                : -1

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

    private paramIsNullable(param: GirVariable) {
        const a = param.$
        return a && (a['nullable'] || a['allow-none'] || a['optional'])
    }

    private getParameters(parameters, outArrayLengthIndex: number, targetMod?: GirModule): [string, string[]] {
        const def: string[] = []
        const outParams: string[] = []

        if (parameters && parameters.length > 0) {
            const parametersArray = parameters[0].parameter
            if (parametersArray) {
                const skip = outArrayLengthIndex === -1 ? [] : [parametersArray[outArrayLengthIndex]]

                const processParams = (getIndex) => {
                    for (const param of parametersArray as GirVariable[]) {
                        const index = getIndex(param)
                        if (index < 0) continue
                        if (index >= parametersArray.length) continue
                        skip.push(parametersArray[index])
                    }
                }

                processParams(this.arrayLengthIndexLookup)
                processParams(this.closureDataIndexLookup)
                processParams(this.destroyDataIndexLookup)

                for (const param of parametersArray as GirVariable[]) {
                    const paramName = this.fixVariableName(param.$.name || '-', false)
                    const paramType = this.typeLookup(param, targetMod)

                    if (skip.indexOf(param) !== -1) {
                        continue
                    }

                    const optDirection = param.$.direction
                    if (optDirection) {
                        if (optDirection == 'out' || optDirection == 'inout') {
                            outParams.push(`/* ${paramName} */ ${paramType}`)
                            if (optDirection == 'out') continue
                        }
                    }

                    let allowNone = this.paramIsNullable(param) ? '?' : ''

                    if (allowNone.length) {
                        const index = parametersArray.indexOf(param)
                        const following = (parametersArray as GirVariable[])
                            .slice(index)
                            .filter((p) => skip.indexOf(param) === -1)
                            .filter((p) => p.$.direction !== 'out')

                        if (following.some((p) => !this.paramIsNullable(p))) {
                            allowNone = ''
                        }
                    }

                    const paramDesc = `${paramName}${allowNone}: ${paramType}`
                    def.push(paramDesc)
                }
            }
        }

        return [def.join(', '), outParams]
    }

    private fixVariableName(name: string, allowQuotes: boolean) {
        const reservedNames = {
            in: 1,
            function: 1,
            true: 1,
            false: 1,
            break: 1,
            arguments: 1,
            eval: 1,
            default: 1,
            new: 1,
        }

        // GJS always re-writes - to _ (I think?)
        name = name.replace(/-/g, '_')

        if (reservedNames[name]) {
            if (allowQuotes) return `"${name}"`
            else return `${name}_`
        }
        return name
    }

    private getVariable(v: GirVariable, optional = false, allowQuotes = false): FunctionDescription {
        if (!v.$.name) return [[], null]
        if (!v || !v.$ || !this.girBool(v.$.introspectable, true) || this.girBool(v.$.private)) return [[], null]

        const name = this.fixVariableName(v.$.name, allowQuotes)
        const typeName = this.typeLookup(v)
        const nameSuffix = optional ? '?' : ''

        return [[`${name}${nameSuffix}: ${typeName}`], name]
    }

    // construct means include the property even if it's construct-only,
    // optional means if it's construct-only it will also be marked optional (?)
    private getProperty(v: GirVariable, construct = false, optional = true): [string[], string | null, string | null] {
        if (!construct && this.girBool(v.$['construct-only']) && !this.girBool(v.$.readable)) return [[], null, null]
        if (this.girBool(v.$.private)) return [[], null, null]

        const propPrefix = !this.girBool(v.$.writable) || this.girBool(v.$['construct-only']) ? 'readonly ' : ''
        const [propDesc, propName] = this.getVariable(v, construct && optional, true)

        if (!propName) {
            return [[], null, null]
        }

        return [[`    ${propPrefix}${propDesc}`], propName, v.$.name || null]
    }

    exportEnumeration(e: GirEnumeration) {
        const def: string[] = []

        if (!e || !e.$ || !this.girBool(e.$.introspectable, true)) return []

        def.push(`export enum ${e.$.name} {`)
        if (e.member) {
            for (const member of e.member) {
                const name = member.$.name.toUpperCase()
                if (/\d/.test(name[0])) def.push(`    /* ${name} (invalid, starts with a number) */`)
                else def.push(`    ${name},`)
            }
        }
        def.push('}')
        return def
    }

    exportConstant(e: GirVariable) {
        const [varDesc, varName] = this.getVariable(e)
        if (varName) return [`export const ${varDesc}`]
        return []
    }

    private getFunction(
        e: GirFunction,
        prefix: string,
        funcNamePrefix: string | null = null,
        targetMod?: GirModule,
        overrideReturnType?: string,
    ): FunctionDescription {
        if (!e || !e.$ || !this.girBool(e.$.introspectable, true) || e.$['shadowed-by']) return [[], null]

        let name = e.$.name
        let [retType, outArrayLengthIndex] = this.getReturnType(e, targetMod)
        const [params, outParams] = this.getParameters(e.parameters, outArrayLengthIndex, targetMod)

        if (e.$['shadows']) {
            name = e.$['shadows']
        }

        if (funcNamePrefix) name = funcNamePrefix + name
        else funcNamePrefix = ''

        if (e._fullSymName == 'Gtk.Container.child_notify') {
            debugger
        }

        const reservedWords = {
            false: 1,
            true: 1,
            break: 1,
        }

        if (reservedWords[name]) return [[`/* Function '${name}' is a reserved word */`], null]

        const retTypeIsVoid = retType == 'void'
        if (overrideReturnType) {
            retType = overrideReturnType
        } else if (outParams.length + (retTypeIsVoid ? 0 : 1) > 1) {
            if (!retTypeIsVoid) {
                outParams.unshift(`/* returnType */ ${retType}`)
            }
            const retDesc = outParams.join(', ')
            retType = `[ ${retDesc} ]`
        } else if (outParams.length == 1 && retTypeIsVoid) {
            retType = outParams[0]
        }

        return [[`${prefix}${name}(${params}): ${retType}`], name]
    }

    private getConstructorFunction(
        name: string,
        e: GirFunction,
        prefix: string,
        funcNamePrefix: string | null = null,
        targetMod?: GirModule,
    ): FunctionDescription {
        if (!e.$) return [[], null]
        const [desc, funcName] = this.getFunction(e, prefix, funcNamePrefix, targetMod, name)
        if (!funcName) return [[], null]
        return [desc, funcName]
    }

    exportFunction(e: GirFunction) {
        return this.getFunction(e, 'export function ')[0]
    }

    exportCallback(e: GirFunction) {
        if (!e || !e.$ || !this.girBool(e.$.introspectable, true)) return []

        const name = e.$.name
        const [retType, outArrayLengthIndex] = this.getReturnType(e)
        const [params, outParams] = this.getParameters(e.parameters, outArrayLengthIndex)

        const def: string[] = []
        def.push(`export interface ${name} {`)
        def.push(`    (${params}): ${retType}`)
        def.push('}')
        return def
    }

    private traverseInheritanceTree(e: GirClass, callback: (cls: GirClass) => void) {
        const details = this.getClassDetails(e)
        if (!details) return
        callback(e)
        const { parentName, qualifiedParentName } = details
        if (parentName && qualifiedParentName) {
            let parentPtr = this.symTable[qualifiedParentName]
            if (!parentPtr && parentName == 'Object') {
                parentPtr = this.symTable['GObject.Object']
            }
            if (parentPtr) this.traverseInheritanceTree(parentPtr, callback)
        }
    }

    private forEachInterface(e: GirClass, callback: (cls: GirClass) => void, recurseObjects = false, dups = {}) {
        const mod: GirModule = e._module ? e._module : this
        if (e._fullSymName) dups[e._fullSymName] = true
        for (const { $ } of e.implements || []) {
            let name = $.name as string
            if (name.indexOf('.') < 0) {
                name = mod.name + '.' + name
            }
            if (dups.hasOwnProperty(name)) continue
            dups[name] = true
            const iface: GirClass | undefined = this.symTable[name]
            if (iface) {
                callback(iface)
                this.forEachInterface(iface, callback, recurseObjects, dups)
            }
        }
        if (e.prerequisite) {
            let parentName = e.prerequisite[0].$.name
            if (!parentName) return
            if (parentName.indexOf('.') < 0) {
                parentName = mod.name + '.' + parentName
            }
            if (dups.hasOwnProperty(parentName)) return
            const parentPtr = this.symTable[parentName]
            if (parentPtr && (parentPtr.prerequisite || recurseObjects)) {
                // iface's prerequisite is also an interface, or it's
                // a class and we also want to recurse classes
                callback(parentPtr)
                this.forEachInterface(parentPtr, callback, recurseObjects, dups)
            }
        }
    }

    private forEachInterfaceAndSelf(e: GirClass, callback: (cls: GirClass) => void) {
        callback(e)
        this.forEachInterface(e, callback)
    }

    private isDerivedFromGObject(e: GirClass): boolean {
        let ret = false
        this.traverseInheritanceTree(e, (cls) => {
            if (cls._fullSymName == 'GObject.Object') {
                ret = true
            }
        })
        return ret
    }

    private checkName(desc: string[], name: string | null, localNames: Set<string>): [string[], boolean] {
        if (!desc || desc.length == 0) return [[], false]

        if (!name) {
            // console.error(`No name for ${desc}`)
            return [[], false]
        }

        if (localNames.has(name)) {
            // console.warn(`Name ${name} already defined (${desc})`)
            return [[], false]
        }

        localNames.add(name)
        return [desc, true]
    }

    private processFields(cls: GirClass, localNames: Set<string>): string[] {
        const def: string[] = []
        if (cls.field) {
            def.push(`    // Fields of ${cls._fullSymName}`)
            for (const f of cls.field) {
                const [desc, name] = this.getVariable(f, false, false)
                const [aDesc, added] = this.checkName(desc, name, localNames)
                if (added) {
                    def.push(`    ${aDesc[0]}`)
                }
            }
        }
        return def
    }

    private logFunctionDefs(funcs: string[]) {
        for (const d in funcs) {
            console.log(`|        Definition ${d}: '${funcs[d]}'`)
        }
        console.log('|    ****')
    }

    private logFunctions(funcs: FunctionDescription[]) {
        for (const n in funcs) {
            const f = funcs[n]
            console.log(`|    Function ${n} is named "${f[1]}"`)
            this.logFunctionDefs(f[0])
        }
        console.log('****')
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

    private warnMethodPropClash = false

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
                if (this.warnMethodPropClash)
                    console.warn(`Removing method ${cls._fullSymName}.${m.$.name} due to a clash with a property`)
                return false
            }
            return m.$.name != null
        })
        const methods = methodNames.map((f) => this.getFunction(f, '    ', '', this)).filter((f) => f[1] != null)

        // GObject.Object signal methods aren't introspected.
        if (cls._fullSymName === 'GObject.Object') {
            this.addSignalMethod(methods, 'connect', [
                '    connect<T extends Function>(sigName: string, callback: T): number',
            ])
            this.addSignalMethod(methods, 'connect_after', [
                '    connect_after<T extends Function>(sigName: string, callback: T): number',
            ])
            this.addSignalMethod(methods, 'disconnect', ['    disconnect(tag: number): void'])
            this.addSignalMethod(methods, 'emit', ['    emit(sigName: string, ...args: any[]): void'])
        }
        return methods
    }

    private commentRegExp = /\/\*.*\*\//g
    private paramRegExp = /[0-9a-zA-Z_]*:/g
    private optParamRegExp = /[0-9a-zA-Z_]*\?:/g

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
        return this.stripParamNames(f1) == this.stripParamNames(f2)
    }

    // See comment for addOverloadableFunctions.
    // Returns true if (a definition from) func is added to map to satisfy
    // an overload, but false if it was forced
    private mergeOverloadableFunctions(map: FunctionMap, func: FunctionDescription, force = true) {
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
                defs.push(newDef)
                result = true
            }
        }
        return result
    }

    // fnMap values are equivalent to the second element of a FunctionDescription.
    // If an entry in fnMap is changed its name is added to explicits (set of names
    // which must be declared).
    // If force is true, every function of f2 is added to fnMap and overloads even
    // if it doesn't already contain a function of the same name.
    private addOverloadableFunctions(
        fnMap: FunctionMap,
        explicits: Set<string>,
        funcs: FunctionDescription[],
        force = false,
    ) {
        for (const func of funcs) {
            if (!func[1]) continue
            if (this.mergeOverloadableFunctions(fnMap, func) || force) {
                explicits.add(func[1])
            }
        }
    }

    // Used for <method> and <virtual-method>
    private processOverloadableMethods(
        cls: GirClass,
        getMethods: (e: GirClass) => FunctionDescription[],
        statics = false,
    ): [FunctionMap, Set<string>] {
        const fnMap: FunctionMap = new Map()
        const explicits = new Set<string>()
        const funcs = getMethods(cls)
        this.addOverloadableFunctions(fnMap, explicits, funcs, true)
        // Have to implement methods from cls' interfaces
        this.forEachInterface(
            cls,
            (iface) => {
                if (!this.interfaceIsDuplicate(cls, iface)) {
                    const funcs = getMethods(iface)
                    this.addOverloadableFunctions(fnMap, explicits, funcs, true)
                }
            },
            false,
        )
        // Check for overloads among all inherited methods
        let bottom = true
        this.traverseInheritanceTree(cls, (e) => {
            if (bottom) {
                bottom = false
                return
            }
            if (statics) {
                const funcs = getMethods(e)
                this.addOverloadableFunctions(fnMap, explicits, funcs, false)
            } else {
                let self = true
                this.forEachInterfaceAndSelf(e, (iface) => {
                    if (self || this.interfaceIsDuplicate(cls, iface)) {
                        const funcs = getMethods(iface)
                        this.addOverloadableFunctions(fnMap, explicits, funcs, false)
                    }
                    self = false
                })
            }
        })
        return [fnMap, explicits]
    }

    private exportOverloadableMethods(fnMap: FunctionMap, explicits: Set<string>) {
        const def: string[] = []
        for (const k of Array.from(explicits.values())) {
            const f = fnMap.get(k)
            if (f) def.push(...f)
        }
        return def
    }

    private processVirtualMethods(cls: GirClass): string[] {
        const [fnMap, explicits] = this.processOverloadableMethods(cls, (e) => {
            let methods = (e['virtual-method'] || []).map((f) => {
                const desc = this.getFunction(f, '    ', 'vfunc_', this)
                return desc
            })
            methods = methods.filter((f) => f[1] != null)
            return methods
        })
        return this.exportOverloadableMethods(fnMap, explicits)
    }

    private processStaticFunctions(cls: GirClass, getter: (e: GirClass) => FunctionDescription[]): string[] {
        const [fnMap, explicits] = this.processOverloadableMethods(cls, getter, true)
        return this.exportOverloadableMethods(fnMap, explicits)
    }

    // These have to be processed together, because signals add overloads
    // for connect() etc (including property notifications) and prop names may
    // clash with method names, meaning one or the other has to be removed
    private processInstanceMethodsSignalsProperties(cls: GirClass, localNames: Set<string>): string[] {
        const [fnMap, explicits] = this.processOverloadableMethods(cls, (e) => {
            // This already filters out methods with same name as superclass
            // properties
            let methods = this.getInstanceMethods(e)
            // Some records in Gst-1.0 have clashes between method and field names
            if (localNames.size) {
                methods = methods.filter((f) => f[1] && !localNames.has(f[1]))
            }
            return methods
        })
        // Add specific signal methods
        const signals = cls['glib:signal']
        if (signals && signals.length) {
            explicits.add('connect')
            explicits.add('connect_after')
            explicits.add('emit')
            for (const s of signals) {
                const [retType, outArrayLengthIndex] = this.getReturnType(s)
                let [params] = this.getParameters(s.parameters, outArrayLengthIndex)
                if (params.length > 0) params = ', ' + params
                const callback = `(obj: ${cls.$.name}${params}) => ${retType}`
                const signature = `(sigName: "${s.$.name}", callback: ${callback}): number`
                this.mergeOverloadableFunctions(fnMap, [[`    connect${signature}`], 'connect'], true)
                this.mergeOverloadableFunctions(fnMap, [[`    connect_after${signature}`], 'connect_after'], true)
                this.mergeOverloadableFunctions(
                    fnMap,
                    [[`    emit(sigName: "${s.$.name}"${params}): void`], 'emit'],
                    true,
                )
            }
        }
        let def: string[] = []
        // Although we've removed methods with the same name as an inherited
        // property we still need to filter out properties with the same
        // name as an inherited method.
        const dash = /-/g
        // The value indicates whether the property belongs to
        // cls (1 if cls only, 2 if also iface) or an interface (0)
        const propsMap: Map<string, number> = new Map()
        let props: GirVariable[] = []
        let self = true
        this.forEachInterfaceAndSelf(cls, (e) => {
            props = props.concat(
                (e.property || []).filter((p) => {
                    if (!p.$.name) return false
                    const xName = p.$.name.replace(dash, '_')
                    const mapped = propsMap.get(p.$.name)
                    if (fnMap.has(xName)) {
                        if (self) {
                            console.warn(
                                `Hiding property ${cls._fullSymName}.${xName} ` +
                                    'due to a clash with an inherited method',
                            )
                        }
                        return false
                    } else if (mapped) {
                        if (mapped === 1) {
                            propsMap.set(p.$.name, 2)
                        }
                        return false
                    } else {
                        propsMap.set(p.$.name, self ? 1 : 0)
                        return true
                    }
                }),
            )
            self = false
        })
        if (props.length) {
            let prefix = 'GObject.'
            if (this.name == 'GObject') prefix = ''
            def.push('    // Properties')
            for (const p of props) {
                // Some properties are construct-only overloads of
                // an implemnted interface property, so we use the self
                // flag from propsMap to force them to be included
                const [desc, name, origName] = this.getProperty(p, propsMap.get(p.$.name || '') === 2, false)
                def = def.concat(desc)
                // Each property also has a signal
                if (origName) {
                    const sigName = `sigName: "notify::${origName}"`
                    const params = `pspec: ${prefix}ParamSpec`
                    const callback = `(${params}) => void`
                    const signature = `(${sigName}, obj: ${cls.$.name}, ` + `callback: ${callback}): number`
                    this.mergeOverloadableFunctions(fnMap, [[`    connect${signature}`], 'connect'], true)
                    this.mergeOverloadableFunctions(fnMap, [[`    connect_after${signature}`], 'connect_after'], true)
                    this.mergeOverloadableFunctions(fnMap, [[`    emit(${sigName}, ${params}): void`], 'emit'], true)
                }
            }
        }
        const mDef = this.exportOverloadableMethods(fnMap, explicits)
        if (mDef.length) {
            def.push(`    // Instance and signal methods`)
            def = def.concat(mDef)
        }
        return def
    }

    // Some classes implement interfaces which are also implemented by a superclass
    // and we need to exclude those in some circumstances
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
        filter?: (funcName: string) => boolean,
        targetMod?: GirModule,
    ): FunctionDescription[] {
        const funcs = e['constructor']
        if (!Array.isArray(funcs)) return [[[], null]]
        let ctors = funcs.map((f) => {
            return this.getConstructorFunction(e.$.name, f, '    static ', null, targetMod)
        })
        if (filter) ctors = ctors.filter(([desc, funcName]) => funcName && filter(funcName))
        return ctors
    }

    private isGtypeStructFor(e: GirClass, rec: GirClass) {
        const isFor = rec.$['glib:is-gtype-struct-for']
        return isFor && isFor == e.$.name
    }

    // Some class/static methods are defined in a separate record which is not
    // exported, but the methods are available as members of the JS constructor.
    // In gjs one can use an instance of the object or a JS constructor as the
    // methods' instance-parameter. See:
    // https://discourse.gnome.org/t/using-class-methods-like-gtk-widget-class-get-css-name-from-gjs/4001
    private getClassMethods(e: GirClass) {
        if (!e.$.name || !e._module?.ns) {
            return []
        }
        const fName = e.$.name + 'Class'
        let rec = e._module.ns.record?.find((r) => r.$.name == fName)
        if (!rec || !this.isGtypeStructFor(e, rec)) {
            rec = e._module.ns.record?.find((r) => this.isGtypeStructFor(e, r))
            fName == rec?.$.name
        }
        if (!rec) return []
        const methods = rec.method || []
        return methods.map((m) => this.getFunction(m, '    static '))
    }

    private getOtherStaticFunctions(e: GirClass, stat = true, targetMod?: GirModule): FunctionDescription[] {
        const fns: FunctionDescription[] = []
        if (e.function) {
            for (const f of e.function) {
                const [desc, funcName] = this.getFunction(f, stat ? '    static ' : '    ', null, targetMod)
                if (funcName && funcName !== 'new') fns.push([desc, funcName])
            }
        }
        return fns
    }

    private getAllStaticFunctions(e: GirClass) {
        return this.getStaticConstructors(e).concat(this.getOtherStaticFunctions(e)).concat(this.getClassMethods(e))
    }

    private getClassDetails(e: GirClass): ClassDetails | null {
        if (!e || !e.$) return null
        const parent: GirClass | undefined = undefined
        const parentModule: GirModule | undefined = undefined
        const mod: GirModule = e._module ? e._module : this
        let name = e.$.name
        let qualifiedName
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
        if (e.prerequisite) {
            parentName = e.prerequisite[0].$.name
        } else if (e.$.parent) {
            parentName = e.$.parent
        }
        let parentMod
        if (parentName) {
            if (parentName.indexOf('.') < 0) {
                qualifiedParentName = mod.name + '.' + parentName
                parentMod = mod.name
            } else {
                qualifiedParentName = parentName
                const split = parentName.split('.')
                parentName = split[split.length - 1]
                parentMod = split.slice(0, split.length - 1).join('.')
            }
            localParentName = parentMod == mod.name ? parentName : qualifiedParentName
        }
        return { name, qualifiedName, parentName, qualifiedParentName, localParentName }
    }

    // This uses interfaceIsDuplicate() to filter out interfaces implemented
    // by subclasses
    private forEachImplementedLocalName(e: GirClass, callback: (name: string) => void) {
        if (e.implements) {
            for (const i of e.implements) {
                let name = i.$.name
                if (!name) continue
                let fullName
                if (name.indexOf('.') >= 0) {
                    fullName = name
                    const [mod, local] = name.split('.')
                    if (mod == this.name) name = local
                } else {
                    fullName = (this.name || '') + '.' + name
                }
                if (!this.interfaceIsDuplicate(e, fullName)) callback(name)
            }
        }
    }

    // Represents a record or GObject class or interface as a Typescript class
    private exportClassInternal(e: GirClass, record = false) {
        // Gtk has some weird classes that depend on DBus classes from Gio that
        // aren't exported due to is-gtype-struct-for, so filter them out too.
        if (e.$ && (e.$['glib:is-gtype-struct-for'] || (e.$['c:type'] || '').indexOf('_Gtk') === 0)) {
            return []
        }
        const details = this.getClassDetails(e)
        if (!details) return []
        const { name, parentName, localParentName } = details
        const isDerivedFromGObject = this.isDerivedFromGObject(e)

        let def: string[] = []

        // Properties for construction
        if (isDerivedFromGObject) {
            let ext = ' '
            if (parentName) ext = `extends ${localParentName}_ConstructProps `
            def.push(`export interface ${name}_ConstructProps ${ext}{`)
            const constructPropNames = new Set<string>()
            if (e.property) {
                for (const p of e.property) {
                    const [desc, name] = this.getProperty(p, true, true)
                    def = def.concat(this.checkName(desc, name, constructPropNames)[0])
                }
            }
            if (e.implements) {
                this.forEachInterface(e, (iface) => {
                    if (iface.property) {
                        for (const p of iface.property) {
                            const [desc, name] = this.getProperty(p, true, true)
                            def = def.concat(this.checkName(desc, name, constructPropNames)[0])
                        }
                    }
                })
            }
            def.push('}')
        }

        // Class definition starts here

        // TS classes implicitly have an interface with the same name so we
        // can use them in implements etc even though they're declared as classes
        let parents = ''
        if (e.$.parent) {
            parents += ` extends ${localParentName}`
        }
        if (e.implements) {
            const impl: string[] = []
            this.forEachImplementedLocalName(e, (n) => impl.push(n))
            if (impl.length) parents += ' implements ' + impl.join(',')
        }
        def.push(`export class ${name}${parents} {`)
        const localNames = new Set<string>()
        // Can't export fields for GObjects because names would clash
        if (record) {
            def = def.concat(this.processFields(e, localNames))
        }

        def = def.concat(this.processInstanceMethodsSignalsProperties(e, localNames))
        def = def.concat(this.processVirtualMethods(e))

        if (isDerivedFromGObject || e.prerequisite) {
            def.push('    // Type field')
            def.push(`    static $gtype: ${this.name == 'GObject' ? '' : 'GObject.'}Type`)
        }

        // JS constructor(s)
        let stc: string[] = []
        if (isDerivedFromGObject) {
            stc.push(`    constructor(config?: ${name}_ConstructProps)`)
            stc.push(`    _init(config?: ${name}_ConstructProps): void`)
        } else if (e.prerequisite) {
            // Interfaces can't be instantiated
            stc = stc.concat('    protected constructor(a?: any)')
        }
        if (stc.length) {
            def.push('    // Constructor')
            def = def.concat(stc)
        }

        // Records, classes and interfaces all have a static name
        def.push('    static name: string')

        // Static methods, <constructor> and <function>
        stc = this.processStaticFunctions(e, (cls) => {
            return this.getAllStaticFunctions(cls)
        })
        if (stc.length > 0) {
            def.push('    // Static methods and pseudo-constructors')
            def = def.concat(stc)
        }

        def.push('}')
        return def
    }

    exportAlias(e: GirAlias) {
        if (!e || !e.$ || !this.girBool(e.$.introspectable, true)) return []

        const typeName = this.typeLookup(e)
        const name = e.$.name

        return [`type ${name} = ${typeName}`]
    }

    exportJs(outStream: NodeJS.WritableStream) {
        outStream.write(`module.exports = imports.gi.${this.name}`)
    }

    export(outStream: NodeJS.WritableStream) {
        let out: string[] = []

        out.push('/**')
        out.push(` * ${this.name}-${this.version}`)
        out.push(' */')

        out.push('')

        const deps: string[] = this.transitiveDependencies

        // Always pull in GObject, as we may need it for e.g. GObject.type
        if (this.name != 'GObject') {
            if (!lodash.find(deps, (x) => x == 'GObject')) {
                deps.push('GObject')
            }
        }

        out.push("import * as Gjs from './Gjs'")
        for (const d of deps) {
            const base = d.split('-')[0]
            out.push(`import * as ${base} from './${base}'`)
        }

        if (this.ns.enumeration) for (const e of this.ns.enumeration) out = out.concat(this.exportEnumeration(e))

        if (this.ns.bitfield) for (const e of this.ns.bitfield) out = out.concat(this.exportEnumeration(e))

        if (this.ns.constant) for (const e of this.ns.constant) out = out.concat(this.exportConstant(e))

        if (this.ns.function) for (const e of this.ns.function) out = out.concat(this.exportFunction(e))

        if (this.ns.callback) for (const e of this.ns.callback) out = out.concat(this.exportCallback(e))

        if (this.ns.interface) for (const e of this.ns.interface) out = out.concat(this.exportClassInternal(e))

        // Extra interfaces used to help define GObject classes in js; these
        // aren't part of gi.
        if (this.name == 'GObject') {
            out = out.concat([
                `export interface SignalDefinition {
    flags?: SignalFlags,
    accumulator: number,
    return_type?: Type,
    param_types?: Type[]
}`,
                `export interface MetaInfo {
    GTypeName: string,
    GTypeFlags?: TypeFlags,
    Implements?: Function[],
    Properties?: {[K: string]: ParamSpec},
    Signals?: {[K: string]: SignalDefinition},
    Requires?: Function[],
    CssName?: string,
    Template?: string,
    Children?: string[],
    InternalChildren?: string[]
}`,
                'export const GTypeName: symbol',
                'export const requires: symbol',
                'export const interfaces: symbol',
                'export const properties: symbol',
                'export const signals: symbol',
                'export function registerClass(metaInfo: MetaInfo, klass: Function): Function',
                'export function registerClass(klass: Function): Function',
                'export function registerClass<T extends MetaInfo | Function>(a: T, b?: Function): Function',
            ])
        }

        if (this.ns.class)
            for (const e of this.ns.class) {
                out = out.concat(this.exportClassInternal(e, false))
            }

        if (this.ns.record) for (const e of this.ns.record) out = out.concat(this.exportClassInternal(e, true))

        if (this.ns.union) for (const e of this.ns.union) out = out.concat(this.exportClassInternal(e, true))

        if (this.ns.alias)
            // GType is not a number in GJS
            for (const e of this.ns.alias)
                if (this.name != 'GObject' || e.$.name != 'Type') out = out.concat(this.exportAlias(e))

        if (this.name == 'GObject') out = out.concat(['export interface Type {', '    name: string', '}'])

        outStream.write(out.join('\n'))
    }
}

function exportGjs(outDir: string | null, girModules: { [key: string]: any }) {
    if (!outDir) return

    fs.createWriteStream(`${outDir}/Gjs.d.ts`).write(
        `export namespace byteArray {
    export class ByteArray {
        constructor(lenOrArray: any)    // May be a Uint8Array or any type
                                        // accepted by its constructor
        toGBytes(): any  // GLib.Bytes?
        toString(encoding?: string): string
        length: number
        static get(target: ByteArray, prop: number,
                receiver?: ByteArray): number
        static set(target: ByteArray, prop: number, val: number,
                receiver?: ByteArray): number
        _array: Uint8Array
    }
    export function fromString(input: string): ByteArray
    export function fromArray(input: number[]): ByteArray
    export function fromGBytes(input: any): ByteArray
    export function toString(x: ByteArray): string
}
export namespace console {
    export function interact(): void
}
export namespace Lang {
    // TODO: There is a lot more in Lang
    export function Class(props: any): void
}
export namespace gettext {
    export enum LocaleCategory {
        ALL, COLLATE, CTYPE, MESSAGES, MONETARY, NUMERIC, TIME
    }
    export function setlocale(category: number, locale: string|null): string
    export function textdomain(domainname: string|null): string
    export function bindtextdomain(domainname: string, dirname: string|null): string
    export function gettext(msgid: string): string
    export function dgettext(domainname: string|null, msgid: string): string
    export function dcgettext(domainname: string|null, msgid: string, category: number): string
    export function ngettext(msgid: string, msgid_plural: string, n: number): string
    export function dngettext(domainname: string, msgid: string, msgid_plural: string, n: number): string
    export function domain(domainName: string): {
        gettext: ((msgid: string) => string),
        ngettext: ((msgid: string, msgid_plural: string, n:number) => string),
        pgettext: ((context: any, msgid: string) => any)
    }
}
export namespace Format {
    export function vprintf(str: string, args: string[]): string
    export function printf(fmt: string, ...args: any[]): void
    // Following docs from gjs/modules/format.js
    /** 
     * This function is intended to extend the String object and provide
     * an String.format API for string formatting.
     * It has to be set up using String.prototype.format = Format.format;
     * Usage:
     * "somestring %s %d".format('hello', 5);
     * It supports %s, %d, %x and %f, for %f it also support precisions like
     * "%.2f".format(1.526). All specifiers can be prefixed with a minimum
     * field width, e.g. "%5s".format("foo"). Unless the width is prefixed
     * with '0', the formatted string will be padded with spaces.
     */
    export function format(fmt: string, ...args: any[]): string
}
export namespace Mainloop {
    export function quit(name: string): void
    export function idle_source(handler: any, priority: number): any
    export function idle_add(handler: any, priority: number): any
    export function timeout_source(timeout: any, handler: any, priority: number): any
    export function timeout_seconds_source(timeout: any, handler: any, priority: number): any
    export function timeout_add(timeout: any, handler: any, priority: number): any
    export function timeout_add_seconds(timeout: any, handler: any, priority: number): any
    export function source_remove(id: any): any
    export function run(name: string): void
}
`,
    )

    fs.createWriteStream(`${outDir}/Gjs.js`).write(
        `module.exports = {
    byteArray: imports.byteArray,
    Lang: imports.lang,
    Format: imports.format,
    Mainloop: imports.mainloop,
    gettext: imports.gettext
}`,
    )

    const keys = lodash.keys(girModules).map((key) => key.split('-')[0])

    // Breaks dependent app with error TS2383 if directly in global.
    // https://github.com/Microsoft/TypeScript/issues/16430
    fs.createWriteStream(`${outDir}/print.d.ts`).write(`declare function print(...args: any[]): void`)

    fs.createWriteStream(`${outDir}/index.js`).write('')

    fs.createWriteStream(`${outDir}/index.d.ts`).write(
        `/// <reference path="print.d.ts" />

import * as Gjs from "./Gjs";
${keys.map((key) => `import * as ${key} from "./${key}";`).join('\n')}

declare global {
    function printerr(...args: any[]): void
    function log(message?: string): void
    function logError(exception: any, message?: string): void
    const ARGV: string[]
    const imports: typeof Gjs & {
        [key: string]: any
        gi: {
${keys.map((key) => `            ${key}: typeof ${key}`).join('\n')}
        }
        searchPath: string[]
    }
}

export { }`,
    )
}

function exportExtra(outDir: string | null, inheritanceTable) {
    if (!outDir) return

    const def: string[] = []
    def.push("import * as GObject from './GObject'")
    def.push('')
    def.push('let inheritanceTable = {')
    for (const k of lodash.keys(inheritanceTable)) {
        const arr: string = "'" + inheritanceTable[k].join("', '") + "'"
        def.push(`    '${k}': [ ${arr} ],`)
    }
    def.push('}')
    def.push('')

    def.push(`
interface StaticNamed {
    name: string
}

/** Casts between derived classes, performing a run-time type-check
 * and raising an exception if the cast fails. Allows casting to implemented
 * interfaces, too.
 */
export function giCast<T>(from_: GObject.Object, to_: StaticNamed): T {
    let desc: string = from_.toString()
    let clsName: string|null = null
    for (let k of desc.split(" ")) {
        if (k.substring(0, 7) == "GIName:") {
            clsName = k.substring(7)
            break
        }
    }
    let toName = to_.name.replace("_", ".")

    if (toName === clsName)
        return ((from_ as any) as T)

    if (clsName) {
        let parents = inheritanceTable[clsName]
        if (parents) {
            if (parents.indexOf(toName) >= 0)
                return ((from_ as any) as T)
        }
    }

    throw Error("Invalid cast of " + desc + "(" + clsName + ") to " + toName)
}    
`)

    fs.createWriteStream(`${outDir}/cast.ts`).write(def.join('\n'))
}

function finaliseInheritance(inheritanceTable) {
    for (const clsName of lodash.keys(inheritanceTable)) {
        let p = inheritanceTable[clsName][0]
        while (p) {
            p = inheritanceTable[p]
            if (p) {
                p = p[0]
                inheritanceTable[clsName].push(p)
            }
        }
    }
}

function main() {
    commander
        .option('-g --gir-directory [directory]', 'GIR directory', '/usr/share/gir-1.0')
        .option(
            '-m --module [module]',
            "GIR modules to load, e.g. 'Gio-2.0'. May be specified multiple " + 'times',
            (val, lst) => {
                lst.push(val)
                return lst
            },
            [],
        )
        .option('-o --outdir [dir]', 'Directory to output to', null)
        .parse(process.argv)

    const girModules: { [key: string]: GirModule } = {}
    const girDirectory = commander.girDirectory
    const girToLoad = commander.module

    if (girToLoad.length == 0) {
        console.error('Need to specify modules via -m!')
        return
    }

    while (girToLoad.length > 0) {
        const name = girToLoad.shift()
        const fileName = `${girDirectory}/${name}.gir`
        console.log(`Parsing ${fileName}...`)
        const fileContents = fs.readFileSync(fileName, 'utf8')
        xml2js.parseString(fileContents, (err, result) => {
            if (err) {
                console.error('ERROR: ' + err)
                return
            }
            const gi = new GirModule(result)

            if (!gi.name) return

            girModules[`${gi.name}-${gi.version}`] = gi

            for (const dep of gi.dependencies) {
                if (!girModules[dep] && lodash.indexOf(girToLoad, dep) < 0) {
                    girToLoad.unshift(dep)
                }
            }
        })
    }

    //console.dir(girModules["GObject-2.0"], { depth: null })

    console.log('Files parsed, loading types...')

    const symTable: { [name: string]: any } = {}
    for (const k of lodash.values(girModules)) k.loadTypes(symTable)

    const inheritanceTable: { [name: string]: string[] } = {}
    for (const k of lodash.values(girModules)) k.loadInheritance(inheritanceTable)
    finaliseInheritance(inheritanceTable)

    //console.dir(inheritanceTable)

    // Figure out transitive module dependencies
    const modDependencyMap: { [name: string]: string[] } = {}

    for (const k of lodash.values(girModules)) {
        modDependencyMap[k.name || '-'] = lodash.map(k.dependencies || [], (val: string) => {
            return val.split('-')[0]
        })
    }

    const traverseDependencies = (name, ret) => {
        const deps = modDependencyMap[name]

        for (const a of deps) {
            if (ret[a]) continue
            ret[a] = 1
            traverseDependencies(a, ret)
        }
    }

    for (const k of lodash.values(girModules)) {
        const ret = {}
        traverseDependencies(k.name, ret)
        k.transitiveDependencies = lodash.keys(ret)
    }

    console.log('Types loaded, generating .d.ts...')

    for (const k of lodash.keys(girModules)) {
        let outf: NodeJS.WritableStream = process.stdout
        if (commander.outdir) {
            const outdir: string = commander.outdir
            const name: string = girModules[k].name || 'unknown'
            const fileName = `${outdir}/${name}.d.ts`
            outf = fs.createWriteStream(fileName)
        }
        console.log(` - ${k} ...`)
        girModules[k].export(outf)

        if (commander.outdir) {
            const outdir: string = commander.outdir
            const name: string = girModules[k].name || 'unknown'
            const fileName = `${outdir}/${name}.js`
            outf = fs.createWriteStream(fileName)
        }

        girModules[k].exportJs(outf)
    }

    // GJS internal stuff
    exportGjs(commander.outdir, girModules)
    exportExtra(commander.outdir, inheritanceTable)

    console.log('Done.')
}

if (require.main === module) {
    // If we don't catch exceptions, stdout gets truncated
    try {
        main()
    } catch (ex) {
        console.log(ex.stack)
    }
}
