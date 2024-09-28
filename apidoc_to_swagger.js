var _ = require('lodash');
var { pathToRegexp } = require('path-to-regexp');
const GenerateSchema = require('generate-schema');

let schemas = {}

var log;

function setLogger(logger) {
    log = logger;
}

var swagger = {
    openapi: '3.0.3',
    info: {},
    paths: {}
};

function toSwagger(apidocJson, projectJson) {
    swagger.info = addInfo(projectJson);
    swagger.paths = extractPaths(apidocJson);
    // for (const key in swagger) {
    //     console.log('[%s] %o', key, swagger[key]);
    // }
    swagger.components = {
        schemas: {}
    }

    for (const schemaName in schemas) {
        swagger.components.schemas[schemaName] = schemas[schemaName]
    }

    return swagger;
}

var tagsRegex = /(<([^>]+)>)/ig;
// Removes <p> </p> tags from text
function removeTags(text) {
    return text ? text.replace(tagsRegex, "") : text;
}

function addInfo(projectJson) {  // cf. https://swagger.io/specification/#info-object
    var info = {};
    info["title"] = projectJson.title || projectJson.name;
    info["version"] = projectJson.version;
    info["description"] = projectJson.description;
    return info;
}

/**
 * Extracts paths provided in json format
 * post, patch, put request parameters are extracted in body
 * get and delete are extracted to path parameters
 * @param apidocJson
 * @returns {{}}
 */
function extractPaths(apidocJson) {  // cf. https://swagger.io/specification/#paths-object
    var apiPaths = groupByUrl(apidocJson);
    var paths = {};
    for (var i = 0; i < apiPaths.length; i++) {
        var verbs = apiPaths[i].verbs;
        var url = verbs[0].url;
        var pattern = pathToRegexp(url, null);
        var matches = pattern.exec(url);

        // Surrounds URL parameters with curly brackets -> :email with {email}
        var pathKeys = [];
        for (let j = 1; j < matches.length; j++) {
            var key = matches[j].substr(1);
            url = url.replace(matches[j], "{" + key + "}");
            pathKeys.push(key);
        }

        for (let j = 0; j < verbs.length; j++) {
            var verb = verbs[j];
            verb.type = verb.type.toLowerCase()

            var obj = paths[url] = paths[url] || {};

            _.extend(obj, generateProps(verb))
        }
    }
    return paths;
}

function mapHeaderItem(i) {
    return {
        schema: {
            type: 'string',
            default: i.defaultValue
        },
        in: 'header',
        name: i.field,
        description: removeTags(i.description),
        required: !i.optional,
        default: i.defaultValue
    }
}

function mapQueryItem(i) {
    return {
        schema: {
            type: 'string',
            default: i.defaultValue
        },
        in: 'query',
        name: i.field,
        description: removeTags(i.description),
        required: !i.optional
    }
}

function mapPathItem(i) {
    return {
        schema: {
            type: 'string',
            default: i.defaultValue
        },
        in: 'path',
        name: i.field,
        description: removeTags(i.description),
        // From the OpenAPI 3.0.3 specs:
        // > If the parameter location is "path", this property is REQUIRED and its value MUST be true.
        // See https://spec.openapis.org/oas/v3.0.0#fixed-fields-9.
        required: true
    }
}

/**
 * apiDocParams
 * @param {type} type
 * @param {boolean} optional
 * @param {string} field
 * @param {string} defaultValue
 * @param {string} description
 */

/**
 * 
 * @param {ApidocParameter[]} apiDocParams 
 * @param {*} parameter 
 */
function transferApidocParamsToSwaggerBody(apiDocParams, parameterInBody, schemaName) {
    let mountPlaces = {
        '': parameterInBody
    }

    // When the root of the response is a JSON array, all the fields in apiDoc are mounted on an object that doesn't
    // actually exist in the response. For instance, the field `body.name` might not refer to an actual field.
    // `body` might only represent the root JSON array.
    let virtualRootField = ''

    apiDocParams.forEach((i, index) => {
        if (/(<p>)*\[\w+\[\w+/.test(i.description)) return; // handle api doc error for deep nested fields

        const isFirst = index === 0
        const type = i.type.toLowerCase()
        const key = i.field
        const nestedName = createNestedName(i.field, '')
        const { objectName, propertyName } = nestedName

        if (!mountPlaces[objectName]) mountPlaces[objectName] = { type: 'object', properties: {} };
        else if (!mountPlaces[objectName]['properties']) mountPlaces[objectName]['properties'] = {};

        if (type === 'object[]' || type === 'array') {
            // If the root of the example is an array and the first field of the apiDoc is an array, then the root of the response is an array.
            if (isFirst && mountPlaces['']['type'] === 'array' && mountPlaces['']['items']['type'] == 'object') {
                virtualRootField = i.field
                // new mount point
                mountPlaces[key] = mountPlaces['']['items']
            } else {
                // if schema(parsed from example) doesn't has this constructure, init
                if (!mountPlaces[objectName]['properties'][propertyName]) {
                    mountPlaces[objectName]['properties'][propertyName] = { type: 'array', items: { type: 'object', properties: {} } }
                }

                // new mount point
                mountPlaces[key] = mountPlaces[objectName]['properties'][propertyName]['items']
            }
        } else if (type.endsWith('[]')) {
            // if schema(parsed from example) doesn't has this constructure, init
            if (!mountPlaces[objectName]['properties'][propertyName]) {
                mountPlaces[objectName]['properties'][propertyName] = {
                    items: {
                        type: type.slice(0, -2),
                        description: i.description,
                        example: i.defaultValue
                    },
                    type: 'array'
                }
            }
        } else if (type === 'object') {
            // if schema(parsed from example) doesn't has this constructure, init
            if (!mountPlaces[objectName]['properties'][propertyName] || 
                (
                    i.optional && mountPlaces[objectName]['properties'][propertyName].type === 'null'
                )
            ) {
                mountPlaces[objectName]['properties'][propertyName] = { type: 'object', properties: {} }
            }

            // new mount point
            mountPlaces[key] = mountPlaces[objectName]['properties'][propertyName]
        } else {
            mountPlaces[objectName]['properties'][propertyName] = {
                type,
                description: i.description
            }
        }

        if (!i.optional && propertyName !== virtualRootField) {
            // generate-schema forget init [required]
            if (mountPlaces[objectName]['required']) {
                mountPlaces[objectName]['required'].push(propertyName)
                mountPlaces[objectName]['required'] = _.uniq(mountPlaces[objectName]['required'])
            } else {
                mountPlaces[objectName]['required'] = [propertyName]
            }
        }
    })

    return parameterInBody
}
function generateProps(verb) {
    const pathItemObject = {}
    const parameters = generateParameters(verb)
    const responses = generateResponses(verb)
    pathItemObject[verb.type] = {
        tags: [verb.group],
        summary: removeTags(verb.name),
        // sjd description: removeTags(verb.title || '') + (verb.description ? ' - ' + removeTags(verb.description) : ''),
        description: removeTags(verb.title || '') + (verb.description ? ' ' + verb.description : ''),
        parameters,
        responses
    }

    if (verb.type === 'post' || verb.type === 'put' || verb.type === 'patch') {
        pathItemObject[verb.type].requestBody = generateRequestBody(verb, verb.body)
    }

    if (verb.deprecated !== undefined) {
        pathItemObject[verb.type].deprecated = true
    }

    return pathItemObject
}

function generateParameters(verb) {

    const parameters = []

    const header = verb && verb.header && verb.header.fields.Header || []
    parameters.push(...header.map(mapHeaderItem))

    if (verb && verb.parameter && verb.parameter.fields) {
        const _path = verb.parameter.fields.Parameter || []
        parameters.push(..._path.map(mapPathItem))
    }

    parameters.push(...(verb.query || []).map(mapQueryItem))

    return parameters
}

function generateRequestBody(verb, mixedBody) {
    const schemaName = generateRequestSchemaName(verb.name)

    if (verb.body && _.some(verb.body, b => b.type === 'File')) {
        return {
            content: {
                'application/octet-stream': {
                    schema: {
                        type: 'string',
                        format: 'binary'
                    }
                }
            }
        }
    }

    const bodyParameter = {
        content: {
            'application/json': {
                schema: {
                    $ref: '#/components/schemas/' + schemaName
                }
            }
        }
    }

    if (_.get(verb, 'parameter.examples.length') > 0) {
        bodyParameter.content['application/json'].examples = {};
        for (let i = 0; i < verb.parameter.examples.length; i++) {
            const example = verb.parameter.examples[i];
            const { code, json } = safeParseJson(example.content)
            const schema = GenerateSchema.json(example.title, json)
            delete schema.$schema;

            schema.title = schemaName
            schemas[schemaName] = schema

            bodyParameter.description = example.title
            bodyParameter.content['application/json'].examples[i.toString()] = {
                summary: example.title,
                value: example.content
            }
        }
    } else {
        schemas[schemaName] = {
            title: schemaName,
            type: 'object',
            properties: {}
        }
    }

    if (mixedBody)
        transferApidocParamsToSwaggerBody(mixedBody, schemas[schemaName], schemaName)

    return bodyParameter
}

function generateResponseSchemaName(prefix, code) {
    if (!_.isUndefined(code) && !_.isNumber(code)) {
        throw new Error(`'generateResponseSchemaName' expected 'code' to be a number or undefined. Got: ${typeof code}`)
    }

    if (code === 200)
        return prefix + 'Response'
    else
        return prefix + code + 'Response'
}

function generateRequestSchemaName(prefix) {
    return prefix + 'Request'
}

function generateResponses(verb) {
    const success = verb.success
    const error = verb.error
    const responses = {}
    if (success && success.examples) {
        for (const example of success.examples) {
            generateResponse(example, responses, verb.name);
        }
    }
    if (error && error.examples) {
        for (const example of error.examples) {
            generateResponse(example, responses, verb.name);
        }
    }

    let code2xx = parseInt(Object.keys(responses).filter((r => (c = parseInt(r), 200 <= c && c < 300)))[0])
    if (!code2xx) {
        responses["default"] = {
            content: {
                'application/json': {
                    schema: {
                        properties: {},
                        type: 'object'
                    }
                }
            },
            description: ""
        }
    }

    mountResponseSpecSchema(verb, responses, code2xx, verb.name)

    return responses
}

function generateResponse(example, responses, schemaPrefix) {
    const { code, json } = safeParseJson(example.content);
    const schema = GenerateSchema.json(example.title, json);
    delete schema.$schema;

    const schemaName = generateResponseSchemaName(schemaPrefix, code)

    schema.title = schemaName
    schemas[schemaName] = schema

    responses[code] = {
        content: {
            'application/json': {
                example: JSON.stringify(json),
                schema: {
                    $ref: '#/components/schemas/' + schemaName
                }
            }
        },
        description: example.title
    };
}

function mountResponseSpecSchema(verb, responses, code2XX, schemaPrefix) {
    // if (verb.success && verb.success['fields'] && verb.success['fields']['Success 200']) {
    if (_.get(verb, 'success.fields.Success ' + code2XX)) {
        const schemaName = generateResponseSchemaName(schemaPrefix, code2XX)
        const apidocParams = verb.success['fields']['Success ' + code2XX]
        transferApidocParamsToSwaggerBody(apidocParams, schemas[schemaName], schemaName)
    }
}

function safeParseJson(content) {
    // such as  'HTTP/1.1 200 OK\n' +  '{\n' + ...

    let startingIndex = 0;
    for (let i = 0; i < content.length; i++) {
        const character = content[i];
        if (character === '{' || character === '[' || character === '"') {
            startingIndex = i;
            break;
        }
    }

    const mayCodeString = content.slice(0, startingIndex)
    const mayContentString = content.slice(startingIndex)

    const mayCodeSplit = mayCodeString.trim().split(' ')
    let code = 200;
    if (mayCodeSplit.length > 1 && mayCodeSplit[0].toLowerCase().startsWith("http")) {
        let c = parseInt(mayCodeSplit[1]);
        if (!isNaN(c)) code = c;
    }

    let json = {}
    try {
        json = JSON.parse(mayContentString)
    } catch (error) {
        console.debug('JSON parse error', content)
    }

    return {
        code,
        json
    }
}

function createNestedName(field, defaultObjectName) {
    let propertyName = field;
    let objectName;
    if (field.includes('.')) {
        const fieldRegex = /\.(\w+)$/;
        propertyName = field.match(fieldRegex)[1];
        objectName = field.replace(fieldRegex, '');
    } else if (field.includes('[')) {
        const fieldRegex = /\[(\w+)\]/;
        propertyName = field.match(fieldRegex)[1];
        objectName = field.replace(fieldRegex, '')
    }

    return {
        propertyName: propertyName,
        objectName: objectName || defaultObjectName
    }
}

function groupByUrl(apidocJson) {
    return _.chain(apidocJson)
        .groupBy("url")
        .toPairs()
        .map(function (element) {
            return _.zipObject(["url", "verbs"], element);
        })
        .value();
}

module.exports = {
    toSwagger, setLogger
};
