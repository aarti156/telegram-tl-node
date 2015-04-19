//     telegram-tl-node
//     Copyright 2014 Enrico Stara 'enrico.stara@gmail.com'
//     Released under the MIT License
//     https://github.com/enricostara/telegram-tl-node

//     TypeBuilder class
//
// This class can build dynamically a `TypeObject` concrete sub-class
// parsing `TL-Schema` for both `MTProto` and `Telegram API`

/*jshint evil:true */

// Export the class
module.exports = exports = TypeBuilder;

// Export the method
exports.buildTypes = buildTypes;
exports.inheritsTlSchema = inheritsTlSchema;
exports.requireTypeFromBuffer = requireTypeFromBuffer;
exports.requireTypeByName = requireTypeByName;

// Import dependencies
require('requirish')._(module);
var TypeObject = require('lib/type-object');
var util = require('util');
var getLogger = require('get-log');
var logger = getLogger('TypeBuilder');

// Compile a reg exp to resolve Type declaration in TL-Schema
var typeResolver = /^([!%\w]+)(<([%\w]+)>)?$/;

// The constructor requires the following params:
//      `module`: the module name where add this new Type (class or function),
//      `tlSchema`: the TypeLanguage schema that describes the Type (class or function),
//      `isTypeFunction`: true if it's a function definition
function TypeBuilder(module, tlSchema, isTypeFunction) {
    this.module = module;
    if (!this.module) {
        logger.warn(' Target \'module\' parameter is mandatory!');
        console.trace();
        return;
    }
    this.tlSchema = tlSchema;
    if (!this.tlSchema) {
        logger.warn('\'tlSchema\' parameter is mandatory!');
        return;
    }
    this._methods = [];
    this._type = isTypeFunction ? buildTypeFunction.call(this) : buildTypeConstructor.call(this);
}

// Return the built type
TypeBuilder.prototype.getType = function () {
    return this._type;
};

// This function builds a new `TypeLanguage` function parsing the `TL-Schema method`
function buildTypeFunction() {
    var methodName = this.tlSchema.method;
    // Start creating the body of the new Type function
    var body =
        '\tvar self = arguments.callee;\n' +
        '\tvar callback = options.callback;\n' +
        '\tvar context = options.context;\n' +
        '\tvar channel = options.channel;\n' +
        '\tif (!channel) {\n' +
        '\t\tvar msg = \'The \\\'channel\\\' option is missing, it\\\'s mandatory\';\n' +
        '\t\tself.logger.warn(msg);\n' +
        '\t\tif(callback) {\n' +
        '\t\t\tcallback(new TypeError(msg));\n' +
        '\t\t}\n' +
        '\t\treturn;\n' +
        '\t}\n';
    body +=
        '\tvar reqPayload = new self.Type(options);\n' +
        '\tif(context) {\n' +
        '\t\tchannel.callMethod(reqPayload, context, callback);\n' +
        '\t} else {\n' +
        '\t\tchannel.callMethod(reqPayload, callback);\n' +
        '\t}\n';
    if (logger.isDebugEnabled()) {
        logger.debug('Body for %s type function:', methodName);
        logger.debug('\n' + body);
    }
    // Create the new Type function
    var typeFunction = new Function('options', body);
    typeFunction.requireTypeFromBuffer = requireTypeFromBuffer;
    // Create the function payload class re-calling TypeBuilder constructor.
    typeFunction.Type = new TypeBuilder(this.module, this.tlSchema).getType();
    typeFunction.logger = getLogger(this.module + '.' + methodName);
    return typeFunction;
}

// This function builds a new `TypeLanguage` class (a `TypeObject` sub-class)
// parsing the `TL-Schema constructor`
function buildTypeConstructor() {
    // Start creating the body of the new Type constructor, first calling super()
    var __ret = buildIdentity.call(this);
    var typeId = __ret.typeId;
    var schemaTypeName = __ret.schemaTypeName;
    var fullTypeName = __ret.fullTypeName;
    var body =
        '\tvar opts = options ? options : {};\n' +
        '\tthis.constructor.util._extend(this, opts.props);\n' +
        '\tthis.constructor.super_.call(this, opts.buffer, opts.offset' +
        (typeId ? '' : ', true') +
        ');\n';
    // Init fields
    body += __ret.body;
    body += buildSerialize.call(this);
    body += buildDeserialize.call(this);
    // Add to body all the read/write methods
    for (var i = 0; i < this._methods.length; i++) {
        body += this._methods[i];
    }
    if (logger.isDebugEnabled()) {
        logger.debug('Body for %s type constructor:', fullTypeName);
        logger.debug('\n' + body);
    }
    var typeConstructor = createTypeConstructor(body, typeId, fullTypeName);
    return registerTypeById(registerTypeByName(schemaTypeName, typeConstructor));
}

function buildIdentity() {
    var typeName = this.tlSchema.method ?
        this.tlSchema.method : toUpperCase(this.tlSchema.predicate);
    var typeId = this.tlSchema.id;
    if (this.tlSchema.id) {
        var buffer = new Buffer(4);
        buffer.writeUInt32LE(this.tlSchema.id, 0, true);
        typeId = buffer.toString('hex');
    }
    var fullTypeName = this.module + '.' + typeName;
    var body =
        '\tthis.id = ' + (typeId ? '\'' + typeId + '\'' : typeId) + ';\n' +
        '\tthis.typeName = "' + fullTypeName + '";\n';
    return {
        typeId: typeId,
        schemaTypeName: typeName,
        fullTypeName: fullTypeName,
        body: body
    };
}

// Create the new Type sub-class of TypeObject
function createTypeConstructor(body, typeId, fullTypeName) {
    var TypeConstructor = new Function('options', body);
    TypeConstructor.id = typeId;
    TypeConstructor.typeName = fullTypeName;
    TypeConstructor.requireTypeByName = requireTypeByName;
    TypeConstructor.requireTypeFromBuffer = requireTypeFromBuffer;
    TypeConstructor.util = require('util');
    TypeConstructor.logger = getLogger(fullTypeName);
    util.inherits(TypeConstructor, TypeObject);
    return TypeConstructor;
}

// Create the `serialize()` method
function buildSerialize() {
    var body =
        '\tthis.serialize = function serialize (options) {\n' +
        '\t\tif (!this.constructor.super_.prototype.serialize.call(this, options)) {\n' +
        '\t\t\treturn false;\n' +
        '\t\t}\n';
    // Parse the `TL-Schema params`
    if (this.tlSchema.params) {
        for (var i = 0; i < this.tlSchema.params.length; i++) {
            var param = this.tlSchema.params[i];
            var type = param.type.match(typeResolver);
            var typeName = type[1];
            // Slice types with name starts with '!'
            if ('!' === typeName.charAt(0)) {
                typeName = typeName.slice(1);
            }
            var isBare = typeName.charAt(0) === '%';
            typeName = isBare ? typeName.slice(1) : typeName;
            // Manage Object type
            if (typeName.charAt(0) === typeName.charAt(0).toUpperCase()) {
                body += buildWriteObjectProperty.call(this, param.name, typeName, isBare);
            }
            // Manage primitive type
            else {
                if (typeName === 'int' && param.name === 'bytes') {
                    continue;
                }
                typeName = toUpperCase(typeName);
                body +=
                    '\t\tthis.' + buildWriteProperty.call(this, param.name, typeName) + '();\n';
            }
        }
    }
    body +=
        '\t\treturn this.retrieveBuffer();\n' +
        '\t}\n';
    return body;
}

function buildWriteObjectProperty(propertyName, typeName, isBare) {
    var body = '\t\tvar ' + propertyName + 'Bytes = this.' + propertyName +
        (('X' === typeName) ? '' : '.serialize({isBare: ' + isBare + '})') + ';\n';
    if ('Object' === typeName) {
        body += '\t\tthis.bytes = ' + propertyName + 'Bytes.length;\n';
        body += '\t\tthis.' + buildWriteProperty.call(this, 'bytes', 'Int') + '();\n';
    }
    body += '\t\tthis._writeBytes(' + propertyName + 'Bytes);\n';
    return body;
}

// Create the `write[property]()` method
function buildWriteProperty(propertyName, typeName) {
    var functionName = 'write' + toUpperCase(propertyName);
    var body =
        '\tthis.' + functionName + ' = function ' + functionName + '() {\n';
    body +=
        '\t\tif(this.constructor.logger.isDebugEnabled()) {\n' +
        '\t\t\tthis.constructor.logger.debug(\'write \\\'%s\\\' = %s\', \'' + propertyName + '\', this.' + propertyName +
        ('Bytes' === typeName ? '.toString(\'hex\')' : '') + ');\n' +
        '\t\t}\n';
    body +=
        '\t\tthis.write' + typeName + '(this.' + propertyName + ');\n';
    body +=
        '\t};\n';
    this._methods.push(body);
    return functionName;
}

// Create the `deserialize()` method
function buildDeserialize() {
    var body =
        '\tthis.deserialize = function deserialize (options) {\n' +
        '\t\tif (!this.constructor.super_.prototype.deserialize.call(this, options)) {\n' +
        '\t\t\treturn false;\n' +
        '\t\t}\n';
    // Parse the `TL-Schema params`
    if (this.tlSchema.params) {
        for (var i = 0; i < this.tlSchema.params.length; i++) {
            var param = this.tlSchema.params[i];
            var type = param.type.match(typeResolver);
            var typeName = type[1];
            var isBareCheck = checkIfTypeIsBare(typeName);
            var isBare = isBareCheck.isBare;
            typeName = isBareCheck.typeName;
            if (!type[3]) {
                // Slice types with name starts with '!'
                if ('!' === typeName.charAt(0)) {
                    typeName = typeName.slice(1);
                }
                // Manage Object type
                if (typeName.charAt(0) === typeName.charAt(0).toUpperCase()) {
                    body += buildReadObjectProperty(param.name, typeName, isBare);
                }
                // Manage primitive type
                else {
                    typeName = toUpperCase(typeName);
                    body +=
                        '\t\tthis.' + buildReadProperty.call(this, param.name, typeName) + '();\n';
                }
            }
            // Manage generic type
            else {
                var typeParam = type[3];
                body +=
                    '\t\tvar ' + typeName + ' = this.constructor.requireTypeByName(\'' + typeName + '\');\n' +
                    buildDeserializeObjectProperty(param.name, typeName, typeParam, isBare);
            }
        }
    }
    body +=
        '\t\treturn this;\n' +
        '\t}\n';
    return body;
}

function checkIfTypeIsBare(typeName) {
    var isBare = false;
    if (typeName.charAt(0) === '%') {
        isBare = true;
        typeName = isBare ? typeName.slice(1) : typeName;
    } else if ('vector' === typeName) {
        isBare = true;
        typeName = 'Vector';
    }
    return {
        isBare: isBare,
        typeName: typeName
    }
}

function buildReadObjectProperty(propertyName, typeName, isBare) {
    var body = '';
    if ('X' === typeName) {
        body += '\t\tthis.' + propertyName + ' = this._readBytes(this.bytes);\n';
    } else {
        body += ('Object' === typeName) ?
        '\t\tvar ' + typeName + ' = this.constructor.requireTypeFromBuffer(' +
        'this._buffer.slice(this.getReadOffset(), this.getReadOffset() + 4));\n' :
        '\t\tvar ' + typeName + ' = this.constructor.requireTypeByName(\'' + typeName + '\');\n';
        body += buildDeserializeObjectProperty(propertyName, typeName, null, isBare);
    }
    return body;
}

function buildDeserializeObjectProperty(propertyName, typeName, typeParam, isBare) {
    var body =
        '\t\tif (' + typeName + ') {\n' +
        '\t\t\tvar obj = new ' + typeName + '({' +
        (typeParam ? 'type: \'' + typeParam + '\', ' : '') +
        'buffer: this._buffer, offset: this.getReadOffset()}).' +
        'deserialize({isBare: ' + isBare + '});\n' +
        '\t\t\tif (obj) {\n' +
        '\t\t\t\tthis.' + propertyName + ' = obj;\n' +
        '\t\t\t\tthis._readOffset += obj.getReadOffset();\n' +
        '\t\t\t}\n' +
        '\t\t} else {\n' +
        '\t\t\tthrow new TypeError(\'Unable to retrieve the Type constructor for the type ' + typeName + ' and buffer:\' + this._buffer.toString(\'hex\'));\n' +
        '\t\t}\n';
    return body;
}

// Create the `read[property]()` method
function buildReadProperty(propertyName, typeName) {
    var functionName = 'read' + toUpperCase(propertyName);
    var body =
        '\tthis.' + functionName + ' = function ' + functionName + '() {\n';
    body +=
        '\t\tthis.' + propertyName + ' = this.read' + typeName + '();\n';
    body +=
        '\t\tif(this.constructor.logger.isDebugEnabled()) {\n' +
        '\t\t\tthis.constructor.logger.debug(\'read \\\'%s\\\' = %s, offset = %s\', \'' + propertyName + '\', this.' + propertyName +
        ('Bytes' === typeName ? '.toString(\'hex\')' : '') + ', this._readOffset);\n' +
        '\t\t}\n';
    body +=
        '\t};\n';
    this._methods.push(body);
    return functionName;
}

function toUpperCase(str) {
    return (str.charAt(0).toUpperCase() + str.slice(1));
}

// Extends the 'constructor' with the Type generated by the 'superTLSchema'
function inheritsTlSchema(constructor, superTlSchema) {
    var NewType = new TypeBuilder('abstract', superTlSchema).getType();
    util.inherits(constructor, NewType);
    constructor.s_ = NewType;
    constructor.super_ = NewType.super_;
    constructor.util = NewType.util;
    constructor.requireTypeByName = NewType.requireTypeByName;
    constructor.requireTypeFromBuffer = NewType.requireTypeFromBuffer;
    constructor.logger = NewType.logger;
}

// Types registered by id
var typeById = {};

// Register a Type constructor by id
function registerTypeById(type) {
    if (logger.isDebugEnabled()) {
        logger.debug('Register Type \'%s\' with id [%s]', type.typeName, type.id);
    }
    typeById[type.id] = type;
    return type;
}

// Retrieve a Type constructor reading the id from buffer
function requireTypeFromBuffer(buffer) {
    var typeId = buffer.slice(0, 4).toString('hex');
    var type = typeById[typeId];
    if (logger.isDebugEnabled()) {
        logger.debug('Retrieve Type \'%s\' with id [%s]', type.typeName, typeId);
    }
    return type;
}

// Types registered by name
var typeByName = {
    //'Vector': TypeVector
};

// Register a Type constructor by name
function registerTypeByName(name, type) {
    if (logger.isDebugEnabled()) {
        logger.debug('Register Type \'%s\' with name [%s]', type.typeName, name);
    }
    typeByName[name] = type;
    return type;
}

// Retrieve a Type constructor by name
function requireTypeByName(name) {
    var type = typeByName[name];
    if(name == 'Vector' && !type) {
        type = typeByName[name] =  require('lib/type-vector');
    }
    if (logger.isDebugEnabled()) {
        logger.debug('Retrieve Type \'%s\' with name [%s]', JSON.stringify(type), name);
    }
    return type;
}

// Types builder
function buildTypes(schemas, types, targetModule, isTypeFunction) {
    for (var i = 0; i < schemas.length; i++) {
        var type = schemas[i];
        // Vector is already defined by class TypeVector
        if ('vector' !== type.predicate &&
            ( !types || types.indexOf(type[isTypeFunction ? 'method' : 'type']) > -1)) {
            var typeName = isTypeFunction ? type.method : type.predicate;
            var builder = new TypeBuilder(targetModule._id, type, isTypeFunction);
            setType(typeName, targetModule, builder.getType(), isTypeFunction);
        }
    }
}
function setType(typeName, targetModule, type, isTypeFunction) {
    if (targetModule && typeName && typeName.length > 0) {
        var index = typeName.indexOf('.');
        if (index < 0) {
            typeName = isTypeFunction ? typeName : toUpperCase(typeName);
            return targetModule[typeName] = type;
        } else if (index === 0) {
            setType(typeName.slice(1), targetModule, type, isTypeFunction);
        } else if (index === (typeName.length - 1)) {
            setType(typeName.slice(0, -1), targetModule, type, isTypeFunction);
        }
        else {
            var pkg = typeName.slice(0, index);
            targetModule[pkg] = targetModule[pkg] ? targetModule[pkg] : {};
            setType(typeName.slice(index + 1), targetModule[pkg], type, isTypeFunction);
        }
    }
}