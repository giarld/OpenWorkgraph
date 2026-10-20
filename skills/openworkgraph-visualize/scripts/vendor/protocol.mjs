// Generated from OpenWorkgraph 0.5.10; MIT, Copyright (c) 2026 Gxin.
// Protocol source SHA-256: 3e8876c3f631dfe7fdfe94fb21484b76b3be5691fbffc3b235dccf30613f82aa
// Rebuild using ../update-protocol.mjs; see LICENSE.txt. Do not edit.
// packages/protocol/src/visualize.ts
var VISUALIZE_PAGE_VERSION = 2;
var VISUALIZE_BRIDGE_VERSION = 1;
var VISUALIZE_SCHEMA_DIALECT = "openworkgraph.visualize-form/1";
var VISUALIZE_DEFAULT_SIZE = Object.freeze({ width: 480, height: 360 });
var VISUALIZE_GENERATION_MAX_SIZE = Object.freeze({ width: 1440, height: 1080 });
var VISUALIZE_FEATURE_ID = "openworkgraph:feature:visualize";
function isVisualizeFeatureSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some((key) => typeof key !== "string" || !["kind", "featureId", "version"].includes(key))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return descriptors.kind?.value === "builtin-feature" && descriptors.featureId?.value === VISUALIZE_FEATURE_ID && descriptors.version?.value === 1 && Object.values(descriptors).every((field) => "value" in field && field.enumerable);
}

// packages/protocol/src/node-layout.ts
var WORKGRAPH_NODE_MIN_SIZE = Object.freeze({ width: 220, height: 160 });

// packages/protocol/src/skills.ts
var SKILL_NAME_PATTERN = "[A-Za-z0-9_.:-]+";
var skillName = new RegExp("^" + SKILL_NAME_PATTERN + "$");

// packages/protocol/src/visualize-logo.ts
var VISUALIZE_LOGO_MAX_BYTES = 8192;
var VISUALIZE_LOGO_MAX_ELEMENTS = 64;
var VISUALIZE_DEFAULT_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#64748b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="10" width="44" height="44" rx="8"/><path d="M18 24h28M18 40h28"/></g><g fill="#3b82f6"><circle cx="28" cy="24" r="5"/><circle cx="38" cy="40" r="5"/></g></svg>';
var elements = /* @__PURE__ */ new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "title", "desc"]);
var attributes = /* @__PURE__ */ new Set(["xmlns", "viewBox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "fill-rule", "opacity", "fill-opacity", "stroke-opacity", "transform", "d", "x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "x1", "x2", "y1", "y2", "points"]);
function validateVisualizeLogoSvg(value) {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).length > VISUALIZE_LOGO_MAX_BYTES) return "Logo exceeds the SVG byte budget or is missing";
  const source = value.trim(), stack = [], colors = /* @__PURE__ */ new Set();
  let offset = 0, count = 0, roots = 0;
  while (offset < source.length) {
    if (source[offset] !== "<") {
      const end = source.indexOf("<", offset), text2 = source.slice(offset, end < 0 ? source.length : end);
      if (text2.includes("&") || text2.trim() && !["title", "desc"].includes(stack.at(-1) ?? "")) return "Unexpected SVG text or entity";
      offset = end < 0 ? source.length : end;
      continue;
    }
    const close = /^<\/([A-Za-z]+)\s*>/.exec(source.slice(offset));
    if (close) {
      if (stack.pop() !== close[1]) return "Mismatched SVG closing element";
      offset += close[0].length;
      continue;
    }
    const open = /^<([A-Za-z]+)(?=[\s/>])/.exec(source.slice(offset));
    if (!open || !elements.has(open[1])) return "Unsupported SVG element or XML declaration";
    const name = open[1];
    if (!stack.length) {
      if (++roots !== 1 || name !== "svg") return "SVG requires one root";
    } else if (name === "svg" || ["title", "desc"].includes(stack.at(-1))) return "Invalid SVG nesting";
    if (++count > VISUALIZE_LOGO_MAX_ELEMENTS + 1 || stack.length > 16) return "SVG element budget exceeded";
    offset += open[0].length;
    const attrs = /* @__PURE__ */ new Map();
    while (true) {
      const space = /^\s*/.exec(source.slice(offset))[0];
      offset += space.length;
      if (source.startsWith("/>", offset) || source[offset] === ">") break;
      if (!space) return "SVG attributes require whitespace";
      const attribute = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(["'])([^<>]*?)\2/.exec(source.slice(offset));
      if (!attribute) return "Malformed SVG attribute";
      const key = attribute[1], val = attribute[3];
      if (!attributes.has(key) || attrs.has(key) || val.includes("&") || val.includes(String.fromCharCode(92)) || [...val].some((c) => c.charCodeAt(0) < 32) || /url\s*\(|currentColor|javascript:|data:/i.test(val)) return "Unsupported SVG attribute value";
      if (key === "xmlns" && (name !== "svg" || val !== "http://www.w3.org/2000/svg")) return "Invalid SVG namespace";
      if (key === "viewBox" && (name !== "svg" || val.trim() !== "0 0 64 64")) return "Logo viewBox must be 0 0 64 64";
      if (key === "fill" || key === "stroke") {
        if (val !== "none" && !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(val)) return "SVG colors must be explicit hex colors";
        if (val !== "none") colors.add(val.toLowerCase());
      } else if (key === "stroke-linecap" && !["round", "butt", "square"].includes(val) || key === "stroke-linejoin" && !["round", "bevel", "miter"].includes(val) || key === "fill-rule" && !["nonzero", "evenodd"].includes(val)) return "Invalid SVG presentation attribute";
      else if (!["xmlns", "viewBox", "fill", "stroke", "stroke-linecap", "stroke-linejoin", "fill-rule"].includes(key)) {
        const pattern = key === "d" ? /^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\s-]+$/ : key === "transform" ? /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([0-9eE+.,\s-]+\)\s*)+$/ : /^[0-9eE+.,\s-]+$/;
        if (!pattern.test(val)) return "Invalid SVG geometry";
      }
      attrs.set(key, val);
      offset += attribute[0].length;
    }
    if (name === "svg" && (attrs.get("viewBox") !== "0 0 64 64" || attrs.get("xmlns") !== "http://www.w3.org/2000/svg")) return "SVG namespace and viewBox are required";
    if (source.startsWith("/>", offset)) offset += 2;
    else {
      offset++;
      stack.push(name);
    }
  }
  if (stack.length || roots !== 1 || count < 2 || colors.size > 3 || !colors.size) return "Invalid or empty SVG logo";
  return null;
}
function normalizeVisualizePageLogo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { page: value, warnings: [] };
  const descriptor = Object.getOwnPropertyDescriptor(value, "version");
  if (!descriptor || !("value" in descriptor) || ![1, 2].includes(descriptor.value)) return { page: value, warnings: [] };
  const pending = [value], visited = /* @__PURE__ */ new WeakSet();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) continue;
    if (!item || typeof item !== "object") return { page: value, warnings: [] };
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return { page: value, warnings: [] };
    if (visited.has(item)) continue;
    visited.add(item);
    for (const key of Reflect.ownKeys(item)) {
      const field = Object.getOwnPropertyDescriptor(item, key);
      if (!("value" in field)) return { page: value, warnings: [] };
      pending.push(field.value);
    }
  }
  const page = structuredClone(value);
  const issue = validateVisualizeLogoSvg(page.logoSvg);
  page.version = 2;
  if (issue) page.logoSvg = VISUALIZE_DEFAULT_LOGO_SVG;
  return { page, warnings: issue ? [issue + "; default logo used"] : [] };
}

// packages/protocol/src/visualize-validation.ts
var VisualizeValidationError = class extends Error {
  constructor(code, message, fields3 = []) {
    super(message);
    this.code = code;
    this.fields = fields3;
    this.name = "VisualizeValidationError";
  }
  code;
  fields;
};
var unsafe = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var encoder = new TextEncoder();
var own = (value, key) => Object.hasOwn(value, key);
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(code, message) {
  throw new VisualizeValidationError(code, message);
}
function checkedVisualizeJson(value, maxBytes = 1048576, maxDepth = 32) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0) fail("INVALID_REQUEST", "Invalid JSON limits");
  let bytes = 0;
  const seen = /* @__PURE__ */ new Set();
  function charge(size) {
    bytes += size;
    if (bytes > maxBytes) fail("PAYLOAD_TOO_LARGE", "JSON size limit exceeded");
  }
  function visit(item, depth) {
    if (depth > maxDepth) fail("PAYLOAD_TOO_LARGE", "JSON depth limit exceeded");
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) {
      charge(String(item).length);
      return item;
    }
    if (typeof item === "string") {
      charge(encoder.encode(JSON.stringify(item)).length);
      return item;
    }
    if (!item || typeof item !== "object") fail("INVALID_REQUEST", "Value is not JSON");
    if (seen.has(item)) fail("INVALID_REQUEST", "Cyclic JSON");
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail("INVALID_REQUEST", "Only plain JSON objects are supported");
    seen.add(item);
    charge(2);
    const result = {};
    const list = [];
    const keys = Reflect.ownKeys(item).filter((key) => !(array && key === "length"));
    if (array && (keys.length !== item.length || keys.some((key, index) => key !== String(index)))) fail("INVALID_REQUEST", "Arrays must contain only dense JSON elements");
    for (const key of keys) {
      if (typeof key !== "string" || unsafe.has(key)) fail("INVALID_REQUEST", "Unsafe JSON key");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!("value" in descriptor) || !descriptor.enumerable) fail("INVALID_REQUEST", "JSON accessors and hidden properties are not supported");
      charge(array ? 1 : encoder.encode(JSON.stringify(key)).length + 2);
      const child = visit(descriptor.value, depth + 1);
      if (array) list.push(child);
      else result[key] = child;
    }
    seen.delete(item);
    return array ? list : result;
  }
  return visit(value, 0);
}
function fields(value, allowed, code = "INVALID_REQUEST", path = "", replacements = {}) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) {
    const at = pointer(path, key);
    const replacement = own(replacements, key) ? replacements[key] : void 0;
    const suggestion = replacement ? `Replace ${key} with ${replacement}.` : `Remove ${key}.`;
    const message = `Unsupported field ${at}. Allowed fields: ${allowed.join(", ")}. ${suggestion}`;
    throw new VisualizeValidationError(code, message, [{ path: at, keyword: "additionalProperties", message }]);
  }
}
function atPath(path, work) {
  try {
    return work();
  } catch (error) {
    if (!(error instanceof VisualizeValidationError)) throw error;
    const fields3 = error.fields.length ? error.fields.map((field) => ({ ...field, path: path + field.path, message: field.message.replace(`Unsupported field ${field.path}.`, `Unsupported field ${path + field.path}.`) })) : [{ path, keyword: "validation", message: error.message }];
    const message = error.message.startsWith("Unsupported field ") ? fields3[0].message : `${path}: ${error.message}`;
    throw new VisualizeValidationError(error.code, message, fields3);
  }
}
function positive(value) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function boundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function equal(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]));
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => own(right, key) && equal(left[key], right[key]));
}
function checkSchemaTree(input, path = "") {
  if (!object(input) || typeof input.type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(input.type)) fail("SCHEMA_UNSUPPORTED", "A supported schema type is required");
  fields(input, ["type", "title", "description", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"], "SCHEMA_UNSUPPORTED", path);
  for (const key of ["title", "description"]) if (own(input, key) && (typeof input[key] !== "string" || String(input[key]).length > 4096)) fail("SCHEMA_UNSUPPORTED", `Invalid ${key}`);
  for (const key of ["properties", "required", "additionalProperties"]) if (own(input, key) && input.type !== "object") fail("SCHEMA_UNSUPPORTED", `${key} requires object type`);
  if (own(input, "properties")) {
    if (!object(input.properties)) fail("SCHEMA_UNSUPPORTED", "Invalid properties");
    for (const [key, schema2] of Object.entries(input.properties)) checkSchemaTree(schema2, pointer(path + "/properties", key));
  }
  if (own(input, "required")) {
    if (!Array.isArray(input.required) || input.required.some((key) => typeof key !== "string" || !object(input.properties) || !own(input.properties, key)) || new Set(input.required).size !== input.required.length) fail("SCHEMA_UNSUPPORTED", "Required fields must be unique declared properties");
  }
  if (own(input, "additionalProperties") && typeof input.additionalProperties !== "boolean") fail("SCHEMA_UNSUPPORTED", "Invalid additionalProperties");
  if (own(input, "items")) {
    if (input.type !== "array") fail("SCHEMA_UNSUPPORTED", "items requires array type");
    checkSchemaTree(input.items, path + "/items");
  }
  if (input.type === "array" && !own(input, "items")) fail("SCHEMA_UNSUPPORTED", "Arrays require an item schema");
  for (const [low, high, types] of [
    ["minimum", "maximum", ["number", "integer"]],
    ["minLength", "maxLength", ["string"]],
    ["minItems", "maxItems", ["array"]]
  ]) {
    for (const key of [low, high]) if (own(input, key)) {
      if (!types.includes(input.type) || typeof input[key] !== "number" || !Number.isFinite(input[key]) || low !== "minimum" && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0)) fail("SCHEMA_UNSUPPORTED", `Invalid ${key}`);
    }
    if (own(input, low) && own(input, high) && Number(input[low]) > Number(input[high])) fail("SCHEMA_UNSUPPORTED", `${low} exceeds ${high}`);
  }
  const schema = input;
  if (own(input, "enum")) {
    if (!Array.isArray(input.enum) || !input.enum.length || input.enum.length > 256) fail("SCHEMA_UNSUPPORTED", "Invalid enum");
    const withoutEnum = { ...schema };
    delete withoutEnum.enum;
    for (let index = 0; index < input.enum.length; index++) {
      const value = input.enum[index];
      if (formErrors(withoutEnum, value, true).length || input.enum.slice(0, index).some((item) => equal(item, value))) fail("SCHEMA_UNSUPPORTED", "Enum values must match the schema and be unique");
    }
  }
  return schema;
}
function validateVisualizeSchema(value) {
  const schema = checkSchemaTree(checkedVisualizeJson(value, 65536, 24));
  if (schema.type !== "object") fail("SCHEMA_UNSUPPORTED", "Form schema root must be an object");
  return schema;
}
var pointer = (base, key) => base + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1");
function formErrors(schema, value, required, path = "", errors = []) {
  if (errors.length >= 100) return errors;
  const issue = (keyword, message, at = path) => {
    if (errors.length < 100) errors.push({ path: at, keyword, message });
  };
  const match = schema.type === "null" ? value === null : schema.type === "object" ? object(value) : schema.type === "array" ? Array.isArray(value) : schema.type === "integer" ? typeof value === "number" && Number.isSafeInteger(value) : typeof value === schema.type;
  if (!match) {
    issue("type", `Expected ${schema.type}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some((item) => equal(item, value))) issue("enum", "Value is not an allowed choice");
  if (schema.type === "object" && object(value)) {
    if (required) {
      for (const key of schema.required ?? []) if (!own(value, key)) issue("required", "Required field is missing", pointer(path, key));
    }
    for (const [key, child] of Object.entries(value)) {
      const field = schema.properties && own(schema.properties, key) ? schema.properties[key] : void 0;
      if (field) formErrors(field, child, required, pointer(path, key), errors);
      else if (schema.additionalProperties === false) issue("additionalProperties", "Unknown field", pointer(path, key));
    }
  } else if (Array.isArray(value)) {
    if (schema.minItems !== void 0 && value.length < schema.minItems) issue("minItems", "Too few items");
    if (schema.maxItems !== void 0 && value.length > schema.maxItems) issue("maxItems", "Too many items");
    value.forEach((child, index) => {
      if (schema.items) formErrors(schema.items, child, required, pointer(path, String(index)), errors);
    });
  } else if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== void 0 && length < schema.minLength) issue("minLength", "String is too short");
    if (schema.maxLength !== void 0 && length > schema.maxLength) issue("maxLength", "String is too long");
  } else if (typeof value === "number") {
    if (schema.minimum !== void 0 && value < schema.minimum) issue("minimum", "Value is below minimum");
    if (schema.maximum !== void 0 && value > schema.maximum) issue("maximum", "Value exceeds maximum");
  }
  return errors;
}
function validateVisualizeForm(schema, value, mode = "save") {
  if (mode !== "save" && mode !== "execute") fail("INVALID_REQUEST", "Invalid form validation mode");
  const validatedSchema = validateVisualizeSchema(schema);
  const data = checkedVisualizeJson(value);
  collectVisualizeAssetReferences(data);
  const errors = formErrors(validatedSchema, data, mode === "execute");
  if (errors.length) throw new VisualizeValidationError(errors.every((error) => error.keyword === "required") ? "FORM_REQUIRED" : "FORM_INVALID", "Form validation failed", errors);
  return data;
}
function validateVisualizeSize(value, mode, hostMaximum) {
  const size = checkedVisualizeJson(value, 256, 2);
  if (!object(size)) fail("INVALID_REQUEST", "Invalid layout");
  fields(size, ["width", "height"]);
  if (mode !== "generation" && mode !== "manual" && mode !== "snapshot") fail("INVALID_REQUEST", "Invalid layout mode");
  const max = mode === "generation" ? VISUALIZE_GENERATION_MAX_SIZE : hostMaximum;
  if (!max || ![max.width, max.height].every((number) => Number.isFinite(number) && number > 0)) fail("INVALID_REQUEST", "Host maximum must come from ordinary-node rules");
  for (const key of ["width", "height"]) {
    const axis = size[key];
    if (typeof axis !== "number" || !Number.isFinite(axis) || axis <= 0) fail("INVALID_REQUEST", `Invalid layout ${key}`);
    if (mode === "manual" && axis < WORKGRAPH_NODE_MIN_SIZE[key] || axis > max[key]) fail("INVALID_REQUEST", `Invalid layout ${key}`);
  }
  return size;
}
function validateVisualizePagePackage(value) {
  let page;
  try {
    page = checkedVisualizeJson(value, 4194304);
  } catch (error) {
    if (error instanceof VisualizeValidationError && error.code === "PAYLOAD_TOO_LARGE") fail("PAYLOAD_TOO_LARGE", "\u9875\u9762\u5305\u8D85\u8FC7 4 MiB \u6216\u7ED3\u6784\u6DF1\u5EA6\u4E0A\u9650\uFF1B\u56FE\u7247\u3001\u89C6\u9891\u7B49\u8D44\u4EA7\u8BF7\u4F7F\u7528\u8D44\u6E90\u5F15\u7528\u6216\u9879\u76EE\u76F8\u5BF9\u8DEF\u5F84\u3002");
    throw error;
  }
  if (!object(page)) fail("INVALID_REQUEST", "Invalid visualize page package");
  fields(page, ["format", "version", "bridgeVersion", "html", "dependencies", "form", "initialForm", "initialState", "layout", ...page.version === 2 ? ["logoSvg", "inputNames"] : []]);
  if (page.format !== "openworkgraph.visualize-page") fail("INVALID_REQUEST", "Invalid page format");
  if (page.version !== 1 && page.version !== VISUALIZE_PAGE_VERSION || page.bridgeVersion !== VISUALIZE_BRIDGE_VERSION) fail("SCHEMA_UNSUPPORTED", "Unsupported page or bridge version");
  if (page.version === 2) {
    const logoError = validateVisualizeLogoSvg(page.logoSvg);
    if (logoError) fail("INVALID_REQUEST", logoError);
    if (own(page, "inputNames") && (!Array.isArray(page.inputNames) || page.inputNames.length > 64 || page.inputNames.some((name) => !boundedString(name, 128) || !name.trim()) || new Set(page.inputNames).size !== page.inputNames.length)) fail("INVALID_REQUEST", "Invalid input name hints");
  }
  if (!boundedString(page.html, 2097152) || !page.html.trim()) fail("INVALID_REQUEST", "Nonempty bounded HTML is required");
  if (!object(page.form)) fail("SCHEMA_UNSUPPORTED", "Form declaration is required");
  fields(page.form, ["dialect", "version", "schema"], "SCHEMA_UNSUPPORTED", "/form");
  if (page.form.dialect !== VISUALIZE_SCHEMA_DIALECT || !positive(page.form.version)) fail("SCHEMA_UNSUPPORTED", "Unsupported form declaration");
  const schema = page.form.schema;
  atPath("/form/schema", () => validateVisualizeSchema(schema));
  atPath("/initialForm", () => validateVisualizeForm(schema, page.initialForm, "save"));
  if (!own(page, "initialState")) fail("INVALID_REQUEST", "Initial state is required");
  checkedVisualizeJson(page.initialState);
  if (own(page, "layout")) atPath("/layout", () => validateVisualizeSize(page.layout, "generation"));
  if (!Array.isArray(page.dependencies) || page.dependencies.length > 64) fail("INVALID_REQUEST", "Invalid dependencies");
  const ids = /* @__PURE__ */ new Set();
  for (const [index, dependency] of page.dependencies.entries()) {
    const path = `/dependencies/${index}`;
    if (!object(dependency) || !boundedString(dependency.id, 128) || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(dependency.id) || ids.has(dependency.id) || typeof dependency.media !== "string" || !["script", "style", "image", "video"].includes(dependency.media)) fail("INVALID_REQUEST", "Invalid dependency identity or media");
    ids.add(dependency.id);
    if (dependency.kind === "cdn") {
      fields(dependency, ["kind", "id", "media", "url", "version", "integrity"], "INVALID_REQUEST", path, { resourceVersion: "version" });
      if (!boundedString(dependency.url, 4096) || /[\\\u0000- \u007f]/.test(dependency.url) || !boundedString(dependency.version, 128) || !dependency.version.trim()) fail("INVALID_REQUEST", "CDN URL and version are required");
      let url;
      try {
        url = new URL(dependency.url);
      } catch {
        fail("INVALID_REQUEST", "Invalid CDN URL");
      }
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) fail("INVALID_REQUEST", "CDN dependencies require absolute HTTPS URLs without credentials or fragments");
      if (own(dependency, "integrity") && (typeof dependency.integrity !== "string" || !/^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(dependency.integrity))) fail("INVALID_REQUEST", "Invalid dependency integrity");
    } else if (dependency.kind === "resource") {
      fields(dependency, ["kind", "id", "media", "resourceId", "resourceVersion"], "INVALID_REQUEST", path, { version: "resourceVersion" });
      if (!boundedString(dependency.resourceId, 256) || !dependency.resourceId.trim()) atPath(path + "/resourceId", () => fail("INVALID_REQUEST", "Use the resourceId supplied by the input snapshot."));
      if (!positive(dependency.resourceVersion)) atPath(path + "/resourceVersion", () => fail("INVALID_REQUEST", "resourceVersion must be a positive integer copied from the input resource version."));
    } else if (dependency.kind === "project-file") {
      fields(dependency, ["kind", "id", "media", "relativePath", "mode"], "INVALID_REQUEST", path);
      if (!["image", "video"].includes(dependency.media) || dependency.mode !== "live" || !isVisualizeProjectPath(dependency.relativePath)) fail("INVALID_REQUEST", "Invalid project file dependency");
    } else fail("INVALID_REQUEST", "Unsupported dependency kind");
  }
  return page;
}
function validateVisualizeNodeContent(value) {
  const content = checkedVisualizeJson(value, 2097152);
  if (!object(content) || typeof content.prompt !== "string" || !Array.isArray(content.inputBindings)) fail("INVALID_REQUEST", "Invalid visualize node content");
  fields(content, ["title", "prompt", "modelOverride", "agentModelOverride", "skillReferences", "features", "inputBindings", "page", "form", "state"]);
  if (own(content, "agentModelOverride") && content.agentModelOverride !== null) {
    const preference = content.agentModelOverride;
    if (!object(preference)) fail("INVALID_REQUEST", "Invalid Agent model preference");
    fields(preference, ["backendId", "model"]);
    if (!boundedString(preference.backendId, 128) || !preference.backendId.trim() || !object(preference.model)) fail("INVALID_REQUEST", "Invalid Agent model preference");
    fields(preference.model, ["model", "reasoningEffort"]);
    if (!boundedString(preference.model.model, 512) || !preference.model.model.trim() || !(preference.model.reasoningEffort === null || boundedString(preference.model.reasoningEffort, 128))) fail("INVALID_REQUEST", "Invalid Agent model preference");
  }
  if (own(content, "title") && (typeof content.title !== "string" || content.title.length > 1024)) fail("INVALID_REQUEST", "Invalid node title");
  if (own(content, "modelOverride")) {
    if (!object(content.modelOverride)) fail("INVALID_REQUEST", "Invalid model override");
    fields(content.modelOverride, ["model", "reasoningEffort"], "INVALID_REQUEST", "/modelOverride");
    if (!boundedString(content.modelOverride.model, 512) || !(content.modelOverride.reasoningEffort === null || typeof content.modelOverride.reasoningEffort === "string")) fail("INVALID_REQUEST", "Invalid model override");
  }
  if (own(content, "skillReferences") && !Array.isArray(content.skillReferences)) fail("INVALID_REQUEST", "Invalid skill references");
  if (own(content, "features") && (!Array.isArray(content.features) || content.features.length > 1 || content.features.some((feature) => !isVisualizeFeatureSelection(feature)))) fail("INVALID_REQUEST", "Invalid feature selection");
  if (content.inputBindings.length > 8) fail("INVALID_REQUEST", "Too many input bindings");
  const names = /* @__PURE__ */ new Set(), edges = /* @__PURE__ */ new Set();
  for (const [index, binding] of content.inputBindings.entries()) {
    if (!object(binding)) fail("INVALID_REQUEST", "Invalid input binding");
    fields(binding, ["name", "edgeId"], "INVALID_REQUEST", `/inputBindings/${index}`);
    if (!boundedString(binding.name, 128) || !binding.name.trim() || !boundedString(binding.edgeId, 128) || names.has(binding.name) || edges.has(binding.edgeId)) fail("INVALID_REQUEST", "Invalid or duplicate input binding");
    names.add(binding.name);
    edges.add(binding.edgeId);
  }
  const present = ["page", "form", "state"].filter((key) => own(content, key));
  if (!present.length) return content;
  if (present.length !== 3 || !object(content.page) || !object(content.form) || !object(content.state)) fail("INVALID_REQUEST", "Page, form and state must be saved together");
  const page = content.page, form = content.form, state = content.state;
  fields(page, ["revision", "resource", "dependencies"], "INVALID_REQUEST", "/page");
  fields(form, ["pageRevision", "schemaVersion", "version", "data", "resource"], "INVALID_REQUEST", "/form");
  fields(state, ["pageRevision", "version", "data"], "INVALID_REQUEST", "/state");
  if (!positive(page.revision) || !positive(form.schemaVersion) || !positive(form.version) || !positive(state.version) || form.pageRevision !== page.revision || state.pageRevision !== page.revision || !Array.isArray(page.dependencies) || page.dependencies.length > 64 || !object(form.data) || !own(state, "data")) fail("INVALID_REQUEST", "Invalid visualize revisions or data");
  function resource(value2, path) {
    if (!object(value2)) fail("INVALID_REQUEST", "Invalid resource reference");
    fields(value2, ["resourceId", "resourceVersion"], "INVALID_REQUEST", path, { version: "resourceVersion" });
    if (!boundedString(value2.resourceId, 256) || !value2.resourceId.trim() || !positive(value2.resourceVersion)) fail("INVALID_REQUEST", "Invalid resource reference");
  }
  resource(page.resource, "/page/resource");
  resource(form.resource, "/form/resource");
  const seen = /* @__PURE__ */ new Set();
  for (const [index, dependency] of page.dependencies.entries()) {
    resource(dependency, `/page/dependencies/${index}`);
    const reference = dependency;
    const key = String(reference.resourceId) + ":" + String(reference.resourceVersion);
    if (seen.has(key)) fail("INVALID_REQUEST", "Duplicate dependency reference");
    seen.add(key);
  }
  checkedVisualizeJson(form.data);
  checkedVisualizeJson(state.data);
  return content;
}

// packages/protocol/src/visualize-assets.ts
var VISUALIZE_ASSET_FORMAT = "openworkgraph.asset-reference";
function invalid() {
  throw new VisualizeValidationError("INVALID_REQUEST", "Invalid asset reference");
}
function isVisualizeProjectPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/^(?:[/\\]|[A-Za-z]:)/.test(value) && !/[\\\u0000-\u001f\u007f]/.test(value) && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
function validateVisualizeAssetReference(value) {
  const asset = checkedVisualizeJson(value, 8192, 2);
  if (!asset || typeof asset !== "object" || Array.isArray(asset) || asset.format !== VISUALIZE_ASSET_FORMAT || asset.version !== 1) invalid();
  const fields3 = asset.kind === "resource" ? ["format", "version", "kind", "resourceId", "resourceVersion"] : ["format", "version", "kind", "relativePath", "mode"];
  if (Object.keys(asset).length !== fields3.length || Object.keys(asset).some((key) => !fields3.includes(key))) invalid();
  if (asset.kind === "resource") {
    if (typeof asset.resourceId !== "string" || !asset.resourceId.trim() || asset.resourceId.length > 256 || !Number.isSafeInteger(asset.resourceVersion) || Number(asset.resourceVersion) < 1) invalid();
  } else if (asset.kind !== "project-file" || asset.mode !== "live" || !isVisualizeProjectPath(asset.relativePath)) invalid();
  return asset;
}
function collectVisualizeAssetReferences(value) {
  const result = /* @__PURE__ */ new Map();
  function visit(item) {
    if (!item || typeof item !== "object") return;
    if (!Array.isArray(item) && item.format === VISUALIZE_ASSET_FORMAT) {
      const asset = validateVisualizeAssetReference(item);
      result.set(JSON.stringify(asset.kind === "resource" ? [asset.kind, asset.resourceId, asset.resourceVersion] : [asset.kind, asset.relativePath]), asset);
      if (result.size > 64) throw new VisualizeValidationError("PAYLOAD_TOO_LARGE", "Too many asset references");
      return;
    }
    for (const child of Object.values(item)) visit(child);
  }
  visit(checkedVisualizeJson(value));
  return [...result.values()];
}
function visualizeAssetUrl(asset) {
  return asset.kind === "resource" ? "visualize-resource:" + encodeURIComponent(asset.resourceId) + "@" + asset.resourceVersion : "visualize-project-file:" + encodeURIComponent(asset.relativePath);
}

// packages/protocol/src/visualize-export.ts
var VISUALIZE_ASSET_MAX_BYTES = 300 * 1024 * 1024;

// packages/protocol/src/index.ts
var WORKGRAPH_UPLOAD_MAX_BYTES = 300 * 1024 * 1024;
var WORKGRAPH_TRANSFER_TOTAL_BYTES = 1024 * 1024 * 1024;
var WORKGRAPH_BUNDLE_MAX_BYTES = 1536 * 1024 * 1024;

// packages/protocol/src/graph-binary.ts
var GRAPH_METADATA_MAX_BYTES = 128 * 1024 * 1024;
var encoder2 = new TextEncoder();
function base64Bytes(value) {
  const raw = atob(value);
  const result = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
  return result;
}
function bytesBase64(value) {
  const parts = [];
  for (let i = 0; i < value.length; i += 49152)
    parts.push(btoa(String.fromCharCode(...value.subarray(i, i + 49152))));
  return parts.join("");
}
function jsonByteLength(value) {
  if (value === null || typeof value !== "object") return encoder2.encode(JSON.stringify(value)).length;
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce((sum, item) => sum + jsonByteLength(item), 0);
  const entries = Object.entries(value).filter(([, item]) => item !== void 0);
  return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, item]) => sum + encoder2.encode(JSON.stringify(key)).length + 1 + jsonByteLength(item), 0);
}

// packages/protocol/src/visualize-library.ts
var VISUALIZE_LIBRARY_FORMAT = "openworkgraph.visualize-asset";
var VISUALIZE_LIBRARY_VERSION = 1;
var VISUALIZE_LIBRARY_MIN_VERSION = 1;
var VISUALIZE_LIBRARY_COMPATIBILITY = Object.freeze({ minimumVersion: VISUALIZE_LIBRARY_MIN_VERSION, currentVersion: VISUALIZE_LIBRARY_VERSION });
function validateVisualizeAssetVersion(version, compatibility = VISUALIZE_LIBRARY_COMPATIBILITY) {
  if (!Number.isSafeInteger(compatibility.minimumVersion) || !Number.isSafeInteger(compatibility.currentVersion) || compatibility.minimumVersion < 1 || compatibility.currentVersion < compatibility.minimumVersion || !Number.isSafeInteger(version) || Number(version) < compatibility.minimumVersion || Number(version) > compatibility.currentVersion) {
    throw new VisualizeValidationError("SCHEMA_UNSUPPORTED", "The visualization file version is unsupported by this Workspace.");
  }
}
var VISUALIZE_LIBRARY_MAX_JSON_BYTES = 32 * 1024 * 1024;
var VISUALIZE_LIBRARY_MAX_DECODED_BYTES = 24 * 1024 * 1024;
var VISUALIZE_LIBRARY_MAX_RESOURCES = 256;
var encoder3 = new TextEncoder();
var visualizeLibraryResourceKey = (id, version) => JSON.stringify([id, version]);
function invalid2(message) {
  throw new VisualizeValidationError("INVALID_REQUEST", message);
}
function limit(message) {
  throw new VisualizeValidationError("PAYLOAD_TOO_LARGE", message);
}
function object2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fields2(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(value, key))) invalid2("Invalid visualize asset fields");
}
function text(value, max) {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}
function sha256VisualizeLibraryBytes(bytes) {
  const k = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298];
  const h = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 536870912));
  view.setUint32(padded.length - 4, bytes.length * 8);
  const w = new Uint32Array(64), rotate = (x, n) => x >>> n | x << 32 - n;
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = w[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3) + w[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10);
    }
    let [a, b, c, d, e, f, g, j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = j + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + (e & f ^ ~e & g) + k[i] + w[i] | 0;
      const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
      j = g;
      g = f;
      f = e;
      e = d + t1 | 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 | 0;
    }
    [a, b, c, d, e, f, g, j].forEach((value, i) => {
      h[i] = h[i] + value | 0;
    });
  }
  return h.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}
function decode(resource) {
  if (typeof resource.base64 !== "string" || resource.base64.length !== Math.ceil(resource.bytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(resource.base64)) invalid2("Invalid asset base64");
  let bytes;
  try {
    bytes = base64Bytes(resource.base64);
  } catch {
    return invalid2("Invalid asset base64");
  }
  if (bytes.length !== resource.bytes || bytesBase64(bytes) !== resource.base64) invalid2("Asset byte length or canonical base64 mismatch");
  return bytes;
}
function readJson(resource, maxBytes) {
  if (resource.mime !== "application/json") invalid2("Page and form resources must be application/json");
  if (resource.bytes > maxBytes) limit("Visualize JSON resource exceeds its budget");
  try {
    return checkedVisualizeJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(resource))), maxBytes);
  } catch (error) {
    if (error instanceof VisualizeValidationError) throw error;
    return invalid2("Invalid visualize JSON encoding");
  }
}
function equal2(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal2(a[key], b[key]));
}
function visitAssets(value, work) {
  if (!value || typeof value !== "object") return value;
  if (!Array.isArray(value) && value.format === "openworkgraph.asset-reference") return work(validateVisualizeAssetReference(value));
  return Array.isArray(value) ? value.map((child) => visitAssets(child, work)) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visitAssets(child, work)]));
}
function remapHtml(html, replacements) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => {
    const start = match.index + match[0].indexOf(">") + 1;
    return { start, end: start + match[1].length };
  });
  const escaped = [...replacements.keys()].sort((a, b) => b.length - a.length).map((marker) => Array.from(marker, (char) => "^$.*+?()[]{}|".includes(char) || char.charCodeAt(0) === 92 ? String.fromCharCode(92) + char : char).join(""));
  const declared = escaped.length ? "(?:" + escaped.join("|") + ")(?![A-Za-z0-9_.!~*()%+@-])|" : "";
  return html.replace(
    new RegExp(declared + "visualize-(?:resource|project-file):", "g"),
    (marker, offset) => {
      const replacement = replacements.get(marker);
      if (replacement !== void 0) return replacement;
      if (scripts.some((script) => offset >= script.start && offset + marker.length < script.end)) {
        const quote = html[offset - 1], tail = html.slice(offset + marker.length);
        if ((quote === '"' || quote === "'") && tail.startsWith(quote) && /^\s*\+/.test(tail.slice(1)) || quote === "`" && tail.startsWith("${")) return marker;
      }
      return invalid2("Undeclared visualize HTML resource marker");
    }
  );
}
function parseVisualizeAssetPackage(value, compatibility = VISUALIZE_LIBRARY_COMPATIBILITY) {
  if (typeof value === "string") {
    if (encoder3.encode(value).length > VISUALIZE_LIBRARY_MAX_JSON_BYTES) limit("Visualize asset JSON exceeds 32 MiB");
    try {
      value = JSON.parse(value);
    } catch {
      invalid2("Invalid visualize asset JSON");
    }
  }
  const clean = checkedVisualizeJson(value, VISUALIZE_LIBRARY_MAX_JSON_BYTES + 4096, 40);
  if (jsonByteLength(clean) > VISUALIZE_LIBRARY_MAX_JSON_BYTES) limit("Visualize asset JSON exceeds 32 MiB");
  if (!object2(clean)) invalid2("Invalid visualize asset");
  fields2(clean, ["format", "version", "title", "node", "inputNames", "resources"]);
  if (clean.format !== VISUALIZE_LIBRARY_FORMAT) invalid2("Invalid visualize asset format");
  validateVisualizeAssetVersion(clean.version, compatibility);
  if (!text(clean.title, 1024) || !object2(clean.node)) invalid2("Invalid visualize asset title or node");
  fields2(clean.node, ["title", "width", "height", "content"]);
  if (!text(clean.node.title, 1024)) invalid2("Invalid visualize node title");
  validateVisualizeSize({ width: clean.node.width, height: clean.node.height }, "snapshot", { width: 1e9, height: 1e9 });
  if (!Array.isArray(clean.inputNames) || clean.inputNames.length > 64 || clean.inputNames.some((name) => !text(name, 128)) || new Set(clean.inputNames).size !== clean.inputNames.length) invalid2("Invalid visualize input names");
  const content = validateVisualizeNodeContent(clean.node.content);
  if (["modelOverride", "agentModelOverride", "skillReferences", "features"].some((key) => Object.hasOwn(content, key)) || content.inputBindings.length) invalid2("Asset cannot carry model, skill, feature or input bindings");
  if (!content.page || !content.form || !content.state) invalid2("Asset requires page, form and state");
  if ([content.page.revision, content.form.pageRevision, content.form.version, content.state.pageRevision, content.state.version].some((version) => version !== 1)) invalid2("Asset snapshot revisions must be 1");
  if (!Array.isArray(clean.resources)) invalid2("Invalid asset resources");
  if (clean.resources.length > VISUALIZE_LIBRARY_MAX_RESOURCES) limit("Too many visualize asset resources");
  const resources = clean.resources, entries = /* @__PURE__ */ new Map();
  let total = 0;
  for (const resource of resources) {
    if (!object2(resource)) invalid2("Invalid asset resource");
    fields2(resource, ["resourceId", "version", "name", "mime", "bytes", "sha256", "base64"]);
    if (!text(resource.resourceId, 256) || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(resource.resourceId) || resource.version !== 1 || entries.has(resource.resourceId) || !text(resource.name, 1024) || !text(resource.mime, 256) || !/^[a-f0-9]{64}$/.test(resource.sha256) || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0) invalid2("Invalid or duplicate asset resource metadata");
    total += resource.bytes;
    if (total > VISUALIZE_LIBRARY_MAX_DECODED_BYTES) limit("Visualize asset decoded bytes exceed 24 MiB");
    decode(resource);
    entries.set(resource.resourceId, resource);
  }
  const used = /* @__PURE__ */ new Set();
  const requireResource = (ref) => {
    const resource = entries.get(ref.resourceId);
    if (!resource || ref.resourceVersion !== 1) invalid2("Missing package-local visualize resource");
    used.add(ref.resourceId);
    return resource;
  };
  const page = validateVisualizePagePackage(readJson(requireResource(content.page.resource), 4194304));
  if (page.version !== 2 || page.form.version !== content.form.schemaVersion) invalid2("Asset requires page v2 and matching schema version");
  if (content.page.resource.resourceId === content.form.resource.resourceId) invalid2("Page and form must have separate identities");
  const dependencies = /* @__PURE__ */ new Set(), markers = /* @__PURE__ */ new Map();
  for (const dep of page.dependencies) {
    if (dep.kind === "project-file") invalid2("Project files must be frozen before packaging");
    if (dep.kind !== "resource") continue;
    const resource = requireResource(dep), mime = resource.mime;
    const matches = dep.media === "script" ? ["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"].includes(mime) : dep.media === "style" ? mime === "text/css" : mime.startsWith(dep.media + "/") || dep.media === "video" && mime.startsWith("audio/");
    if (!matches) invalid2("Visualize dependency MIME mismatch");
    dependencies.add(dep.resourceId);
    const marker = visualizeAssetUrl({ format: "openworkgraph.asset-reference", version: 1, kind: "resource", resourceId: dep.resourceId, resourceVersion: 1 });
    markers.set(marker, marker);
  }
  for (const data of [page.form.schema, page.initialForm, page.initialState]) visitAssets(data, (ref) => {
    if (ref.kind !== "resource") invalid2("Live project-file refs are not portable");
    requireResource(ref);
    dependencies.add(ref.resourceId);
    return ref;
  });
  remapHtml(page.html, markers);
  const declared = new Set(content.page.dependencies.map((ref) => {
    requireResource(ref);
    return ref.resourceId;
  }));
  if (declared.size !== dependencies.size || [...dependencies].some((id) => !declared.has(id))) invalid2("Page dependency closure does not match snapshot");
  for (const data of [content.form.data, content.state.data]) visitAssets(data, (ref) => {
    if (ref.kind !== "resource") invalid2("Live project-file refs are not portable");
    requireResource(ref);
    return ref;
  });
  if (page.inputNames && !equal2(page.inputNames, clean.inputNames)) invalid2("Page and package input hints disagree");
  const form = readJson(requireResource(content.form.resource), 1048576);
  validateVisualizeForm(page.form.schema, content.form.data);
  if (!equal2(form, content.form.data)) invalid2("Form resource and snapshot disagree");
  if (used.size !== entries.size) invalid2("Asset contains resources outside its closure");
  return clean;
}
async function validateVisualizeAssetPackageBytes(value) {
  const asset = parseVisualizeAssetPackage(value);
  for (const resource of asset.resources) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(decode(resource)));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== resource.sha256) invalid2("Visualize asset SHA-256 mismatch");
  }
  return asset;
}
function readVisualizeAssetPage(asset) {
  const parsed = parseVisualizeAssetPackage(asset), ref = parsed.node.content.page.resource;
  return validateVisualizePagePackage(readJson(parsed.resources.find((resource) => resource.resourceId === ref.resourceId), 4194304));
}
function jsonResource(resource, value) {
  const bytes = encoder3.encode(JSON.stringify(value));
  return { ...resource, mime: "application/json", bytes: bytes.length, sha256: sha256VisualizeLibraryBytes(bytes), base64: bytesBase64(bytes) };
}
function buildVisualizeToolTemplate(input) {
  const content = validateVisualizeNodeContent(input.node.content);
  if (!content.page || !content.form || !content.state) invalid2("A saved visualize node is required");
  const page = validateVisualizePagePackage(input.page);
  const ref = content.form.resource;
  const form = jsonResource({ resourceId: ref.resourceId, version: ref.resourceVersion, name: "visualize-form.json", mime: "application/json", bytes: 0, sha256: "", base64: "" }, page.initialForm);
  return buildVisualizeAssetPackage({
    ...input,
    page,
    node: { ...input.node, content: { ...content, form: { ...content.form, data: page.initialForm }, state: { ...content.state, data: page.initialState } } },
    resources: [...input.resources.filter((resource) => visualizeLibraryResourceKey(resource.resourceId, resource.version) !== visualizeLibraryResourceKey(ref.resourceId, ref.resourceVersion)), form]
  });
}
function buildVisualizeAssetPackage(input) {
  const node = input.node;
  if (node.type !== "visualize" || node.schemaVersion !== 1) invalid2("A visualize node is required");
  const content = validateVisualizeNodeContent(node.content);
  if (!content.page || !content.form || !content.state) invalid2("A saved visualize node is required");
  const page = validateVisualizePagePackage(normalizeVisualizePageLogo(checkedVisualizeJson(input.page, 4194304)).page);
  const sources = /* @__PURE__ */ new Map();
  for (const resource of input.resources) {
    const key = visualizeLibraryResourceKey(resource.resourceId, resource.version);
    if (sources.has(key)) invalid2("Duplicate source resource");
    sources.set(key, resource);
  }
  const mapping = /* @__PURE__ */ new Map(), selected = [];
  let decodedBytes = 0;
  const take = (ref) => {
    const key = visualizeLibraryResourceKey(ref.resourceId, ref.resourceVersion), previous = mapping.get(key);
    if (previous) return previous;
    const resource = sources.get(key);
    if (!resource) invalid2("Missing source resource for asset closure");
    if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || resource.bytes > VISUALIZE_LIBRARY_MAX_DECODED_BYTES) limit("Invalid or oversized source resource");
    decodedBytes += resource.bytes;
    if (decodedBytes > VISUALIZE_LIBRARY_MAX_DECODED_BYTES) limit("Source resource total exceeds 24 MiB");
    if (sha256VisualizeLibraryBytes(decode(resource)) !== resource.sha256) invalid2("Source SHA-256 mismatch");
    const next = { resourceId: "r" + (selected.length + 1), resourceVersion: 1 };
    mapping.set(key, next);
    selected.push({ ...resource, resourceId: next.resourceId, version: 1 });
    if (selected.length > VISUALIZE_LIBRARY_MAX_RESOURCES) limit("Too many resources");
    return next;
  };
  const originalPageRef = content.page.resource, originalFormRef = content.form.resource;
  const pageRef = take(originalPageRef), formRef = take(originalFormRef);
  if (pageRef.resourceId === formRef.resourceId) invalid2("Page and form must have separate identities");
  const sourcePage = readJson(sources.get(visualizeLibraryResourceKey(originalPageRef.resourceId, originalPageRef.resourceVersion)), 4194304);
  const sourceForm = readJson(sources.get(visualizeLibraryResourceKey(originalFormRef.resourceId, originalFormRef.resourceVersion)), 1048576);
  if (!equal2(normalizeVisualizePageLogo(sourcePage).page, page) || !equal2(sourceForm, content.form.data) || content.form.schemaVersion !== page.form.version) invalid2("Source page/form snapshot mismatch");
  const project = (relativePath) => {
    const resource = input.projectFiles && Object.hasOwn(input.projectFiles, relativePath) ? input.projectFiles[relativePath] : void 0;
    if (!resource) invalid2("Project file must be frozen before packaging: " + relativePath);
    const key = visualizeLibraryResourceKey(resource.resourceId, resource.version);
    const existing = sources.get(key);
    if (existing && !equal2(existing, resource)) invalid2("Conflicting frozen project file identity");
    sources.set(key, resource);
    return take({ resourceId: resource.resourceId, resourceVersion: resource.version });
  };
  const dependencies = /* @__PURE__ */ new Map(), replacements = /* @__PURE__ */ new Map();
  const remember = (ref) => {
    dependencies.set(ref.resourceId, ref);
    return ref;
  };
  const assetData = (value, pageDependency = true) => visitAssets(value, (ref) => {
    const next = ref.kind === "resource" ? take(ref) : project(ref.relativePath);
    return { format: "openworkgraph.asset-reference", version: 1, kind: "resource", ...pageDependency ? remember(next) : next };
  });
  page.dependencies = page.dependencies.map((dep) => {
    if (dep.kind === "cdn") return dep;
    const next = remember(dep.kind === "resource" ? take(dep) : project(dep.relativePath));
    const oldMarker = dep.kind === "resource" ? visualizeAssetUrl({ format: "openworkgraph.asset-reference", version: 1, kind: "resource", resourceId: dep.resourceId, resourceVersion: dep.resourceVersion }) : "visualize-project-file:" + encodeURIComponent(dep.relativePath);
    replacements.set(oldMarker, "visualize-resource:" + encodeURIComponent(next.resourceId) + "@1");
    return { kind: "resource", id: dep.id, media: dep.media, ...next };
  });
  page.form.schema = assetData(page.form.schema);
  page.initialForm = assetData(page.initialForm);
  page.initialState = assetData(page.initialState);
  page.html = remapHtml(page.html, replacements);
  const formData = assetData(content.form.data, false), stateData = assetData(content.state.data, false);
  const inputNames = [.../* @__PURE__ */ new Set([...page.inputNames ?? [], ...content.inputBindings.map((binding) => binding.name)])];
  page.inputNames = inputNames;
  const nextContent = {
    prompt: content.prompt,
    ...content.title === void 0 ? {} : { title: content.title },
    inputBindings: [],
    page: { revision: 1, resource: pageRef, dependencies: [...dependencies.values()] },
    form: { pageRevision: 1, schemaVersion: page.form.version, version: 1, data: formData, resource: formRef },
    state: { pageRevision: 1, version: 1, data: stateData }
  };
  const title = content.title?.trim() || "Interactive visualization";
  const resources = selected.map((resource) => resource.resourceId === pageRef.resourceId ? jsonResource(resource, page) : resource.resourceId === formRef.resourceId ? jsonResource(resource, formData) : resource);
  return parseVisualizeAssetPackage({ format: VISUALIZE_LIBRARY_FORMAT, version: 1, title, node: { title, width: node.width ?? 480, height: node.height ?? 360, content: nextContent }, inputNames, resources });
}
export {
  buildVisualizeAssetPackage,
  buildVisualizeToolTemplate,
  collectVisualizeAssetReferences,
  readVisualizeAssetPage,
  validateVisualizeAssetPackageBytes,
  validateVisualizePagePackage
};
