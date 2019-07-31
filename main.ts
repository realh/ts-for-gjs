import * as xml2js from 'xml2js'
import * as lodash from 'lodash'
import * as commander from 'commander'
import fs = require('fs')

interface TsForGjsExtended {
    _module?: GirModule
    _fullSymName?: string
}

interface ClassDetails {
    name: string
    qualifiedName: string
    parentName?: string
    qualifiedParentName?: string
    localParentName?: string    // qualified if its module != qualifiedName's module
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
        "xml:space"?: string
    }
}
interface GirImplements {
    $: {
        "name"?: string
    }
}
interface GirPrerequisite {
    $: {
        "name"?: string
    }
}
interface GirType {
    $: {
        name: string
        "c:type"?: string
    }
}
interface GirArray {
    $?: {
        length?: string
        "zero-terminated"?: string
        "c:type"?: string
    }
    type?: GirType[]
}
interface GirVariable extends TsForGjsExtended {
    $: {
        name?: string
        "transfer-ownership"?: string
        nullable?: string
        "allow-none"?: string
        writable?: string
        readable?: string
        private?: string
        "construct-only"?: string
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
    "instance-parameter"?: GirVariable[]
}
interface GirFunction extends TsForGjsExtended {
    $: {
        name: string
        version?: string
        "c-identifier"?: string
        introspectable?: string
        "moved-to"?: string
        "shadowed-by"?: string
    }
    doc?: GirDoc[]
    parameters?: GirParameter[]
    "return-value"?: GirVariable[]
}
interface GirSignal extends TsForGjsExtended {
    $: {
        name: string
        when: string
    }
    doc?: GirDoc[]
    "return-value"?: GirParameter[]
}
interface GirClass extends TsForGjsExtended {
    $: {
        name: string
        parent?: string
        version?: string
        // Not sure what this means
        disguised?: string
        // c:symbol-prefix, c:type, glib:get-type, glib:type-name
        "glib:is-gtype-struct-for"?: string
    }
    doc?: GirDoc[]
    function?: GirFunction[]
    "glib:signal"?: GirFunction[]
    method?: GirFunction[]
    property?: GirVariable[]
    field?: GirVariable[]
    "virtual-method"?: GirFunction[]
    "constructor"?: GirFunction[] | Function
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
        "c:type"?: string
        introspectable?: string
        // glib:get-type, glib:type-name
    }
    doc?: GirDoc[]
    member?: GirEnumerationMember[]
}
interface GirAlias extends TsForGjsExtended {
    $: {
        name: string
        "c:type"?: string
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

export class GirModule {
    name: string | null = null
    version: string = "0.0"
    dependencies: string[] = []
    transitiveDependencies: string[] = []
    repo: GirRepository
    ns: GirNamespace = { $: { name: "", version: "" } }
    symTable: { [key:string]: any } = {}
    patch: { [key:string]: string[] } = {}

    constructor(xml) {
        this.repo = xml.repository

        if (this.repo.include) {
            for (let i of this.repo.include) {
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
        let loadTypesInternal = (arr) => {
            if (arr) {
                for (let x of arr) {
                    if (x.$) {
                        if (x.$.introspectable) {
                            if (!this.girBool(x.$.introspectable, true))
                                continue 
                        }
                    }

                    let symName = `${this.name}.${x.$.name}`
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

        let annotateFunctionArguments = (f: GirFunction) => {
            let funcName = f._fullSymName
            if (f.parameters)
                for (let p of f.parameters)
                    if (p.parameter)
                        for (let x of p.parameter) {
                            x._module = this
                            if (x.$ && x.$.name) {
                                x._fullSymName = `${funcName}.${x.$.name}`
                            }
                        }
        }
        let annotateFunctionReturn = (f: GirFunction) => {
            let retVal: GirVariable[]|undefined = f["return-value"]
            if (retVal)
                for (let x of retVal) {
                    x._module = this
                    if (x.$ && x.$.name) {
                        x._fullSymName = `${f._fullSymName}.${x.$.name}`
                    }
                }
        }
        let annotateFunctions = (obj: GirClass|null, funcs: GirFunction[]) => {
            if (funcs)
                for (let f of funcs) {
                    let nsName = obj ? obj._fullSymName : this.name
                    f._fullSymName = `${nsName}.${f.$.name}`
                    annotateFunctionArguments(f)
                    annotateFunctionReturn(f)
                }
        }
        let annotateVariables = (obj: GirClass|null, vars) => {
            if (vars)
                for (let x of vars) {
                    let nsName = obj ? obj._fullSymName : this.name
                    x._module = this
                    if (x.$ && x.$.name) {
                        x._fullSymName = `${nsName}.${x.$.name}`
                    }
                }
        }

        if (this.ns.callback) 
            for (let f of this.ns.callback) 
                annotateFunctionArguments(f)


        let objs = (this.ns.class ? this.ns.class : []).concat(
                    this.ns.record ? this.ns.record : []).concat(
                    this.ns.interface ? this.ns.interface : [])

        for (let c of objs) {
            c._module = this
            c._fullSymName = `${this.name}.${c.$.name}`
            annotateFunctions(c, c.function || [])
            annotateFunctions(c, c.method || [])
            annotateFunctions(c, c["virtual-method"] || [])
            annotateFunctions(c, c["glib:signal"] || [])
            annotateVariables(c, c.property)
            annotateVariables(c, c.field)
        }

        if (this.ns.function)
            annotateFunctions(null, this.ns.function)

        if (this.ns.constant)
            annotateVariables(null, this.ns.constant)

        // if (this.ns.)
        // props

        this.symTable = dict
    }

    private loadHierarchy(classes, inheritanceTable) {
        if (!classes) return
        for (let cls of classes) {
            let parent: string | null = null
            if (cls.prerequisite)
                parent = cls.prerequisite[0].$.name
            else if (cls.$ && cls.$.parent)
                parent = cls.$.parent
            if (!parent) continue
            if (!cls._fullSymName) continue

            if (parent.indexOf(".") < 0) {
                parent = this.name + "." + parent
            }
            let clsName = cls._fullSymName

            let arr: string[] = inheritanceTable[clsName] || []
            arr.push(parent)
            inheritanceTable[clsName] = arr
        }
    }

    loadInheritance(inheritanceTable) {
        // Class and interface hierarchies
        this.loadHierarchy(this.ns.class, inheritanceTable);
        this.loadHierarchy(this.ns.interface, inheritanceTable);

        // Class interface implementations
        for (let cls of (this.ns.class ? this.ns.class : [])) {
            if (!cls._fullSymName)
                continue

            let names: string[] = []

            for (let i of (cls.implements ? cls.implements : [])) {
                if (i.$.name) {
                    let name: string = i.$.name
                    if (name.indexOf(".") < 0) {
                        name = cls._fullSymName.substring(0, cls._fullSymName.indexOf(".") + 1) + name
                    }
                    names.push(name)
                }
            }

            if (names.length > 0) {
                let clsName = cls._fullSymName
                let arr: string[] = inheritanceTable[clsName] || []
                inheritanceTable[clsName] = arr.concat(names)
            }
        }
    }

    // targetMod is the module the typename is going to be used in, which may
    // be different from the module that defines the type
    private typeLookup(e: GirVariable, targetMod?: GirModule) {
        if (!targetMod)
            targetMod = this
        let type: GirType
        let arr: string = ''
        let arrCType
        let nul: string = ''
        const collection =
            e.array
                ? e.array
                : (e.type && /^GLib.S?List$/.test(e.type[0].$.name))
                    ? e.type as GirArray[]
                    : undefined

        if (collection && collection.length > 0) {
            let typeArray = collection[0].type
            if (typeArray == null || typeArray.length == 0)
                return 'any'
            if (collection[0].$) {
                let ea: any = collection[0].$
                arrCType = ea['c:type']
            }
            type = typeArray[0]
            arr = '[]'
        } else if (e.type)
            type = e.type[0]
        else
            return "any";

        if (e.$) {
            let nullable = this.girBool(e.$.nullable) || this.girBool(e.$["allow-none"])
            if (nullable) {
                nul = ' | null'
            }
        }

        if (!type.$)
            return 'any'

        let suffix = arr + nul

        if (arr) {
            let podTypeMapArray = {
                'guint8': 'Gjs.byteArray.ByteArray',
                'gint8': 'Gjs.byteArray.ByteArray',
                'gunichar': 'string'
            }
            if (podTypeMapArray[type.$.name] != null)
                return podTypeMapArray[type.$.name] + nul
        }

        let podTypeMap = {
            'utf8': 'string', 'none': 'void', 'double': 'number', 'guint32': 'number',
            'guint16': 'number', 'gint16': 'number', 'gunichar': 'number',
            'gint8': 'number', 'gint32': 'number', 'gushort': 'number', 'gfloat': 'number',
            'gboolean': 'boolean', 'gpointer': 'object', 'gchar': 'number',
            'guint': 'number', 'glong': 'number', 'gulong': 'number', 'gint': 'number',
            'guint8': 'number', 'guint64': 'number', 'gint64': 'number', 
            'gdouble': 'number', 'gssize': 'number', 'gsize': 'number', 'long': 'number',
            'object': 'any', 'va_list': 'any', 'gshort': 'number', 'filename': 'string'
        }

        if (podTypeMap[type.$.name] != null)
            return podTypeMap[type.$.name] + suffix

        if (!this.name)
            return "any"

        let cType = type.$['c:type']
        if (!cType)
            cType = arrCType

        if (cType) {
            let cTypeMap = {
                'char*': 'string',
                'gchar*': 'string',
                'gchar**': 'any',  // FIXME
                'GType': (targetMod.name == 'GObject' ? 'Type' : 'GObject.Type') + suffix,
            }
            if (cTypeMap[cType]) {
                return cTypeMap[cType]
            }
        }

        let fullTypeName: string | null = type.$.name

        let fullTypeMap = {
            'GObject.Value': 'any',
            'GObject.Closure': 'Function',
            'GLib.ByteArray': 'Gjs.byteArray.ByteArray',
            'GLib.Bytes': 'Gjs.byteArray.ByteArray'
        }

        if (fullTypeName && fullTypeMap[fullTypeName]) {
            return fullTypeMap[fullTypeName]
        }
        
        // Fully qualify our type name if need be
        if (fullTypeName && fullTypeName.indexOf(".") < 0) {
            let mod: GirModule = this
            if (e._module) mod = e._module
            fullTypeName = `${mod.name}.${type.$.name}`
        }

        if (!fullTypeName || this.symTable[fullTypeName] == null) {
            console.warn(`Could not find type ${fullTypeName} for ${e.$.name}`)
            return "any" + arr
        }

        if (targetMod.name && fullTypeName.indexOf(targetMod.name + ".") == 0) {
            let ret = fullTypeName.substring(targetMod.name.length + 1)
            // console.warn(`Rewriting ${fullTypeName} to ${ret} + ${suffix} -- ${this.name} -- ${e._module}`)
            if (fullTypeName == 'Gio.ApplicationFlags') {
                debugger;
            }
            return ret + suffix
        }

        return fullTypeName + suffix
    }

    private girBool(e: string | undefined, defaultVal: boolean = false): boolean {
        if (e) {
            if (parseInt(e) == 0)
                return false
            return true
        }
        return defaultVal
    }

    private getReturnType(e, targetMod?: GirModule) {
        let returnType

        let returnVal = e["return-value"] ? e["return-value"][0] : undefined
        if (returnVal) {
            returnType = this.typeLookup(returnVal, targetMod)
        } else
            returnType = "void"

        let outArrayLengthIndex = returnVal.array && returnVal.array[0].$.length
            ? Number(returnVal.array[0].$.length)
            : -1

        return [returnType, outArrayLengthIndex] as [string, number]
    }

    private arrayLengthIndexLookup(param: GirVariable): number {
        if (!param.array)
            return -1
        
        let arr: GirArray = param.array[0]
        if (!arr.$)
            return -1

        if (arr.$.length) {
            return parseInt(arr.$.length)
        }

        return -1
    }

    private closureDataIndexLookup(param: GirVariable): number {
        if (!param.$.closure)
            return -1

        return parseInt(param.$.closure)
    }

    private destroyDataIndexLookup(param: GirVariable): number {
        if (!param.$.destroy)
            return -1

        return parseInt(param.$.destroy)
    }

    private getParameters(parameters, outArrayLengthIndex: number,
                         targetMod?: GirModule): [ string, string[] ] {
        let def: string[] = []
        let outParams: string[] = []

        if (parameters && parameters.length > 0) {
            let parametersArray = parameters[0].parameter
            if (parametersArray) {
                const skip = outArrayLengthIndex === -1
                    ? []
                    : [parametersArray[outArrayLengthIndex]]

                let processParams = (getIndex) => {
                    for (let param of parametersArray as GirVariable[]) {
                        let index = getIndex(param)
                        if (index < 0) continue
                        if (index >= parametersArray.length) continue
                        skip.push(parametersArray[index])
                    }
                }
  
                processParams(this.arrayLengthIndexLookup)
                processParams(this.closureDataIndexLookup)
                processParams(this.destroyDataIndexLookup)

                for (let param of parametersArray as GirVariable[]) {
                    let paramName = this.fixVariableName(param.$.name || '-', false)
                    let paramType = this.typeLookup(param, targetMod)

                    if (skip.indexOf(param) !== -1) {
                        continue
                    }

                    let optDirection = param.$.direction
                    if (optDirection) {
                        if (optDirection == 'out') {
                            outParams.push(`/* ${paramName} */ ${paramType}`)
                            continue
                        }
                    }

                    let allowNone = param.$["allow-none"] ? "?" : ""

                    if (allowNone) {
                        const index = parametersArray.indexOf(param)
                        const following = (parametersArray as GirVariable[]).slice(index)
                            .filter(p => skip.indexOf(param) === -1)
                            .filter(p => p.$.direction !== "out")

                        if (following.some(p => !p.$["allow-none"])) {
                            allowNone = ""
                        }
                    }
                    
                    let paramDesc = `${paramName}${allowNone}: ${paramType}`
                    def.push(paramDesc)
                }
            }
        }

        return [ def.join(", "), outParams ]
    }

    private fixVariableName(name: string, allowQuotes: boolean) {
        const reservedNames = {
            'in': 1, 'function': 1, 'true': 1, 'false': 1, 'break': 1,
            'arguments': 1, 'eval': 1, 'default': 1, 'new': 1
        }

        // GJS always re-writes - to _ (I think?)
        name = name.replace(/-/g, "_")

        if (reservedNames[name]) {
            if (allowQuotes)
                return `"${name}"`
            else
                return `${name}_`
        }
        return name
    }

    private getVariable(v: GirVariable, optional: boolean = false, 
                        allowQuotes: boolean = false): [string[], string|null] {
        if (!v.$.name)
            return [[], null]
        if (!v || !v.$ || !this.girBool(v.$.introspectable, true) ||
            this.girBool(v.$.private))
            return [[], null] 

        let name = this.fixVariableName(v.$.name, allowQuotes)
        let typeName = this.typeLookup(v)
        let nameSuffix = optional ? "?" : ""

        return [[`${name}${nameSuffix}:${typeName}`], name]
    }

    private getProperty(v: GirVariable, construct: boolean = false): [string[], string|null, string|null] {
        if (this.girBool(v.$["construct-only"]) && !construct)
            return [[], null, null]
        if (!this.girBool(v.$.writable) && construct)
            return [[], null, null]
        if (this.girBool(v.$.private))
            return [[], null, null]

        let propPrefix = this.girBool(v.$.writable) ? '' : 'readonly '
        let [propDesc,propName] = this.getVariable(v, construct, true)

        if (!propName)
            return [[], null, null]

        return [[`    ${propPrefix}${propDesc}`], propName, v.$.name || null]
    }

    exportEnumeration(e: GirEnumeration) {
        let def: string[] = []

        if (!e || !e.$ || !this.girBool(e.$.introspectable, true))
            return []

        def.push(`export enum ${e.$.name} {`)
        if (e.member) {
            for (let member of e.member) {
                let name = member.$.name.toUpperCase()
                if (/\d/.test(name[0]))
                    def.push(`    /* ${name} (invalid, starts with a number) */`)
                else
                    def.push(`    ${name},`)
            }
        }
        def.push("}")
        return def
    }

    exportConstant(e: GirVariable) {
        let [varDesc, varName] = this.getVariable(e)
        if (varName)
            return [`export const ${varDesc}`]
        return []
    }

    private getFunction(e: GirFunction, prefix: string, funcNamePrefix: string | null = null,
                        targetMod?: GirModule): [string[], string | null] {
        if (!e || !e.$ || !this.girBool(e.$.introspectable, true) || e.$["shadowed-by"])
            return [[], null]

        let patch = e._fullSymName ? this.patch[e._fullSymName] : []
        let name = e.$.name
        let [retType, outArrayLengthIndex] = this.getReturnType(e, targetMod)
        let [params, outParams] = this.getParameters(e.parameters, outArrayLengthIndex, targetMod)

        if (e.$["shadows"]) {
            name = e.$["shadows"]
        }

        if (funcNamePrefix)
            name = funcNamePrefix + name

        if (e._fullSymName == 'Gtk.Container.child_notify') {
            debugger;
        }

        if (patch && patch.length === 1)
            return [patch, null]    
        
        let reservedWords = {
            'false': 1, 'true': 1, 'break': 1
        }

        if (reservedWords[name])
            return [[`/* Function '${name}' is a reserved word */`], null]

        if (patch && patch.length === 2)
            return [[`${prefix}${funcNamePrefix}${patch[patch.length - 1]}`], name]

        let retTypeIsVoid = retType == 'void'
        if (outParams.length + (retTypeIsVoid ? 0 : 1) > 1) {
            if (!retTypeIsVoid) {
                outParams.unshift(`/* returnType */ ${retType}`)
            }
            let retDesc = outParams.join(', ')
            retType = `[ ${retDesc} ]`
        } else if (outParams.length == 1 && retTypeIsVoid) {
            retType = outParams[0]
        }

        return [[`${prefix}${name}(${params}): ${retType}`], name]
    }

    private getConstructorFunction(name: string, e: GirFunction, prefix: string,
                                   funcNamePrefix: string | null = null,
                                   targetMod?: GirModule): [string[], string | null] {
        let [desc, funcName] = this.getFunction(e, prefix, funcNamePrefix, targetMod)

        if (!funcName)
            return [[], null]

        let [retType] = this.getReturnType(e, targetMod)
        if (retType.split(' ')[0] != name) {
            // console.warn(`Constructor returns ${retType} should return ${name}`)

            // Force constructors to return the type of the class they are actually
            // constructing. In a lot of cases the GI data says they return a base
            // class instead; I'm not sure why.
            e["return-value"] = [
                {
                    '$': {
                        // nullable
                    },
                    'type': [ { '$': {
                                name: name
                            } } as GirType
                    ]
                } as GirVariable
            ]

            desc = this.getFunction(e, prefix, null, targetMod)[0]
        }

        return [desc, funcName]
    }

    // 1. Signal details are provided by a GirFunction
    private getSignalFunc(e: GirFunction, clsName: string)
    // 2. Signal details are provided as signal name, target class name,
    //    params (excluding arg1: emitter) and return type as strings
    private getSignalFunc(sigName: string, clsName: string, params: string,
                          retType: string)
    // 3. Gets the standard generic signal functions for a named class
    private getSignalFunc(clsName: string)
    // 4. Implementation
    private getSignalFunc(signal: string | GirFunction, clsName?: string,
                          params?: string, retType?: string) {
        if (typeof signal != "string") {
            let outArrayLengthIndex = 0;
            let outParams: string[] = [];
            [retType, outArrayLengthIndex] = this.getReturnType(signal);
            [params, outParams] = this.getParameters(signal.parameters,
                                                     outArrayLengthIndex);
            signal = `"${signal.$.name}"`;
        } else if (!clsName) {
            clsName = signal
            signal = "string"
        } else {
            signal = `"${signal}"`
        }
        let callback
        let emit
        if (params !== undefined) {
            let paramComma = params.length > 0 ? ', ' : ''
            callback = `(obj: ${clsName}${paramComma}${params}) => ${retType}`
            emit = `${paramComma}${params}`
        } else {
            callback = "Function"
            emit = ", ...args: any[]"
        }
        return [
            `    connect(sigName: ${signal}, callback: ${callback}): number`,
            `    connect_after(sigName: ${signal}, callback: ${callback}): number`,
            `    emit(sigName: ${signal}${emit}): void`
        ]
    }

    exportFunction(e: GirFunction) {
        return this.getFunction(e, "export function ")[0]
    }

    exportCallback(e: GirFunction) {
        if (!e || !e.$ || !this.girBool(e.$.introspectable, true))
            return []

        let name = e.$.name
        let [retType, outArrayLengthIndex] = this.getReturnType(e)
        let [params, outParams] = this.getParameters(e.parameters, outArrayLengthIndex)

        let def: string[] = []
        def.push(`export interface ${name} {`)
        def.push(`    (${params}): ${retType}`)
        def.push("}")
        return def
    }

    private traverseInheritanceTree(e: GirClass, callback: ((cls: GirClass) => void)) {
        const details = this.getClassDetails(e)
        if (!details)
            return;
        callback(e)
        const {name, qualifiedName, parentName, qualifiedParentName} = details
        if (parentName && qualifiedParentName) {
            let parentPtr = this.symTable[qualifiedParentName]
            if (!parentPtr && parentName == "Object") {
                parentPtr = this.symTable["GObject.Object"]
            }
            if (parentPtr)
                this.traverseInheritanceTree(parentPtr, callback)
        }
    }

    private forEachInterface(e: GirClass, callback: ((cls: GirClass) => void),
                            recurseObjects = false, dups = {}) {
        const mod: GirModule = e._module ? e._module : this
        if (e._fullSymName)
            dups[e._fullSymName] = true
        for (const { $ } of e.implements || []) {
            let name = $.name as string
            if (name.indexOf(".") < 0) {
                name = mod.name + "." + name
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
            if (!parentName)
                return
            if (parentName.indexOf(".") < 0) {
                parentName = mod.name + "." + parentName
            }
            if (dups.hasOwnProperty(parentName)) return
            let parentPtr = this.symTable[parentName]
            if (parentPtr && (parentPtr.prerequisite || recurseObjects)) {
                // iface's prerequsite is also an interface, or it's
                // a class and we also want to recurse classes
                callback(parentPtr)
                this.forEachInterface(parentPtr, callback, recurseObjects, dups)
            }
        }
    }

    private forEachSuperAndInterface(e: GirClass,
                                     callback: ((cls: GirClass) => void)) {
        this.traverseInheritanceTree(e, callback)
        this.forEachInterface(e, callback)
    }

    private forEachInterfaceAndSelf(e: GirClass,
                                    callback: ((cls: GirClass) => void)) {
        callback(e)
        this.forEachInterface(e, callback)
    }

    private isDerivedFromGObject(e: GirClass): boolean {
        let ret = false
        this.traverseInheritanceTree(e, (cls) => {
            if (cls._fullSymName == "GObject.Object") {
                ret = true
            }
        })
        return ret
    }

    private checkName(desc: string[], name: string | null, localNames: any):
            [string[], boolean] {
        if (!desc || desc.length == 0)
            return [[], false]

        if (!name) {
            // console.error(`No name for ${desc}`)
            return [[], false]
        }

        if (localNames[name]) {
            // console.warn(`Name ${name} already defined (${desc})`)
            return [[], false]
        }

        localNames[name] = 1
        return [desc, true]
    }

    private processProperties(cls: GirClass, localNames: any): string[] {
        let def: string[] = []
        if (cls.property) {
            let prefix = "GObject."
            if (this.name == "GObject") prefix = ""
            def.push(`    // Properties of ${cls._fullSymName}`)
            for (let p of cls.property) {
                let [desc, name, origName] = this.getProperty(p, false)
                let [aDesc, added] = this.checkName(desc, name, localNames)
                def = def.concat(aDesc)
                if (added && origName) {
                    def.concat(this.getSignalFunc(`notify::${p}`, name || "",
                        `pspec: ${prefix}ParamSpec)`, "void"))
                }
            }
        }
        return def
    }

    private processFields(cls: GirClass, localNames: any): string[] {
        let def: string[] = []
        if (cls.field) {
            def.push(`    // Fields of ${cls._fullSymName}`)
            for (let f of cls.field) {
                let [desc, name] = this.getVariable(f, false, false)
                let [aDesc, added] = this.checkName(desc, name, localNames)
                if (added) {
                    def.push(`    ${aDesc[0]}`)
                }
            }
        }
        return def
    }

    private getInstanceMethods(cls: GirClass): [string[], string | null][] {
        const mod = cls._module || this
        let methods = (cls.method || []).map(f => mod.getFunction(f, "    ", null, this))
        // GObject.Object signal methods aren't introspected
        if (cls._fullSymName === "GObject.Object") {
            methods = methods.concat([
                [["    connect(sigName: string, callback: ${callback}): number"], "connect"],
                [["    connect_after(sigName: string, callback: ${callback}): number"], "connect_after"],
                [["    emit(sigName: string, ...args: any[]): void"], "emit"]
            ])
        }
        return methods
    }

    // If add is true this adds fn to ownMethodsMap if it isn't already
    // present; this allows exported classes to satisfy their implemented
    // interfaces.
    // If add is false this just adds overloads where necessary
    private checkOverload(ownMethodsMap: Map<string, string[]>,
                          allMethodsMap: Map<string, string[]>,
                          fn: [string[], string | null], add: boolean,
                          ownName: string, otherName: string) {
        const name = fn[1]
        if (!name) return
        let ownRec = ownMethodsMap.get(name)
        let anyRec = allMethodsMap.get(name)
        if (!ownRec) {
            if (anyRec) {
                ownMethodsMap[name] = anyRec
                ownRec = anyRec
            } else if (add) {
                ownMethodsMap[name] = fn[0]
                allMethodsMap[name] = fn[0]
                return
            } else {
                return
            }
        }
        if (ownRec) {
            for (const defn of ownRec) {
                if (defn === fn[0][0]) return
            }
            console.warn(`Method ${name} in ${ownName} clashes with one inherited from ${otherName}`)
            ownRec.unshift(...fn[0])
            if (ownRec.length === 2)
                ownRec.push(`    ${name}<T, V>(arg?: T): V`)
        }
        return
    }

    private processInstanceMethods(cls: GirClass, forClass: boolean): string[] {
        const ownMethodsArr = this.getInstanceMethods(cls)
        const ownMethodsMap = new Map<string, string[]>()
        const allMethodsMap = new Map<string, string[]>()
        for (const m of ownMethodsArr) {
            if (m[1]) {
                ownMethodsMap[m[1]] = m[0]
                allMethodsMap[m[1]] = m[0]
            }
        }
        // Check for clashes in superclasses
        this.traverseInheritanceTree(cls, e => {
            for (const m of this.getInstanceMethods(e)) {
                this.checkOverload(ownMethodsMap, allMethodsMap, m, false,
                    cls._fullSymName || "", e._fullSymName || "")
            }
        })
        // Check whether any methods from implemented interfaces clash and
        // simultaneously add declarations to satisfy implemented interfaces
        // if this is a class definition.
        this.forEachInterface(cls, e => {
            for (const m of this.getInstanceMethods(e)) {
                this.checkOverload(ownMethodsMap, allMethodsMap, m, forClass,
                    cls._fullSymName || "", e._fullSymName || "")
            }
        }, !forClass)
        // Export the methods
        let def: string[] = ["    // Instance methods"]
        for (const m of ownMethodsMap.values()) {
            def = def.concat(m)
        }
        return def
    }

    private processVirtualMethods(cls: GirClass, localNames: any): string[] {
        let def: string[] = []
        let vmeth = cls["virtual-method"]
        if (vmeth) {
            def.push(`    // Virtual methods of ${cls._fullSymName}`)
            for (let f of vmeth) {
                let [desc, name] = this.getFunction(f, "    ", "vfunc_")
                desc = this.checkName(desc, name, localNames)[0]
                if (desc[0]) {
                    desc[0] = desc[0].replace("(", "?(")
                }
                def = def.concat(desc)
            }
        }
        return def
    }

    private processSignals(cls: GirClass): string[] {
        let def: string[] = []
        let signals = cls["glib:signal"]
        if (signals) {
            def.push(`    // Signals of ${cls._fullSymName}`)
            for (let s of signals)
                def = def.concat(this.getSignalFunc(s, cls.$.name))
        }
        return def
    }

    // If a method has the same name as one in a superclass, but with
    // incompatible parameters or return types, we need to provide a generic
    // form. For some reason a signature of <T, V>(arg?: T): V covers all cases.
    // It's better for return type to be a generic too, because if this
    // overload is abused it results in V being "unknown", and should cause a
    // compilation error. The error will be in the wrong place, but it's better
    // than nothing.
    // See issue #12.
    private getOverloads(e: GirClass, desc: string[], funcName: string,
            getFunctions: (mod: GirModule, cls: GirClass) => [string[], string | null][],
            skipBottom = true):
            string[]
    {
        let clash = false
        this.traverseInheritanceTree(e, (cls: GirClass) => {
            if (clash) return;
            if (skipBottom) {
                skipBottom = false
                return
            }
            let mod = cls._module || this
            const funcs = getFunctions(mod, cls)
            for (const [desc2, funcName2] of funcs) {
                if (funcName === funcName2 && desc !== desc2) {
                    clash = true
                    break
                }
            }
        });
        const stat = (clash && desc.indexOf("    static") == 0) ? "static " : ""
        return clash ? [`    ${stat}${funcName}<T, V>(arg?: T): V`] : []
    }

    private getStaticConstructors(e: GirClass,
                                  filter?: (funcName: string) => boolean,
                                  targetMod?: GirModule):
            [string[], string | null][]
    {
        let funcs = e['constructor']
        if (!Array.isArray(funcs))
            return [[[], null]]
        let ctors = funcs.map(f =>
            this.getConstructorFunction(e.$.name, f, "    static ", null, targetMod))
        if (filter)
            ctors = ctors.filter(([desc, funcName]) => funcName && filter(funcName))
        return ctors
    }

    private getOtherStaticFunctions(e: GirClass, stat = true,
                                    targetMod?: GirModule): [string[], string][] {
        let fns: [string[], string][] = []
        if (e.function) {
            for (let f of e.function) {
                let [desc, funcName] = this.getFunction(f, stat ? "    static " : "    ", null, targetMod)
                if (funcName && funcName !== "new")
                    fns.push([desc, funcName])
            }
        }
        return fns
    }

    private getStaticNew(e: GirClass, targetMod?: GirModule): [string[], string | null] {
        let funcs = this.getStaticConstructors(e, fn => fn === "new", targetMod)
        return funcs.length ? funcs[0] : [[], null]
    }

    private getClassDetails(e: GirClass): ClassDetails | null {
        if (!e || !e.$)
            return null;
        let parent: GirClass | undefined = undefined
        let parentModule: GirModule | undefined = undefined
        const mod: GirModule = e._module ? e._module : this
        let name = e.$.name
        let qualifiedName
        if (name.indexOf(".") < 0) {
            qualifiedName = mod.name + "." + name
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
            if (parentName.indexOf(".") < 0) {
                qualifiedParentName = mod.name + "." + parentName
                parentMod = mod.name
            } else {
                qualifiedParentName = parentName
                const split = parentName.split('.')
                parentName = split[split.length - 1]
                parentMod = split.slice(0, split.length - 1).join('.')
            }
            localParentName = (parentMod == mod.name) ? parentName : qualifiedParentName
        }
        return {name, qualifiedName, parentName, qualifiedParentName, localParentName}
    }

    private forEachImplementedLocalName(e: GirClass, callback: (name: string) => void) {
        if (e.implements) {
            for (const i of e.implements) {
                let name = i.$.name
                if (!name) continue
                if (name.indexOf('.') >= 0) {
                    let [mod, local] = name.split('.')
                    if (mod == this.name)
                        name = local
                }
                callback(name)
            }
        }
    }

    // Generates a TS interface for a GObject class or interface. By using this
    // on classes as well as interfaces we gain compile-time checking that a
    // class implementing a GObject interface satisifies the interface's
    // class prerequisite.
    private exportInterfaceInternal(e: GirClass) {
        const details = this.getClassDetails(e)
        if (!details)
            return []
        const exts = new Set()
        if (details.localParentName)
            exts.add(details.localParentName)
        this.forEachImplementedLocalName(e, n => exts.add(n))
        let def: string[] = [`export interface ${details.name}`]
        if (exts.size) {
            def[0] += " extends " + Array.from(exts).join(", ")
        }
        def[0] += " {"

        const localNames = {}

        def = def.concat(this.processProperties(e, localNames))
        def = def.concat(this.processFields(e, localNames))
        def = def.concat(this.processInstanceMethods(e, false))
        def = def.concat(this.processVirtualMethods(e, localNames))
        def = def.concat(this.processSignals(e))

        def.push('}')

        return def
    }

    // Represents a record or GObject class as a Typescript class
    private exportClassInternal(e: GirClass) {
        if (e.$ && e.$["glib:is-gtype-struct-for"]) {
            return []   
        }
        const details = this.getClassDetails(e)
        if (!details) return []
        const {name, qualifiedName, parentName, localParentName} = details
        const isDerivedFromGObject = this.isDerivedFromGObject(e)

        let def: string[] = []

        // Properties for construction
        if (isDerivedFromGObject) {
            let ext: string = ' '
            if (parentName)
                ext = `extends ${localParentName}_ConstructProps `
            def.push(`export interface ${name}_ConstructProps ${ext}{`)
            let constructPropNames = {}
            if (e.property) {
                for (let p of e.property) {
                    let [desc, name] = this.getProperty(p, true)
                    def = def.concat(this.checkName(desc, name, constructPropNames)[0])
                }
            }
            def.push("}")
        }

        // Class definition starts here
        let parents = ""
        if (e.$.parent) {
            parents += ` extends ${localParentName}`;
        }
        if (e.implements) {
            const impl: string[] = []
            this.forEachImplementedLocalName(e, n => impl.push(n))
            parents += " implements " + impl.join(',')
        }
        def.push(`export class ${name}${parents} {`)
        let localNames = {}
        this.forEachInterfaceAndSelf(e, (cls: GirClass) => {
            def = def.concat(this.processProperties(cls, localNames))
        })
        def = def.concat(this.processFields(e, localNames))
        this.forEachInterfaceAndSelf(e, (cls: GirClass) => {
            def = def.concat(this.processInstanceMethods(cls, true))
        })
        this.forEachInterfaceAndSelf(e, (cls: GirClass) => {
            def = def.concat(this.processVirtualMethods(cls, localNames))
        })
        this.forEachInterfaceAndSelf(e, (cls: GirClass) => {
            def = def.concat(this.processSignals(cls))
        })

        // JS constructor(s)
        if (isDerivedFromGObject) {
            def.push(`    static $gtype: ${this.name == "GObject" ? "" : "GObject."}Type`)
            def.push(`    constructor (config?: ${name}_ConstructProps)`)
            def.push(`    _init (config?: ${name}_ConstructProps): void`)
        } else {
            let [desc, funcName] = this.getStaticNew(e)
            if (funcName) {
                def = def.concat(desc)
                def = def.concat(this.getOverloads(e, desc, funcName,
                        (mod, cls) => [mod.getStaticNew(e, this)]))
                const jsStyleCtor = desc[0]
                    .replace("static new", "constructor")
                    .replace(/:[^:]+$/, "")
                def = def.concat(jsStyleCtor)
            }
        }

        // Records, classes and interfaces all have a static name
        def.push("    static name: string")

        // Static methods, <constructor> and <function>
        let stc: string[] = []
        let ctors = this.getStaticConstructors(e, fn => fn !== "new")
        if (ctors) {
            for (let [desc, funcName] of ctors) {
                if (!funcName) continue
                stc = stc.concat(desc)
                stc = stc.concat(this.getOverloads(e, desc, funcName,
                    (mod, cls) => mod.getStaticConstructors(cls, fn => fn !== "new", this)))
            }
        }
        for (let [desc, funcName] of this.getOtherStaticFunctions(e)) {
            stc = stc.concat(desc)
            stc = stc.concat(this.getOverloads(e, desc, funcName,
                (mod, cls) => mod.getOtherStaticFunctions(cls, true, this)))
        }
        if (stc.length > 0) {
            def = def.concat(stc)
        }

        def.push("}")
        return def
    }

    // GInterfaces can have static methods and are also associated with a
    // concrete object used to initialise implementation classes, so provide
    // this as a TS object (not a class).
    private exportIfaceObject(e: GirClass) {
        const details = this.getClassDetails(e)
        if (!details)
            return []
        let def: string[] = [`export const ${details.name}: {`]
        def.push(`    $gtype: ${this.name == "GObject" ? "" : "GObject."}Type`)
        def.push(`    name: string`)
        for (const [desc, name] of this.getOtherStaticFunctions(e, false)) {
            def = def.concat(desc)
        }
        def.push('}')
        return def
    }

    exportAlias(e: GirAlias) {
        if (!e || !e.$ || !this.girBool(e.$.introspectable, true))
            return []

        let typeName = this.typeLookup(e)
        let name = e.$.name

        return [`type ${name} = ${typeName}`]
    }

    exportInterface(e: GirClass) {
        let def = this.exportInterfaceInternal(e)
        def = def.concat(this.exportIfaceObject(e))
        return def
    }

    exportClass(e: GirClass) {
        let def = this.exportInterfaceInternal(e)
        def = def.concat(this.exportClassInternal(e))
        return def
    }

    exportJs(outStream: NodeJS.WritableStream) {
        outStream.write(`module.exports = imports.gi.${this.name}`)
    }

    export(outStream: NodeJS.WritableStream) {
        let out: string[] = []

        out.push("/**")
        out.push(` * ${this.name}-${this.version}`)
        out.push(" */")

        out.push("")

        let deps: string[] = this.transitiveDependencies

        // Always pull in GObject, as we may need it for e.g. GObject.type
        if (this.name != 'GObject') {
            if (!lodash.find(deps, x => x == 'GObject')) {
                deps.push('GObject')
            }
        }

        out.push("import * as Gjs from './Gjs'")
        for (let d of deps) {
            let base = d.split('-')[0]
            out.push(`import * as ${base} from './${base}'`)
        }

        if (this.ns.enumeration)
            for (let e of this.ns.enumeration)
                out = out.concat(this.exportEnumeration(e))

        if (this.ns.bitfield)
            for (let e of this.ns.bitfield)
                out = out.concat(this.exportEnumeration(e))
    
        if (this.ns.constant)
            for (let e of this.ns.constant)
                out = out.concat(this.exportConstant(e))

        if (this.ns.function)
            for (let e of this.ns.function)
                out = out.concat(this.exportFunction(e))

        if (this.ns.callback)
            for (let e of this.ns.callback)
                out = out.concat(this.exportCallback(e))

        if (this.ns.interface)
            for (let e of this.ns.interface) {
                out = out.concat(this.exportInterfaceInternal(e))
                out = out.concat(this.exportIfaceObject(e))
            }

        // Extra interfaces used to help define GObject classes in js; these
        // aren't part of gi.
        if (this.name == "GObject") {
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
"export const GTypeName: symbol",
"export const requires: symbol",
"export const interfaces: symbol",
"export const properties: symbol",
"export const signals: symbol",
"export function registerClass(metaInfo: MetaInfo, klass: Function): Function",
"export function registerClass(klass: Function): Function",
"export function registerClass<T extends MetaInfo | Function>(a: T, b?: Function): Function"])
        }

        if (this.ns.class)
            for (let e of this.ns.class) {
                out = out.concat(this.exportInterfaceInternal(e))
                out = out.concat(this.exportClassInternal(e))
            }

        if (this.ns.record)
            for (let e of this.ns.record)
                out = out.concat(this.exportClass(e))

        if (this.ns.union)
            for (let e of this.ns.union)
                out = out.concat(this.exportInterface(e))

        if (this.ns.alias)
            for (let e of this.ns.alias)
                // GType is not a number in GJS
                if (this.name != "GObject" || e.$.name != "Type")
                    out = out.concat(this.exportAlias(e))

        if (this.name == "GObject")
            out = out.concat(["export interface Type {",
                "    name: string",
                "}"])

        outStream.write(out.join("\n"))
    }
}

function exportGjs(outDir: string|null, girModules: { [key: string]: any })
{
    if (!outDir)
        return

    fs.createWriteStream(`${outDir}/Gjs.d.ts`).write(
`export namespace byteArray {
    export class ByteArray {
        constructor(len: number)
        toGBytes(): any  // GLib.Bytes?
        length: number
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
`)

    fs.createWriteStream(`${outDir}/Gjs.js`).write(
`module.exports = {
    byteArray: imports.byteArray,
    Lang: imports.lang,
    Format: imports.format,
    Mainloop: imports.mainloop,
    gettext: imports.gettext
}`)

    const keys = lodash.keys(girModules).map(key => key.split("-")[0]);

    // Breaks dependent app with error TS2383 if directly in global.
    // https://github.com/Microsoft/TypeScript/issues/16430
    fs.createWriteStream(`${outDir}/print.d.ts`).write(
`declare function print(...args: any[]): void`);

    fs.createWriteStream(`${outDir}/index.js`).write("");

    fs.createWriteStream(`${outDir}/index.d.ts`).write(
`/// <reference path="print.d.ts" />

import * as Gjs from "./Gjs";
${keys.map(key => `import * as ${key} from "./${key}";`).join("\n")}

declare global {
    function printerr(...args: any[]): void
    function log(message?: string): void
    function logError(exception: any, message?: string): void
    const ARGV: string[]
    const imports: typeof Gjs & {
        [key: string]: any
        gi: {
${keys.map(key => `            ${key}: typeof ${key}`).join("\n")}
        }
        searchPath: string[]
    }
}

export { }`)
}

function exportExtra(outDir: string|null, inheritanceTable)
{
    if (!outDir)
        return

    let def: string[] = []
    def.push("import * as GObject from './GObject'")
    def.push("")
    def.push("let inheritanceTable = {")
    for (let k of lodash.keys(inheritanceTable)) {
        let arr: string = "'" + inheritanceTable[k].join("', '") + "'"
        def.push(`    '${k}': [ ${arr} ],`)
    }
    def.push("}")
    def.push("")

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

    fs.createWriteStream(`${outDir}/cast.ts`).write(def.join("\n"))
}

function finaliseInheritance(inheritanceTable) {
    for (let clsName of lodash.keys(inheritanceTable)) {
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
        .option("-g --gir-directory [directory]", "GIR directory",
            "/usr/share/gir-1.0")
        .option("-m --module [module]", 
            "GIR modules to load, e.g. 'Gio-2.0'. May be specified multiple " +
            "times", (val, lst) => { lst.push(val); return lst },
            [])
        .option("-o --outdir [dir]",
            "Directory to output to", null)
        .parse(process.argv)

    let girModules: { [key: string]: GirModule } = {}
    let girDirectory = commander.girDirectory
    let girToLoad = commander.module

    if (girToLoad.length == 0) {
        console.error("Need to specify modules via -m!")
        return
    }

    while (girToLoad.length > 0) {
        let name = girToLoad.shift()
        let fileName = `${girDirectory}/${name}.gir`
        console.log(`Parsing ${fileName}...`)
        let fileContents = fs.readFileSync(fileName, 'utf8')
        xml2js.parseString(fileContents, (err, result) => {
            if (err) {
                console.error("ERROR: " + err)
                return
            }
            let gi = new GirModule(result)

            if (!gi.name)
                return;

            girModules[`${gi.name}-${gi.version}`] = gi

            for (let dep of gi.dependencies) {
                if (!girModules[dep] && lodash.indexOf(girToLoad, dep) < 0) {                   
                    girToLoad.unshift(dep)
                }
            }
        })
    }

    //console.dir(girModules["GObject-2.0"], { depth: null })

    console.log("Files parsed, loading types...")

    let symTable: { [name: string]: any } = {}
    for (let k of lodash.values(girModules))
        k.loadTypes(symTable)

    let inheritanceTable: { [name: string]: string[] } = {}
    for (let k of lodash.values(girModules))
        k.loadInheritance(inheritanceTable)
    finaliseInheritance(inheritanceTable)
    
    //console.dir(inheritanceTable)

    // Figure out transitive module dependencies
    let modDependencyMap: { [name:string]: string[] } = {}
    
    for (let k of lodash.values(girModules)) {
        modDependencyMap[k.name || '-'] = lodash.map(k.dependencies || [], (val:string) => {
            return val.split('-')[0]
        })
    }
    
    let traverseDependencies = (name, ret) => {
        let deps = modDependencyMap[name]
        
        for (let a of deps) {
            if (ret[a]) continue
            ret[a] = 1
            traverseDependencies(a, ret)
        }
    }

    for (let k of lodash.values(girModules)) {
        let ret = {}
        traverseDependencies(k.name, ret)
        k.transitiveDependencies = lodash.keys(ret)
    }

    let patch = {
        "Atk.Object.get_description": [
            "/* return type clashes with Atk.Action.get_description */",
            "get_description(): string | null"
        ],
        "Atk.Object.get_name": [
            "/* return type clashes with Atk.Action.get_name */",
            "get_name(): string | null"
        ],
        "Atk.Object.set_description": [
            "/* return type clashes with Atk.Action.set_description */",
            "set_description(description: string): boolean | null"
        ],
        'Gtk.Container.child_notify': [
            '/* child_notify clashes with Gtk.Widget.child_notify */'
        ],
        'Gtk.MenuItem.activate': [
            '/* activate clashes with Gtk.Widget.activate */'
        ],
        'Gtk.TextView.get_window': [
            '/* get_window clashes with Gtk.Widget.get_window */'
        ],
        'WebKit.WebView.get_settings': [
            '/* get_settings clashes with Gtk.Widget.get_settings */'
        ]
    }

    console.log("Types loaded, generating .d.ts...")
    
    for (let k of lodash.keys(girModules)) {
        let outf: NodeJS.WritableStream = process.stdout
        if (commander.outdir) {
            let outdir: string = commander.outdir
            let name: string = girModules[k].name || 'unknown'
            let fileName: string = `${outdir}/${name}.d.ts`
            outf = fs.createWriteStream(fileName)
        }
        console.log(` - ${k} ...`)
        girModules[k].patch = patch
        girModules[k].export(outf)

        if (commander.outdir) {
            let outdir: string = commander.outdir
            let name: string = girModules[k].name || 'unknown'
            let fileName: string = `${outdir}/${name}.js`
            outf = fs.createWriteStream(fileName)
        }

        girModules[k].exportJs(outf)
    }

    // GJS internal stuff
    exportGjs(commander.outdir, girModules)
    exportExtra(commander.outdir, inheritanceTable)

    console.log("Done.")
}

if (require.main === module)
    main()
